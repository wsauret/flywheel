import { afterEach, describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { readChildCompletionConversation } from "../../../../src/orchestration/session/child-completion-conversation"
import { holdChildReconciliationIndex, readChildReconciliationChanges } from "../../../../src/orchestration/session/child-reconciliation-index"
import { heldProjection } from "../../../../src/infra/projection-registry"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/child-session-reconciliation"
import { recordChildWorkflowStop } from "../../../../src/orchestration/session/child-workflow-result"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { createSessionFactWriter, prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer"
import { parseSessionRuntimeFact } from "../../../../src/orchestration/session/session-runtime-event-types"
import { extractToolContentFact } from "../../../../src/infra/tool-content-extraction"
import { TOOL_CONTENT_INLINE_MAX_BYTES } from "../../../../src/infra/tool-content"
import { buildHandoffWrittenFact } from "../../../../src/workflows/output-contract/facts"
import { readTerminalHandoff } from "../../../../src/workflows/output-contract/workflow-completion"
import { parseWorkflowRunFact } from "../../../../src/workflows/run-facts"
import { readWorkflowControl } from "../../../../src/workflows/vm/recovery-fold"
import { temporaryDirectories } from "../../../helpers/directories"
import { countStateRequests, factsRead } from "../../../helpers/state-requests"
import { addSubagentChild, addWorkflowChild, localAsyncWriter, reconcileChatLaunchedWorkflowCompletions, recordTerminalResult, replaceWorkflowState, setupWorkflowParent } from "./_child-session-reconciliation-fixtures"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { buildSubagentCompleted } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"
import { registerLiveSessionControl, registerLiveWorkflowControl } from "../../../../src/orchestration/session/live-session-control"

const temporaryDirectory = temporaryDirectories()
const stores: LocalSqliteEventStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

async function setup(status: "completed" | "paused" = "completed", suffix = "") {
  const projectRoot = temporaryDirectory("child-reconciliation-cost-")
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
  stores.push(store)
  return { ...await setupWorkflowParent(store, projectRoot, status, suffix, {}), projectRoot }
}

describe("child reconciliation work", () => {
  test.each(["chat", "nested"] as const)("unchanged %s sweeps do not reoffer actively owned completion holds", async (parentKind) => {
    const costs: number[][] = []
    for (const children of [2, 20]) {
      const { store, writer, parentSessionId, projectRoot } = await setup("paused", `-held-${children}`)
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      let offers = 0
      let callbacks = 0
      let writes = 0
      const registry = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: async () => { offers += 1; await new Promise<void>(() => {}) } })
      const unregister = registerLiveSessionControl(counter.reader, {
        sessionId: parentSessionId, state: async () => "running", deliver: async () => ({ status: "delivered", startsTurn: false }),
        ...(parentKind === "chat" ? { backgroundTasks: registry } : { member: { backgroundTasks: registry, modules: async () => undefined, compact: async () => false, interrupt: () => false, releaseForegroundBash: () => false, transferForegroundForReplacement: async () => {}, terminateBackgroundWork: () => {} } }),
        notify: async (notification) => { offers += 1; await counter.reader.aggregateSeq(`session:${parentSessionId}`); await writer.putInFlight?.(parentSessionId, "chat.queued_background_notification", notification.key ?? "notice", { conversationId: "conversation", text: notification.text }); writes += 1; return true },
      })
      const input = { parentSessionId, reader: counter.reader, writer, projectRoot, deliverNotification: async () => { callbacks += 1; return false } }
      try {
        for (let i = 0; i < children; i += 1) {
          await addSubagentChild(store, writer, projectRoot, parentSessionId, `conversation-held-${children}`, i, "completed")
          await reconcileChildSessionCompletions(input)
        }
        offers = 0
        writes = 0
        const sweeps: number[] = []
        for (let i = 0; i < 3; i += 1) {
          counter.take()
          await reconcileChildSessionCompletions(input)
          sweeps.push(counter.take().length)
        }
        expect(offers).toBe(0)
        expect(callbacks).toBe(0)
        expect(writes).toBe(0)
        costs.push(sweeps)
      } finally { unregister() }
    }
    expect(costs[1]).toEqual(costs[0])
  })
  test("control advances after workflow renames without folding prior settings history", async () => {
    for (const length of [2, 40]) {
      const { store } = await setup("paused", `-control-${length}`)
      const childSessionId = `child-control-${length}`
      const registered = store.read({ aggregateId: `workflow:${childSessionId}`, types: ["workflow.run.registered"] })[0]
      if (!registered) throw new Error("missing registration")
      const fact = parseWorkflowRunFact({ type: registered.type, version: registered.version, actor: registered.actor, payload: registered.payload })
      if (fact.type !== "workflow.run.registered") throw new Error("wrong registration")
      const rename = (i: number) => store.append({
        aggregateId: `workflow:${childSessionId}`, sessionId: childSessionId, timestamp: Date.now(),
        ...parseWorkflowRunFact({
          type: "workflow.run.settings.updated", version: 1, actor: "flywheel",
          payload: { settings: { ...fact.payload.settings, label: `Name ${i}` }, labelSource: "user" },
        }),
      })
      for (let i = 0; i < length; i += 1) rename(i)
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      await readWorkflowControl(counter.reader, childSessionId)
      counter.take()
      rename(length)
      expect((await readWorkflowControl(counter.reader, childSessionId)).aggregateSeq).toBe(store.aggregateSeq(`workflow:${childSessionId}`) + 1)
      expect(factsRead(counter.take())).toBe(1)
    }
  })

  test("stopped workflow handoff reads advance without prior output history", async () => {
    for (const count of [2, 40]) {
      const { store } = await setup("paused", `-outputs-${count}`)
      const sessionId = `child-outputs-${count}`
      const append = (i: number) => store.append({
        ...buildHandoffWrittenFact({ attemptId: `step-${i}`, agentName: `Step ${i}`, definitionId: "work", workflowDefinitionId: "workflow", content: { summary: `output ${i}` } }),
        aggregateId: `workflow:${sessionId}`, sessionId, timestamp: Date.now(),
      })
      for (let i = 0; i < count; i += 1) append(i)
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      await readTerminalHandoff(counter.reader, sessionId)
      counter.take()
      append(count)
      expect((await readTerminalHandoff(counter.reader, sessionId))?.content).toEqual({ summary: `output ${count}` })
      expect(factsRead(counter.take())).toBe(1)
    }
  })

  test("completion validation reads only newly appended parent conversation facts", async () => {
    for (const length of [2, 40]) {
      const { store, writer, parentSessionId, conversationId } = await setup("completed", `-history-${length}`)
      const tree = await tryOpenConversationTree({ store: asAsyncEventReadSurface(store), writer, sessionId: parentSessionId, conversationId })
      if (!tree) throw new Error("missing parent")
      for (let i = 0; i < length; i += 1) await tree.appendMessage({ kind: "user", content: `message ${i}` })
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      const input = { reader: counter.reader, writer }
      const first = await readChildCompletionConversation({ input }, parentSessionId, conversationId)
      first?.getStorage().dispose()
      counter.take()
      await tree.appendMessage({ kind: "user", content: "new message" })
      const next = await readChildCompletionConversation({ input }, parentSessionId, conversationId)
      expect((await next?.getState())?.leafId).toBe(await tree.getLeafId())
      next?.getStorage().dispose()
      tree.getStorage().dispose()
      // The tree's one fold both validates and serves the conversation.
      expect(factsRead(counter.take())).toBe(1)
    }
  })

  test("the first sweep and its held batches do not grow with unrelated workspace history", async () => {
    const costs: Array<{ requests: number; facts: number; held: number }> = []
    for (const unrelated of [2, 60]) {
      const { store, writer, parentSessionId, projectRoot } = await setup("completed", `-seed-${unrelated}`)
      for (let i = 0; i < unrelated; i += 1) {
        store.append({ aggregateId: `session:unrelated-${unrelated}`, sessionId: `unrelated-${unrelated}`, timestamp: Date.now(), type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: `unrelated-${i}` } })
        store.append({ aggregateId: `workflow:unrelated-${unrelated}`, sessionId: `unrelated-${unrelated}`, timestamp: Date.now(), type: "queue.mutated", version: 1, actor: "flywheel", payload: { index: i } })
      }
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      const input = { parentSessionId, reader: counter.reader, writer, projectRoot }
      await reconcileChildSessionCompletions(input)
      const first = counter.take()
      const { index } = await readChildReconciliationChanges(counter.reader, parentSessionId)
      costs.push({ requests: first.length, facts: factsRead(first), held: index.getState().facts.length + index.workflowChanges.getState().workflowIds.size })
    }
    expect(costs[1]).toEqual(costs[0])
  })

  // Version 3 is the current result shape, which the writer stores as
  // version 4 when its text moves to content rows.
  test.each([1, 3] as const)("advances past a version-%i parent result whose text is stored in content rows", async (version) => {
    const { store, writer, parentSessionId, projectRoot } = await setup("completed", `-reference-${version}`)
    const input = { parentSessionId, reader: asAsyncEventReadSurface(store), writer, projectRoot }
    await reconcileChildSessionCompletions(input)
    const large = extractToolContentFact(parseSessionRuntimeFact({
      type: "tool.result.recorded", version, actor: "flywheel",
      payload: { toolUseId: "read-tool", outcome: "ok", details: { displayContent: "x".repeat(TOOL_CONTENT_INLINE_MAX_BYTES * 2) } },
    }))
    expect(large.contentRows).toHaveLength(1)
    expect<number>(large.fact.version).toBe(version + 1)
    store.append(prepareSessionFactAppend(parentSessionId, large.fact, large.contentRows))

    await reconcileChildSessionCompletions(input)
  })

  test("a reopened parent's first sweep costs the same requests for 4 and 80 subagent children and any history", async () => {
    const costs: Array<{ first: number; changed: number; changedFacts: number }> = []
    for (const children of [4, 80]) {
      for (const history of [2, 40]) {
        const projectRoot = temporaryDirectory("child-reconciliation-reopen-")
        const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
        stores.push(store)
        const writer = localAsyncWriter(store)
        const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
        const parentSessionId = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
        const tree = await tryOpenConversationTree({ store: asAsyncEventReadSurface(store), writer, sessionId: parentSessionId, conversationId: "parent-conversation" })
        if (!tree) throw new Error("missing parent")
        for (let i = 0; i < history; i += 1) await tree.appendMessage({ kind: "user", content: `message ${i}` })
        tree.getStorage().dispose()
        const statuses = ["paused", "created", "completed", "completed"] as const
        for (let i = 0; i < children; i += 1) await addSubagentChild(store, writer, projectRoot, parentSessionId, "parent-conversation", i, statuses[i % statuses.length] ?? "completed", history)
        // The parent's earlier owner settled every finished child.
        await reconcileChildSessionCompletions({ parentSessionId, reader: asAsyncEventReadSurface(store), writer })
        // A reopen in a new process: nothing is held for this reader yet.
        const counter = countStateRequests(asAsyncEventReadSurface(store))
        const input = { parentSessionId, reader: counter.reader, writer, projectRoot }
        await reconcileChildSessionCompletions(input)
        const first = counter.take().length
        const childWriter = createSessionFactWriter({ sessionId: "child-1", writer: asAsyncEventWriter(store) })
        await childWriter.record(buildSubagentCompleted({ childRunId: "run-1", status: "completed", isError: false, content: "Reviewed.", durationMs: 1 }))
        childWriter.dispose()
        counter.take()
        expect((await reconcileChildSessionCompletions(input)).reconciledCount).toBe(1)
        const changed = counter.take()
        costs.push({ first, changed: changed.length, changedFacts: factsRead(changed) })
      }
    }
    const [base] = costs
    expect(costs).toEqual(costs.map(() => base ?? { first: 0, changed: 0, changedFacts: 0 }))
  })

  test("a held parent's index and runs outlive registry churn until its last owner releases them, and an unheld one's do not", async () => {
    const costs: Array<{ requests: number; facts: number }> = []
    // Each child adds a launching call to the parent, so the larger parent
    // also has the longer history.
    for (const children of [4, 40]) {
      const projectRoot = temporaryDirectory("child-reconciliation-held-")
      const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
      stores.push(store)
      const writer = localAsyncWriter(store)
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
      const parentSessionId = await manager.createChat({ id: "parent", conversationId: "parent-conversation", name: "Parent" })
      for (let i = 0; i < children; i += 1) await addSubagentChild(store, writer, projectRoot, parentSessionId, "parent-conversation", i, "created")
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      const input = { parentSessionId, reader: counter.reader, writer, projectRoot }
      /** Whether the parent's next sweep is a first sweep after a finished
       *  sweep and the owners of many other parents that pass through the
       *  registry's families. */
      const coldAfterChurn = async (round: number) => {
        await reconcileChildSessionCompletions(input)
        for (let i = 0; i < 80; i += 1) {
          heldProjection(counter.reader, `child-reconciliation:other-${round}-${i}`, () => ({}))
          heldProjection(counter.reader, `subagent-parent-runs:other-${round}-${i}`, () => ({}))
        }
        return (await readChildReconciliationChanges(counter.reader, parentSessionId)).first
      }
      // A sweep of a parent that no owner holds, such as recovery's, keeps
      // nothing past the registry's bound.
      expect(await coldAfterChurn(0)).toBe(true)
      const releaseActor = holdChildReconciliationIndex(counter.reader, parentSessionId)
      const releaseChild = holdChildReconciliationIndex(counter.reader, parentSessionId)
      expect(await coldAfterChurn(1)).toBe(false)
      counter.take()
      await reconcileChildSessionCompletions(input)
      const idle = counter.take()
      expect(factsRead(idle)).toBe(0)
      expect(idle.length).toBeLessThanOrEqual(5)
      // One child completes after the churn: the held runs owner folds only
      // that child's new fact, not the parent's history and every child's runs.
      const childWriter = createSessionFactWriter({ sessionId: "child-1", writer })
      await childWriter.record(buildSubagentCompleted({ childRunId: "run-1", status: "completed", isError: false, content: "Reviewed.", durationMs: 1 }))
      childWriter.dispose()
      counter.take()
      expect((await reconcileChildSessionCompletions(input)).reconciledCount).toBe(1)
      const changed = counter.take()
      costs.push({ requests: changed.length, facts: factsRead(changed) })
      // A release is idempotent, and the index stays while any owner holds it.
      // The registry builds the probe only for a runs owner that it evicted.
      const evicted = () => {
        const probe = {}
        return heldProjection(counter.reader, `subagent-parent-runs:${parentSessionId}`, () => probe) === probe
      }
      releaseActor()
      releaseActor()
      expect(await coldAfterChurn(2)).toBe(false)
      expect(evicted()).toBe(false)
      releaseChild()
      expect(await coldAfterChurn(3)).toBe(true)
      // The last release removes the runs pin, so churn evicts the owner too.
      expect(evicted()).toBe(true)
    }
    expect(costs[1]).toEqual(costs[0])
  })

  /** Sweeps the parent of a completed workflow, after `prepare`, with a
   *  reader that holds nothing yet, as a reopen in a new process does. */
  async function reopen(suffix: string, prepare: (fixture: Awaited<ReturnType<typeof setup>>, reader: AsyncEventStateReadSurface) => Promise<void>) {
    const fixture = await setup("completed", suffix)
    const { store, writer, parentSessionId } = fixture
    const counter = countStateRequests(asAsyncEventReadSurface(store))
    await prepare(fixture, counter.reader)
    counter.take()
    const result = await reconcileChildSessionCompletions({ parentSessionId, reader: counter.reader, writer })
    return { result, workflowFacts: factsRead(counter.take().filter((request) => request.aggregateId === `workflow:child${suffix}`)) }
  }

  /** The parent's earlier owner settled the call and committed the completion. */
  async function deliver({ store, writer, parentSessionId }: Awaited<ReturnType<typeof setup>>) {
    await reconcileChatLaunchedWorkflowCompletions({ parentSessionId, reader: store, writer })
  }

  test("a reopened parent reads no history of a workflow whose completion it already holds", async () => {
    const { result, workflowFacts } = await reopen("-delivered", deliver)
    expect(result).toMatchObject({ reconciledCount: 0, workflowAggregateReads: 0, durableTerminalChildSessionIds: ["child-delivered"] })
    // The run record's registration, and no fact after the result.
    expect(workflowFacts).toBe(1)
  })

  test.each([
    ["the parent holds no completion entry", "-no-entry"],
    ["the workflow runs in this process", "-live"],
    ["the workflow ran after its result", "-resumed"],
    ["a Stop settled the call", "-stopped"],
  ] as const)("a reopened parent reads the workflow's history when %s", async (_condition, suffix) => {
    const { result } = await reopen(suffix, async (fixture, reader) => {
      const { store, writer, parentSessionId, toolUseId, description } = fixture
      if (suffix === "-no-entry") {
        await recordTerminalResult(store, parentSessionId, toolUseId, "Completed.")
        return
      }
      await deliver(fixture)
      if (suffix === "-live") {
        registerLiveWorkflowControl(reader, {
          kind: "workflow", workflowId: `child${suffix}`, handBackMember: async () => undefined, memberHost: async () => undefined,
          state: async () => "between_steps", deliver: async () => ({ status: "refused", reason: "settled" }), notify: async () => false,
        })
      }
      if (suffix === "-resumed") await replaceWorkflowState(store, `child${suffix}`, description, "completed")
      if (suffix === "-stopped") {
        await recordChildWorkflowStop({
          parentSessionId, reader: asAsyncEventReadSurface(store), writer, childSessionId: `child${suffix}`, toolUseId,
          workflowDefinitionId: "workflow", stoppedBy: "person", correctPriorResult: true,
        })
      }
    })
    expect(result.workflowAggregateReads).toBeGreaterThan(0)
  })

  test("reconciliation advances only changed children regardless of siblings or retained history", async () => {
    const costs: Array<{ requests: number; facts: number }> = []
    for (const siblings of [2, 20]) {
      const { store, writer, parentSessionId, projectRoot } = await setup("completed", `-cost-${siblings}`)
      for (let i = 0; i < siblings; i += 1) {
        await addWorkflowChild(store, projectRoot, parentSessionId, `cost-${siblings}-${i}`, `cost-tool-${siblings}-${i}`, "Work")
      }
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      const input = { parentSessionId, reader: counter.reader, writer, projectRoot }
      await reconcileChildSessionCompletions(input)
      await reconcileChildSessionCompletions(input)
      counter.take()
      await reconcileChildSessionCompletions(input)
      const idle = counter.take()
      expect(factsRead(idle)).toBe(0)
      expect(idle.length).toBeLessThanOrEqual(5)
      await recordChildWorkflowStop({
        ...input, childSessionId: `cost-${siblings}-0`, toolUseId: `cost-tool-${siblings}-0`,
        workflowDefinitionId: "workflow", stoppedBy: "person", correctPriorResult: true,
      })
      counter.take()
      await reconcileChildSessionCompletions(input)
      const changed = counter.take()
      costs.push({ requests: changed.length, facts: factsRead(changed) })
    }
    expect(costs[1]).toEqual(costs[0])
  })
})
