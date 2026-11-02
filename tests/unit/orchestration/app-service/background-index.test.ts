import { afterEach, describe, expect, test } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import type { BackgroundCommandRecord } from "../../../../src/infra/runtime-fact-types"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { createBackgroundWorkRegistry, type BackgroundWorkResult } from "../../../../src/orchestration/agent-runtime/background-work"
import { createBackgroundIndex } from "../../../../src/orchestration/app-service/background-index"
import { recordSubagentCompleted, recordSubagentCreated } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import type { ReplayedSession } from "../../../../src/orchestration/session/schemas"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { backgroundIndexEntries } from "../../../../src/protocol/client/background-index"
import type { ActiveBackgroundCommandView, ReplyWaitView } from "../../../../src/protocol/status-protocol-types"
import { temporaryDirectories } from "../../../helpers/directories"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { workflowRunWriter } from "../../../../src/orchestration/module-catalog"
import { publishTestWorkflow } from "../session/_session-manager-fixtures"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold"
import { replayWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership"
import { validateWorkflowBootstrap } from "../../../../src/workflows/vm/bootstrap-validation"
import { loadQueueFromEvents } from "../../../../src/workflows/view/view-projection"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten"
import { testResolvedAgent, testResolvedAgents, testSkill } from "../../../helpers/skill-fixtures"

const temporaryDirectory = temporaryDirectories()

interface SessionRecord {
  readonly kind: "chat" | "subagent"
  readonly createdAtMs: number
  readonly label: string
  readonly lifecycleState?: "active" | "inactive"
  readonly parent?: { readonly sessionId: string; readonly toolUseId: string }
  readonly children?: readonly string[]
}

/** A project store and the sessions its index reads. The session records
 *  carry only the fields the index reads; the facts are real. */
function project() {
  const stores: LocalSqliteEventStore[] = []
  const dir = temporaryDirectory("fw-background-index-")
  const open = () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    stores.push(store)
    return store
  }
  const store = open()
  const manager = createSessionManager({ projectRoot: dir, executionCwd: dir, store })
  const sessions = new Map<string, SessionRecord>()
  const live = new Map<string, readonly ActiveBackgroundCommandView[]>()
  const waits = new Map<string, readonly ReplyWaitView[]>()
  const readSession = async (sessionId: string): Promise<ReplayedSession | undefined> => {
    const record = sessions.get(sessionId)
    if (!record) return await manager.read(sessionId) ?? undefined
    const createdAt = new Date(record.createdAtMs).toISOString()
    const shared = {
      label: record.label,
      lastUpdated: createdAt,
      lifecycleState: record.lifecycleState ?? "active",
      createdAt,
      childSessionIds: [...(record.children ?? [])],
      conversationId: `conversation-${sessionId}`,
    }
    if (record.kind === "chat") return { ...shared, kind: "chat", command: "chat" }
    if (!record.parent) throw new Error(`the subagent record ${sessionId} names no parent`)
    return { ...shared, kind: "subagent", command: "subagent", launchedFrom: { parentSessionId: record.parent.sessionId, toolUseId: record.parent.toolUseId, conversationId: "conversation" } }
  }
  const indexOver = (reader: LocalSqliteEventStore) => createBackgroundIndex({
    reader: asAsyncEventReadSurface(reader),
    readSession,
    liveCommands: (sessionId) => live.get(sessionId) ?? [],
    replyWaits: async (sessionId) => waits.get(sessionId) ?? [],
  })
  const facts = (sessionId: string) => createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
  return {
    store, manager, sessions, live, waits,
    async workflow(startMember = false) {
      await manager.createChat({ id: "chat", conversationId: "conversation", name: "Chat" })
      await publishTestWorkflow(manager, { id: "workflow", description: "Implement", launchedFrom: { parentSessionId: "chat", conversationId: "conversation", toolUseId: "toolu_workflow" } })
      let memberId: string | undefined
      if (startMember) {
        const advance = async (event: Parameters<typeof transitionWorkflow>[1]) => {
          const control = replayWorkflowControl(store.read({ aggregateId: "workflow:workflow" }))
          const proposed = transitionWorkflow(replayWorkflow(control), event)
          if (proposed.command.kind !== "commit") throw new Error("expected a control commit")
          const proposal = proposed.command.proposal
          expect(await manager.commitWorkflow({ workflowId: "workflow", events: proposal.facts.map((fact, index) => ({
            aggregateId: "workflow:workflow", sessionId: "workflow", timestamp: Date.now(),
            ...fact, ...(index === 0 ? { expectedSeq: proposal.expectedSeq } : {}),
          })) })).toMatchObject({ kind: "stored" })
        }
        await advance({ type: "START" })
        const attemptId = replayWorkflowControl(store.read({ aggregateId: "workflow:workflow" })).attempts[0]!.id
        await advance({ type: "ATTEMPT_STARTED", attemptId, conversationId: "agent-conversation" })
        const workflowFacts = store.read({ aggregateId: "workflow:workflow" })
        const skill = testSkill("fixture-step", { name: "Fixture step" })
        const bindings = testResolvedAgents([testResolvedAgent("fixture-step", skill, { name: skill.name })])
        const queue = flattenWorkflowView(replayWorkflowControl(workflowFacts), bindings)
        store.appendBatch(queueFactsForState(loadQueueFromEvents(workflowFacts), queue).map(fact => ({ ...fact, aggregateId: "workflow:workflow", sessionId: "workflow", timestamp: Date.now() })))
        memberId = (await workflowMembershipReader(asAsyncEventReadSurface(store)).list("workflow"))[0]?.sessionId
        const parent = sessions.get("chat")
        if (parent && memberId) sessions.set("chat", { ...parent, children: [...parent.children ?? [], memberId] })
      }
      await workflowRunWriter(asAsyncEventReadSurface(store), manager.commitWorkflow).update("workflow", current => ({ ...current, createdAt: new Date(200).toISOString() }))
      return memberId
    },
    index: indexOver(store),
    /** The index a runtime that started again builds: a new store handle and nothing live. */
    restarted: () => {
      live.clear()
      waits.clear()
      return indexOver(open())
    },
    async command(sessionId: string, record: BackgroundCommandRecord): Promise<void> {
      const writer = facts(sessionId)
      await writer.record({ type: "tool.background_command.recorded", version: 1, actor: "flywheel", payload: record })
      writer.dispose()
    },
    async subagentRun(sessionId: string, status?: "completed" | "partial" | "failed"): Promise<void> {
      const writer = facts(sessionId)
      await writer.transaction(() => {
        recordSubagentCreated(writer, { childRunId: `${sessionId}-run`, toolUseId: `${sessionId}-run`, modelRequestId: "request", agentType: "worker", description: sessionId, model: "model", effort: "low", maxTurns: 4, tools: [], executionCwd: dir })
        if (status) recordSubagentCompleted(writer, { childRunId: `${sessionId}-run`, status, isError: status === "failed", content: "done", durationMs: 10 })
      })
      writer.dispose()
    },
    close: () => { for (const opened of stores) opened.close() },
  }
}

let closing: Array<() => void> = []
afterEach(() => {
  for (const close of closing) close()
  closing = []
})

/** A chat that ran two commands and started a workflow, whose subagent
 *  started a subagent of its own, and a subagent that finished. */
async function chatWithWork() {
  const fixture = project()
  closing.push(fixture.close)
  fixture.sessions.set("chat", { kind: "chat", createdAtMs: 0, label: "Chat", children: ["reviewer", "finished"] })
  fixture.sessions.set("reviewer", { kind: "subagent", createdAtMs: 250, label: "Reviewer", parent: { sessionId: "chat", toolUseId: "toolu_reviewer" }, children: ["explorer"] })
  await fixture.workflow()
  fixture.sessions.set("explorer", { kind: "subagent", createdAtMs: 260, label: "Explorer", parent: { sessionId: "reviewer", toolUseId: "toolu_explorer" } })
  fixture.sessions.set("finished", { kind: "subagent", createdAtMs: 350, label: "Finished", lifecycleState: "inactive", parent: { sessionId: "chat", toolUseId: "toolu_finished" } })
  await fixture.command("chat", { toolUseId: "toolu_test", processId: "bash-1", description: "bun test", startedAtMs: 100, state: "settled", status: "failed", exitCode: 2, settledAtMs: 400 })
  await fixture.command("chat", { toolUseId: "toolu_server", processId: "bash-2", description: "bun run dev", startedAtMs: 300, state: "running" })
  await fixture.subagentRun("reviewer")
  await fixture.subagentRun("explorer")
  await fixture.subagentRun("finished", "completed")
  fixture.live.set("chat", [{ id: "bash-2", description: "bun run dev", toolUseId: "toolu_server", startedAtMs: 300 }])
  return fixture
}

describe("the background index of a chat", () => {
  test("lists a workflow as one row with its progress and no row for its agents or their commands", async () => {
    const fixture = project()
    closing.push(fixture.close)
    fixture.sessions.set("chat", { kind: "chat", createdAtMs: 0, label: "Chat", children: [] })
    const memberId = await fixture.workflow(true)
    if (!memberId) throw new Error("expected a published member")
    const bootstrap = validateWorkflowBootstrap(fixture.store.read({ aggregateId: "workflow:workflow" }))
    expect(bootstrap.executable ? true : bootstrap.reasons).toBe(true)
    await fixture.command(memberId, { toolUseId: "member-command", processId: "process", description: "agent server", startedAtMs: 300, state: "running" })
    fixture.live.set(memberId, [{ id: "process", toolUseId: "member-command", description: "agent server", startedAtMs: 300 }])
    const rows = await fixture.index.rows("chat")
    expect(rows).toEqual([expect.objectContaining({
      id: "workflow", kind: "workflow", status: "running", target: { kind: "workflow", workflowId: "workflow" },
      progress: { done: 0, total: 1, failed: 0, running: 1, active: ["Fixture step"] },
      stop: { sessionId: "chat", toolUseId: "toolu_workflow" },
    })])
    expect(await fixture.manager.read("workflow")).toBeNull()
  })
  test("lists the chat's commands and every child in start order, each child under the child that started it, landing on the card of its top-level row", async () => {
    const fixture = await chatWithWork()

    const rows = await fixture.index.rows("chat")

    expect(rows.map((row) => [row.id, row.kind, row.status, row.parentRowId, row.cardToolUseId])).toEqual([
      ["toolu_test", "command", "failed", undefined, "toolu_test"],
      ["workflow", "workflow", "running", undefined, "toolu_workflow"],
      ["reviewer", "subagent", "running", undefined, "toolu_reviewer"],
      ["explorer", "subagent", "running", "reviewer", "toolu_reviewer"],
      ["toolu_server", "command", "running", undefined, "toolu_server"],
      ["finished", "subagent", "completed", undefined, "toolu_finished"],
    ])
    expect(rows[0]).toMatchObject({ exitCode: 2, durationMs: 300 })
    expect(rows.find(row => row.id === "workflow")?.target).toEqual({ kind: "workflow", workflowId: "workflow" })
    expect(rows.find(row => row.id === "reviewer")?.target).toEqual({ kind: "session", sessionId: "reviewer" })
    expect(rows.every(row => !("sessionId" in row))).toBe(true)
    // A finished child states how long its runs took; a running one does not.
    expect(rows.find((row) => row.id === "finished")).toMatchObject({ durationMs: 10 })
    expect(rows.filter((row) => row.status === "running").map((row) => row.durationMs)).toEqual([undefined, undefined, undefined, undefined])
    // Stop ends the call that launched the row: the chat's for a top-level
    // row, the parent child's for a nested one.
    expect(rows.map((row) => row.stop)).toEqual([
      undefined,
      { sessionId: "chat", toolUseId: "toolu_workflow" },
      { sessionId: "chat", toolUseId: "toolu_reviewer" },
      { sessionId: "reviewer", toolUseId: "toolu_explorer" },
      { sessionId: "chat", toolUseId: "toolu_server" },
      undefined,
    ])
  })

  test("after a restart lists the finished work with its outcome, and reads a command recorded as running with no owner as ended", async () => {
    const fixture = await chatWithWork()

    const rows = await fixture.restarted().rows("chat")

    expect(rows.find((row) => row.id === "toolu_test")).toMatchObject({ status: "failed", exitCode: 2, durationMs: 300 })
    expect(rows.find((row) => row.id === "finished")).toMatchObject({ status: "completed", durationMs: 10 })
    expect(rows.find((row) => row.id === "toolu_server")).toMatchObject({ status: "ended" })
    expect(rows.find((row) => row.id === "toolu_server")?.stop).toBeUndefined()
  })

  test("reads a child that waits on its parent as waiting on the parent, an interrupted child with a wait as interrupted, and a partial run as partial", async () => {
    const fixture = await chatWithWork()
    fixture.sessions.set("chat", { ...fixture.sessions.get("chat")!, children: ["reviewer", "finished", "paused", "budget"] })
    fixture.sessions.set("paused", { kind: "subagent", createdAtMs: 500, label: "Paused", lifecycleState: "inactive", parent: { sessionId: "chat", toolUseId: "toolu_paused" } })
    fixture.sessions.set("budget", { kind: "subagent", createdAtMs: 600, label: "Budget", lifecycleState: "inactive", parent: { sessionId: "chat", toolUseId: "toolu_budget" } })
    await fixture.subagentRun("paused")
    await fixture.subagentRun("budget", "partial")
    fixture.waits.set("reviewer", [{ sessionId: "chat", name: "Chat" }])
    fixture.waits.set("paused", [{ sessionId: "chat", name: "Chat" }])

    const rows = await fixture.index.rows("chat")

    expect(rows.find((row) => row.id === "reviewer")?.status).toBe("waiting_on_parent")
    // A wait on another session than the parent is no wait on the parent.
    expect(rows.find((row) => row.id === "explorer")?.status).toBe("running")
    expect(rows.find((row) => row.id === "paused")?.status).toBe("interrupted")
    expect(rows.find((row) => row.id === "budget")?.status).toBe("partial")
  })

  test("reads a subagent whose run history it cannot read as a child with no run, and still lists every other row", async () => {
    const fixture = await chatWithWork()
    // A newer build recorded a run in a shape this build cannot read.
    fixture.store.append({ aggregateId: "session:finished", sessionId: "finished", timestamp: Date.now(), type: "child_run.created", version: 99, actor: "flywheel", payload: {} })

    const rows = await fixture.index.rows("chat")

    expect(rows.map((row) => [row.id, row.status])).toEqual([
      ["toolu_test", "failed"], ["workflow", "running"], ["reviewer", "running"], ["explorer", "running"], ["toolu_server", "running"], ["finished", "interrupted"],
    ])
  })

  test("its top-level Active rows are the live background work of the status after each change, and a reply wait is in neither", async () => {
    const fixture = project()
    closing.push(fixture.close)
    fixture.sessions.set("chat", { kind: "chat", createdAtMs: 0, label: "Chat", children: [] })
    const writes: Promise<void>[] = []
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification: () => {},
      onCommandRecorded: (record) => { writes.push(fixture.command("chat", record)) },
    })
    fixture.live.set("chat", [])
    const activeTopLevel = async (): Promise<string[]> => {
      await Promise.all(writes)
      fixture.live.set("chat", registry.activeBackgroundCommands())
      const rows = await fixture.index.rows("chat")
      return backgroundIndexEntries(rows, "active").filter((entry) => entry.depth === 0 && entry.row.stop !== undefined).map((entry) => entry.row.stop!.toolUseId)
    }
    const statusIds = () => registry.activeBackgroundCommands().map((command) => command.toolUseId)
    const server = Promise.withResolvers<BackgroundWorkResult>()
    const subagent = Promise.withResolvers<BackgroundWorkResult>()

    registry.track({ done: server.promise, meta: { id: "bash-1", type: "background_command", description: "bun run dev", toolUseId: "toolu_server" }, kill: { run: () => { server.resolve({ status: "failed", content: "stopped", exit: { code: 143 } }) } }, startedAtMs: 100 })
    expect(await activeTopLevel()).toEqual(statusIds())

    fixture.sessions.set("chat", { kind: "chat", createdAtMs: 0, label: "Chat", children: ["worker"] })
    fixture.sessions.set("worker", { kind: "subagent", createdAtMs: 200, label: "Worker", parent: { sessionId: "chat", toolUseId: "toolu_worker" } })
    await fixture.subagentRun("worker")
    registry.track({ done: subagent.promise, meta: { id: "worker", type: "subagent", description: "Worker", toolUseId: "toolu_worker", model: "model" }, kill: { run: () => {} } })
    registry.track({ done: new Promise<BackgroundWorkResult>(() => {}), meta: { id: "wait-1", type: "reply_wait", description: "Waiting on Reviewer", toolUseId: "toolu_wait" }, kill: { run: () => {} }, wait: true })
    expect(await activeTopLevel()).toEqual(statusIds())
    expect(statusIds()).toEqual(["toolu_server", "toolu_worker"])

    registry.terminate("toolu_server")
    await Bun.sleep(5)
    expect(await activeTopLevel()).toEqual(statusIds())
    expect(statusIds()).toEqual(["toolu_worker"])
    expect((await fixture.index.rows("chat")).find((row) => row.id === "toolu_server")).toMatchObject({ status: "stopped", exitCode: 143 })
  })
})
