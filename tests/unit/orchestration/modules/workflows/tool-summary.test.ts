import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { Schema } from "effect"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type LocalSqliteEventStore } from "../../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { buildDurableSubagentCreated, buildSubagentPrompted } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { createWorkflowToolSummaryReader } from "../../../../../src/orchestration/modules/workflows/history/tool-summary.js"
import { createConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId } from "../../../../../src/orchestration/session/conversation/turn-end-record.js"
import { createSessionManager, type SessionManager } from "../../../../../src/orchestration/session/manager.js"
import { prepareSessionFactAppend } from "../../../../../src/orchestration/session/session-fact-writer.js"
import { authorizePlannedSessionContinuation, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, retirePlannedSessionContinuation } from "../../../../../src/orchestration/session/planned-session-continuation.js"
import { loadQueueSnapshotFromReader } from "../../../../../src/workflows/view/view-store.js"
import { frontendAttempts, readWorkflowRunRecords } from "../../../../../src/orchestration/workflow-host/frontend-attempts.js"
import { workflowCard, workflowCardCut, workflowCardSettled } from "../../../../../src/protocol/client/workflow-card.js"
import { workflowOutline } from "../../../../../src/protocol/client/workflow-outline.js"
import * as outline from "../../../../../src/protocol/client/workflow-outline.js"
import { WorkflowSessionFactSchema } from "../../../../../src/workflows/vm/session-facts.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { countStateRequests } from "../../../../helpers/state-requests.js"
import { workflowTree } from "../../../../../src/workflows/vm/view-tree.js"
import { attemptOf, items, mapWorkflow, stage } from "../../../workflows/vm/_map-fixtures.js"
import { canonicalWorkflowRecord } from "../../../../../src/workflows/definition-records.js"
import { drive, mapControl, mapOutcome, surveyControl } from "../../../workflows/vm/_tree-fixtures.js"
import { terminalWorkflowFacts } from "../../session/_child-session-reconciliation-fixtures.js"
import { createRuntimeEvent } from "../../../../../src/infra/runtime-event-factory.js"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../../../src/infra/runtime-fact-mapper.js"
import { workflowMembershipReader } from "../../../../../src/orchestration/session/workflow-membership.js"
import { TOOL_EXECUTION_FACT_TYPES } from "../../../../../src/orchestration/session/tool-execution-projection.js"
import { BUDGET_FACT_TYPES } from "../../../../../src/orchestration/session/budget-projection.js"
import { SESSION_DURATION_FACT_TYPES } from "../../../../../src/orchestration/session/session-duration-projection.js"
import { EPISODE_EVIDENCE_FACT_TYPES } from "../../../../../src/orchestration/session-store/duration.js"
import { publishWorkerAttempt } from "../../workflow-host/_workflow-host-fixtures.js"
import { memberCreated, usageV4Fact } from "../../../../fixtures/session-summary-history.js"
import type { SessionToolSummaryReader, ToolHistorySummary } from "../../../../../src/orchestration/module-seams.js"

const tmp = temporaryDirectories()
let store: LocalSqliteEventStore
let manager: SessionManager
let root: string

beforeEach(() => {
  root = tmp("workflow-tool-summary-")
  store = createSqliteEventStore(resolveEventStoreDbFile(root))
  manager = createSessionManager({ projectRoot: root, executionCwd: root, store })
})
afterEach(() => { store.close() })

/** The store reads a reader makes, by kind and aggregate. */
function countingReader() {
  const base = asAsyncEventReadSurface(store)
  const reads: string[] = []
  return {
    reads,
    reader: {
      ...base,
      aggregateSeq: (aggregateId) => { reads.push(`seq ${aggregateId}`); return base.aggregateSeq(aggregateId) },
      readSlice: (query, tolerant) => { reads.push(`slice ${query.aggregateId ?? "*"}`); return base.readSlice(query, tolerant) },
    } satisfies AsyncEventStateReadSurface,
  }
}

/** The card that a client reads: a fresh replay's summary of the launching
 *  call, measured as its owner measures it. */
async function measuredCard(summaries: SessionToolSummaryReader, toolUseId = "workflow-tool"): Promise<ToolHistorySummary | undefined> {
  const snapshot = await summaries.replay()
  const summary = snapshot.summaries.get(toolUseId)
  return summary && await snapshot.measure(summary)
}

/** A chat that launched one workflow and dispatched one subagent, or as many
 *  subagents as asked for. */
async function parentWithChildren(subagents = 1, parentId = "parent"): Promise<{ parent: string; subagent: string }> {
  const parent = await manager.createChat({ id: parentId, conversationId: `${parentId}-conversation`, name: "Parent" })
  const decode = Schema.decodeUnknownSync(WorkflowSessionFactSchema)
  await manager.publishWorkflow({
    id: `${parentId === "parent" ? "" : `${parentId}-`}workflow-child`, description: "Review", workflowDefinitionId: "workflow", initialRoles: {},
    launchedFrom: { parentSessionId: parent, conversationId: `${parentId}-conversation`, workflowDefinitionId: "workflow", toolUseId: "workflow-tool", description: "Review" },
    facts: terminalWorkflowFacts("Review", "paused").map((fact) => decode(fact)),
  })
  const subagentIds = Array.from({ length: subagents }, (_, index) => index === 0 && parentId === "parent" ? "subagent-child" : `${parentId}-subagent-${index}`)
  for (const [index, subagent] of subagentIds.entries()) {
    const run = buildDurableSubagentCreated({
      childSessionId: subagent, childRunId: "run-1", conversationId: `${subagent}-conversation`, parentSessionId: parent,
      parentConversationId: `${parentId}-conversation`, parentToolCallId: `dispatch-tool-${index}`, persona: { name: "explorer", kind: "persona" },
      capabilityGrant: { operation: "subagent dispatch", required: ["subagents"], capabilities: ["subagents"], moduleIds: ["subagents"], requireWorkflowConfirmation: false, workflowsMode: "on", identity: "test" },
      admittedModuleIds: ["subagents"], skillsRevision: 1, model: "test-model", tools: ["read"], executionCwd: root,
      budget: { maxTurns: 2, maxTokens: 1000 }, parentDepth: 0, description: "child",
    })
    await manager.publishSubagent({
      id: subagent, conversationId: `${subagent}-conversation`, description: "child", initialRoles: {}, executionCwd: root,
      launchedFrom: { parentSessionId: parent, conversationId: `${parentId}-conversation`, toolUseId: `dispatch-tool-${index}` },
      runBinding: prepareSessionFactAppend(subagent, run),
      assignment: "inspect",
      promptFact: prepareSessionFactAppend(subagent, buildSubagentPrompted({ childRunId: "run-1", prompt: "inspect", task: "inspect", toolNames: ["read"] })),
    })
  }
  // SAFETY: the list holds at least the first subagent.
  return { parent, subagent: subagentIds[0]! }
}

describe("workflow card summaries", () => {
  test("independent children read concurrently while summaries keep child order", async () => {
    const { parent } = await parentWithChildren()
    await manager.publishWorkflow({
      id: "second-workflow", description: "Second", workflowDefinitionId: "workflow", initialRoles: {},
      launchedFrom: { parentSessionId: parent, conversationId: "parent-conversation", workflowDefinitionId: "workflow", toolUseId: "second-tool", description: "Second" },
      facts: terminalWorkflowFacts("Second", "completed").map((fact) => Schema.decodeUnknownSync(WorkflowSessionFactSchema)(fact)),
    })
    const base = asAsyncEventReadSurface(store)
    const readOrder: string[] = []
    const reader: AsyncEventStateReadSurface = {
      ...base,
      async aggregateSeq(id) {
        if (id === "workflow:workflow-child") {
          await Promise.resolve()
          await Promise.resolve()
        }
        if (id === "workflow:workflow-child" || id === "workflow:second-workflow") readOrder.push(id)
        return base.aggregateSeq(id)
      },
    }
    const snapshot = await createWorkflowToolSummaryReader(reader, parent).replay()
    expect(readOrder.indexOf("workflow:second-workflow")).toBeLessThan(readOrder.indexOf("workflow:workflow-child"))
    expect([...snapshot.summaries.keys()]).toEqual(["workflow-tool", "second-tool"])
    expect([...snapshot.changedToolUseIds]).toEqual(["workflow-tool", "second-tool"])
    expect(snapshot.summaries.get("workflow-tool")?.status).toBe("paused")
    expect(snapshot.summaries.get("second-tool")?.status).toBe("completed")
  })

  test("an unmoved store reads nothing, and a subagent's own facts never read its metadata again", async () => {
    const { parent, subagent } = await parentWithChildren()
    const { reader, reads } = countingReader()
    const summaries = createWorkflowToolSummaryReader(reader, parent)

    const first = await summaries.replay()
    expect(first.summaries.get("workflow-tool")).toMatchObject({ linkUri: "flywheel://workflow/workflow-child", ownsSettlement: false, status: "paused", pausedBy: "runtime" })
    expect([...first.changedToolUseIds]).toEqual(["workflow-tool"])

    reads.length = 0
    const unmoved = await summaries.replay()
    expect(reads).toEqual([])
    expect(unmoved.changedToolUseIds.size).toBe(0)

    // The subagent works: its own session aggregate moves with each fact.
    store.append(prepareSessionFactAppend(subagent, buildSubagentPrompted({ childRunId: "run-1", prompt: "again", task: "again", toolNames: ["read"] })))
    reads.length = 0
    const moved = await summaries.replay()
    expect(reads.filter((read) => read.includes(subagent))).toEqual([])
    expect(moved.changedToolUseIds.size).toBe(0)
    expect(moved.summaries.get("workflow-tool")?.linkUri).toBe("flywheel://workflow/workflow-child")
  })

  test("a first replay resolves every child in one read, not one read for each child", async () => {
    async function slicesFor(subagents: number): Promise<number> {
      const { parent } = await parentWithChildren(subagents, `parent-${subagents}`)
      const { reader, reads } = countingReader()
      expect((await createWorkflowToolSummaryReader(reader, parent).replay()).summaries.get("workflow-tool")).toMatchObject({ linkUri: `flywheel://workflow/parent-${subagents}-workflow-child` })
      return reads.filter((read) => read.startsWith("slice")).length
    }

    expect(await slicesFor(8)).toBe(await slicesFor(1))
  })

  test("cards whose workflows ran in different directories fold the workspace session catalog once", async () => {
    /** The workspace catalog folds that one first replay and a measurement
     *  of every card make, over cards that ran in `directories` distinct
     *  worktrees. */
    async function catalogFoldsFor(directories: number): Promise<number> {
      const { parent } = await parentWithChildren(1, `parent-${directories}`)
      for (let index = 0; index < directories; index++) {
        const worktree = join(root, "worktrees", `${directories}-${index}`)
        mkdirSync(worktree, { recursive: true })
        await manager.publishWorkflow({
          id: `parent-${directories}-worktree-${index}`, description: "Review", workflowDefinitionId: "workflow", initialRoles: {}, executionCwd: worktree,
          launchedFrom: { parentSessionId: parent, conversationId: `parent-${directories}-conversation`, workflowDefinitionId: "workflow", toolUseId: `worktree-tool-${index}`, description: "Review" },
          facts: terminalWorkflowFacts("Review", "completed").map((fact) => Schema.decodeUnknownSync(WorkflowSessionFactSchema)(fact)),
        })
      }
      const counter = countStateRequests(asAsyncEventReadSurface(store))
      const snapshot = await createWorkflowToolSummaryReader(counter.reader, parent).replay()
      expect(snapshot.summaries.size).toBe(directories + 1)
      await Promise.all([...snapshot.summaries.values()].map((summary) => snapshot.measure(summary)))
      // Only the catalog reads metadata decorations across every aggregate from the first position.
      return counter.take().filter(({ query, args }) => query?.aggregateId === undefined && query?.types?.includes("session.chat_metadata.updated") && (args[2] ?? 0) === 0).length
    }

    expect(await catalogFoldsFor(1)).toBe(1)
    expect(await catalogFoldsFor(6)).toBe(1)
  })

  test("a replay reads no member's history, and measuring a card reads only its own members, once", async () => {
    const { parent } = await parentWithChildren()
    const workflows = ["workflow-child", "other-workflow-0", "other-workflow-1", "other-workflow-2"]
    for (const [index, id] of workflows.slice(1).entries()) {
      await manager.publishWorkflow({
        id, description: "Other", workflowDefinitionId: "workflow", initialRoles: {},
        launchedFrom: { parentSessionId: parent, conversationId: "parent-conversation", workflowDefinitionId: "workflow", toolUseId: `other-tool-${index}`, description: "Other" },
        facts: terminalWorkflowFacts("Other", "completed").map((fact) => Schema.decodeUnknownSync(WorkflowSessionFactSchema)(fact)),
      })
    }
    // Every workflow has members of its own with usage and calls, so a
    // measurement that read another card's members would count them.
    for (const workflow of workflows) {
      for (const member of [`${workflow}-a`, `${workflow}-b`]) {
        for (const { position: _position, id: _id, seq: _seq, ...fact } of [memberCreated(member, workflow, workflow), usageV4Fact(0, member, `${member}-usage`)]) store.append(fact)
        store.append({
          aggregateId: `session:${member}`, sessionId: member, timestamp: 1, actor: "agent", type: "tool.input.completed", version: 1,
          payload: { toolUseId: `${member}-call`, toolName: "read", input: {}, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false },
        })
      }
    }
    const memberTypes = new Set<string>([...BUDGET_FACT_TYPES, ...TOOL_EXECUTION_FACT_TYPES, ...EPISODE_EVIDENCE_FACT_TYPES, ...SESSION_DURATION_FACT_TYPES])
    const counter = countStateRequests(asAsyncEventReadSurface(store))
    // A Stop is the launching call's result, so the parent's own tool facts are not a member's history.
    const memberReads = () => counter.take().filter(({ query }) => query?.aggregateId !== `session:${parent}` && query?.types?.some((type) => memberTypes.has(type)))
    const snapshot = await createWorkflowToolSummaryReader(counter.reader, parent).replay()
    expect(snapshot.summaries.size).toBe(4)
    expect(memberReads()).toEqual([])

    const card = snapshot.summaries.get("other-tool-0")
    if (card === undefined) throw new Error("expected the card")
    const folds = spyOn(outline, "workflowOutline")
    try {
      const [measured] = await Promise.all([snapshot.measure(card), snapshot.measure(card)])
      // Two members, each with one call and 100 input and 10 output tokens.
      expect(measured).toMatchObject({ totalToolCount: 2, totalTokens: 220, card: { done: 1, total: 1 } })
      const measuring = memberReads()
      expect(measuring.length).toBeGreaterThan(0)
      // Every member read names its aggregates: the card's workflow and its own members.
      for (const { query } of measuring) {
        const aggregates = query?.aggregateIds ?? (query?.aggregateId === undefined ? undefined : [query.aggregateId])
        expect(aggregates?.every((id) => /^(workflow:other-workflow-0|session:other-workflow-0-.+)$/.test(id))).toBe(true)
      }
      expect(await snapshot.measure(card)).toEqual(measured)
      expect(memberReads()).toEqual([])
      expect(folds).toHaveBeenCalledTimes(1)
    } finally { folds.mockRestore() }
  })

  test("a replay asked for during a running replay shows the child facts committed before it was asked for", async () => {
    const { parent } = await parentWithChildren()
    const base = asAsyncEventReadSurface(store)
    const controlRead = Promise.withResolvers<void>()
    const releaseControl = Promise.withResolvers<void>()
    const reader: AsyncEventStateReadSurface = {
      ...base,
      readSlice: async (...args) => {
        const result = await base.readSlice(...args)
        if (args[0].aggregateId === "workflow:workflow-child") {
          controlRead.resolve()
          await releaseControl.promise
        }
        return result
      },
    }
    const summaries = createWorkflowToolSummaryReader(reader, parent)

    const running = summaries.replay()
    await controlRead.promise
    store.append({ aggregateId: "workflow:workflow-child", sessionId: "workflow-child", type: "queue.state.changed", version: 1, timestamp: 1, actor: "flywheel", payload: { status: "completed", cursor: 0 } })
    const later = summaries.replay()
    releaseControl.resolve()
    await running

    expect((await later).summaries.get("workflow-tool")?.status).toBe("completed")
  })

  test("a workflow card states the workflow's own state, and a change to its control alone refreshes the card", async () => {
    const { parent } = await parentWithChildren()
    const summaries = createWorkflowToolSummaryReader(asAsyncEventReadSurface(store), parent)
    expect((await summaries.replay()).summaries.get("workflow-tool")).toMatchObject({ status: "paused", pausedBy: "runtime" })

    const settle = (status: "running" | "completed" | "failed") => store.append({ aggregateId: "workflow:workflow-child", sessionId: "workflow-child", type: "queue.state.changed", version: 1, timestamp: 1, actor: "flywheel", payload: { status, cursor: 0 } })
    // Running control that a runner holds runs; with no runner, an unexpected exit interrupted it.
    settle("running")
    expect((await summaries.replay()).summaries.get("workflow-tool")).toMatchObject({ status: "active" })
    store.append({ aggregateId: "workflow:workflow-child", sessionId: "workflow-child", type: "workflow.run.cut.updated", version: 1, timestamp: 1, actor: "flywheel", payload: { cut: { by: "runtime", timestamp: 1 } } })
    expect((await summaries.replay()).summaries.get("workflow-tool")).toMatchObject({ status: "paused", pausedBy: "runtime" })

    settle("completed")
    const completed = await summaries.replay()
    expect([...completed.changedToolUseIds]).toEqual(["workflow-tool"])
    expect(completed.summaries.get("workflow-tool")).toMatchObject({ status: "completed" })
    settle("failed")
    expect((await summaries.replay()).summaries.get("workflow-tool")).toMatchObject({ status: "error", failure: expect.objectContaining({ message: expect.any(String) }) })
  })

  /** The launched workflow as a planned replacement leaves it: its agent
   *  started, the cut recorded in the agent's conversation, and the abort
   *  returned the attempt to pending under paused control. */
  async function cutByReplacement(reader: AsyncEventStateReadSurface) {
    const writer = asAsyncEventWriter(store)
    const attemptId = (await loadQueueSnapshotFromReader(reader, "workflow-child"))?.attempts[0]?.id
    if (attemptId === undefined) throw new Error("expected an attempt")
    store.append({ ...childControl, type: "step.status.changed", version: 2, timestamp: 42_000, payload: { attemptId, status: "running" } })
    store.append({ ...childControl, type: "step.resume_state.recorded", version: 1, timestamp: 42_000, payload: { stepId: attemptId, conversationId: "step-conversation" } })
    store.append({ ...childControl, type: "step.status.changed", version: 2, timestamp: 43_000, payload: { attemptId, status: "pending" } })
    store.append({ ...childControl, type: "queue.tree.changed", version: 4, timestamp: 43_000, payload: { tree: { currentAgentNodeId: "work", nodes: [
      { id: "work:phase", kind: "phase", form: "single", phaseId: "work", label: "Work", parentId: null, disposition: "pending" },
      { id: "work", kind: "agent", definitionId: "work", label: "Work", parentId: "work:phase", disposition: "pending", attempts: 1, currentAttemptId: attemptId },
    ] } } })
    const tree = await createConversationTree({ conversationId: "step-conversation", sessionId: "workflow-child", store: reader, writer })
    await tree.appendMessage({ kind: "user", content: "Review the change.", origin: "human" })
    const cut = interruptedTurnEnd("replacement")
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(cut.pausedBy, false), origin: "system" }, turnEndEntryId(cut, "cut"))
    return tree
  }
  const childControl = { aggregateId: "workflow:workflow-child", sessionId: "workflow-child", actor: "flywheel" } as const

  test("a workflow that a planned replacement paused reads running while its successor owes it the continuation, and interrupted once a refused resume retires the row", async () => {
    const { parent } = await parentWithChildren()
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const summaries = createWorkflowToolSummaryReader(reader, parent)
    const tree = await cutByReplacement(reader)
    expect((await measuredCard(summaries))?.status).toBe("paused")

    await authorizePlannedSessionContinuation({ reader, writer, continuation: { target: { kind: "workflow", workflowId: "workflow-child" }, handoffId: "handoff" } })
    store.append({ ...childControl, type: "queue.state.changed", version: 1, timestamp: 44_000, payload: { status: "paused", cursor: 0 } })
    const owed = await measuredCard(summaries)
    expect(owed).toMatchObject({ status: "active" })
    expect(owed?.card?.phases).toMatchObject([{ key: "work:phase", state: "running", agents: [{ state: "running" }] }])

    // A refused resume commits nothing: only the retired row says the run waits for a person again.
    await retirePlannedSessionContinuation({ reader, writer, sessionId: "workflow-child" })
    const refused = await summaries.replay()
    expect([...refused.changedToolUseIds]).toEqual(["workflow-tool"])
    expect(refused.summaries.get("workflow-tool")).toMatchObject({ status: "paused", pausedBy: "runtime" })

    // A person's interrupt over the cut still names the person while a successor owes the run.
    await authorizePlannedSessionContinuation({ reader, writer, continuation: { target: { kind: "workflow", workflowId: "workflow-child" }, handoffId: "handoff-2" } })
    const end = interruptedTurnEnd("person")
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, "person"))
    tree.getStorage().dispose()
    expect((await summaries.replay()).summaries.get("workflow-tool")).toMatchObject({ status: "paused", pausedBy: "person" })
  })

  test.each([
    ["first", "ends"],
    ["later", "ends"],
    // The racing read stores the card's key and then fails when it totals
    // the members.
    ["later", "fails"],
  ] as const)("a refused resume that retires the row while the %s read of an owed card runs, and that read %s, shows the run interrupted on the next read", async (read, outcome) => {
    const { parent } = await parentWithChildren()
    const base = asAsyncEventReadSurface(store)
    // Holds the next read of the child's continuation rows after it read
    // them, until the test releases it.
    let hold: { readonly reached: () => void; readonly release: Promise<void> } | undefined
    let failNextPosition = false
    const reader: AsyncEventStateReadSurface = {
      ...base,
      async capturePosition() {
        if (!failNextPosition) return base.capturePosition()
        failNextPosition = false
        throw new Error("store read failed")
      },
      async readInFlight(id, kind, keyPrefix) {
        const rows = await base.readInFlight(id, kind, keyPrefix)
        const held = hold
        if (held && id === "workflow-child" && kind === PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND) {
          hold = undefined
          held.reached()
          await held.release
        }
        return rows
      },
    }
    const writer = asAsyncEventWriter(store)
    const summaries = createWorkflowToolSummaryReader(reader, parent)
    const tree = await cutByReplacement(reader)
    tree.getStorage().dispose()
    await authorizePlannedSessionContinuation({ reader, writer, continuation: { target: { kind: "workflow", workflowId: "workflow-child" }, handoffId: "handoff" } })
    if (read === "later") {
      // A measured card holds its members' totals, which the next read advances.
      expect((await measuredCard(summaries))?.status).toBe("active")
      store.append({ ...childControl, type: "queue.state.changed", version: 1, timestamp: 44_000, payload: { status: "paused", cursor: 0 } })
    }
    let release = () => {}
    const reached = new Promise<void>((resolve) => { hold = { reached: resolve, release: new Promise((done) => { release = done }) } })
    const racing = summaries.replay()
    await reached
    await retirePlannedSessionContinuation({ reader, writer, sessionId: "workflow-child" })
    failNextPosition = outcome === "fails"
    release()
    if (outcome === "fails") await expect(racing).rejects.toThrow("store read failed")
    else expect((await racing).summaries.get("workflow-tool")?.status).toBe("active")
    expect((await summaries.replay()).summaries.get("workflow-tool")).toMatchObject({ status: "paused", pausedBy: "runtime" })
  })

  test("a workflow child with a fact this build cannot read never stops the parent's transcript", async () => {
    const { parent } = await parentWithChildren()
    const summaries = createWorkflowToolSummaryReader(asAsyncEventReadSurface(store), parent)
    expect((await measuredCard(summaries))?.card).toMatchObject({ done: 0, total: 1 })

    // An unreadable tree reads as absent, and the card counts the tree that
    // control rebuilds.
    store.append({ aggregateId: "workflow:workflow-child", sessionId: "workflow-child", type: "queue.tree.changed", version: 4, timestamp: 1, actor: "flywheel", payload: { tree: { nodes: [
      { id: "work", kind: "step", stepId: "work", label: "Work", parentId: null, disposition: "completed", attempts: 1, removedLaterField: "x" },
    ] } } })
    expect((await measuredCard(summaries))?.card).toMatchObject({ done: 0, total: 1 })

    // Unreadable attempt rows leave the card without its fold, and the card
    // still reads.
    store.append({ aggregateId: "workflow:workflow-child", sessionId: "workflow-child", type: "queue.state.changed", version: 1, timestamp: 2, actor: "flywheel", payload: { status: "running", cursor: 0, removedLaterField: "x" } })
    const snapshot = await summaries.replay()
    // Saved progress this build cannot read cannot run, so the card reads as
    // interrupted by the runtime, not as a run that waits to start.
    expect(snapshot.summaries.get("workflow-tool")).toMatchObject({ toolUseId: "workflow-tool", status: "paused", pausedBy: "runtime" })
    expect(snapshot.summaries.get("workflow-tool")?.card).toBeUndefined()
  })

  test("every loaded workflow card carries the fold of its plan, read from its queue with each attempt's start, as a client folds the same view", async () => {
    const { parent } = await parentWithChildren()
    const summaries = createWorkflowToolSummaryReader(asAsyncEventReadSurface(store), parent)
    const card = async () => (await measuredCard(summaries))?.card
    expect(await card()).toMatchObject({ done: 0, total: 1 })
    store.append({ aggregateId: "workflow:workflow-child", sessionId: "workflow-child", type: "queue.tree.changed", version: 4, timestamp: 1, actor: "flywheel", payload: { tree: { nodes: [
      { id: "work:phase", kind: "phase", form: "single", phaseId: "work", label: "Work", parentId: null, disposition: "completed" },
      { id: "work", kind: "agent", definitionId: "work", label: "Work", parentId: "work:phase", disposition: "completed", attempts: 1 },
      { id: "review:phase", kind: "phase", form: "single", phaseId: "review", label: "Review", parentId: null, disposition: "pending" },
      { id: "review", kind: "agent", definitionId: "review", label: "Review", parentId: "review:phase", disposition: "pending", attempts: 1 },
    ] } } })
    expect(await card()).toMatchObject({ done: 1, total: 2, phases: [{ phaseId: "work", state: "done" }, { phaseId: "review", state: "queued" }] })
    const summary = (await summaries.replay()).summaries.get("workflow-tool")
    expect(summary).not.toHaveProperty("progress")

    const failing = new Set([attemptOf(stage(2, 1))])
    const control = drive(mapControl(), mapOutcome(items("a", "b", "c"), failing), (current) => current.attempts.some(({ state }) => state._tag === "failed"))
    store.append({ aggregateId: "workflow:workflow-child", sessionId: "workflow-child", type: "queue.tree.changed", version: 4, timestamp: 1, actor: "flywheel", payload: { tree: workflowTree(control, (id) => id) } })
    const mappedSummary = await measuredCard(summaries)
    const mapped = mappedSummary?.card
    expect(mapped).toMatchObject({ done: 5, total: 8, failed: 1, finishedFailed: 1 })
    expect(mapped?.phases.find(({ form }) => form === "list")).toMatchObject({ phaseId: "implement", agentCount: 3, failed: 1 })
    // A client that folds the same view with the same function draws the
    // same card, so the inline card's first frame and its live fold agree.
    const queue = await loadQueueSnapshotFromReader(asAsyncEventReadSurface(store), "workflow-child")
    if (queue === null) throw new Error("expected the child's queue")
    const status = mappedSummary?.status ?? "active"
    expect(mapped).toEqual(workflowCard(workflowOutline({ attempts: frontendAttempts(queue), tree: queue.tree }, workflowCardCut(status)), { settled: workflowCardSettled(status) }))

    // A survey that completed with a required target unsurveyed names its
    // coverage beside the count.
    const survey = surveyControl([{ id: "a", priority: "required", report: "surveyed" }, { id: "b", priority: "required", report: "fail" }])
    store.append({ aggregateId: "workflow:workflow-child", sessionId: "workflow-child", type: "queue.tree.changed", version: 4, timestamp: 2, actor: "flywheel", payload: { tree: workflowTree(survey, (id) => id) } })
    expect((await card())?.coverage).toEqual([{ text: "coverage required 1 of 2, 1 unsurveyed", tone: "failed" }])
  })

  test("a workflow card's fold names when each attempt started, and an unmoved fold changes nothing", async () => {
    const { parent } = await parentWithChildren()
    const summaries = createWorkflowToolSummaryReader(asAsyncEventReadSurface(store), parent)
    const recorded = { aggregateId: "workflow:workflow-child", sessionId: "workflow-child", actor: "flywheel" } as const
    store.append({ ...recorded, type: "queue.state.changed", version: 1, timestamp: 1, payload: { status: "running", cursor: 0 } })
    const attemptId = (await loadQueueSnapshotFromReader(asAsyncEventReadSurface(store), "workflow-child"))?.attempts[0]?.id
    if (attemptId === undefined) throw new Error("expected an attempt")
    store.append({ ...recorded, type: "step.status.changed", version: 2, timestamp: 42_000, payload: { attemptId, status: "running" } })
    store.append({ ...recorded, type: "queue.tree.changed", version: 4, timestamp: 42_000, payload: { tree: { currentAgentNodeId: "work", nodes: [
      { id: "work:phase", kind: "phase", form: "single", phaseId: "work", label: "Work", parentId: null, disposition: "running" },
      { id: "work", kind: "agent", definitionId: "work", label: "Work", parentId: "work:phase", disposition: "running", attempts: 1, currentAttemptId: attemptId },
    ] } } })
    expect((await measuredCard(summaries))?.card?.phases).toMatchObject([{ key: "work:phase", state: "running", agents: [{ startedAt: 42_000 }] }])
    expect((await summaries.replay()).changedToolUseIds.size).toBe(0)
  })

  test("a workflow card carries nothing that its launch recorded: no warning, file path, verifier result, or worst case", async () => {
    const { parent } = await parentWithChildren()
    const flat = await parentWithChildren(1, "registered")
    const filePath = join(root, ".flywheel", "sessions", parent, "scratch", "workflows", "mapped.workflow.yaml")
    const launch = (childId: string, provenance: { readonly layer: "session" | "bundled"; readonly filePath: string }, verification: "partially_proved" | null, warnings: readonly string[]) => {
      const recorded = { aggregateId: `workflow:${childId}`, sessionId: childId, timestamp: 1, actor: "flywheel" } as const
      store.append({ ...recorded, type: "definition.loaded", version: 7, payload: { kind: "workflow", id: "mapped", definition: canonicalWorkflowRecord(mapWorkflow), provenance: { ...provenance, id: "mapped" } } })
      store.append({ ...recorded, type: "workflow.compiled", version: 10, payload: {
        workflowDefinitionId: "mapped", workflowName: "Mapped", userRequestArtifactId: "user-request", userRequestSha256: "a".repeat(64),
        stepIds: ["plan"], skillIds: [], steps: [], worstCaseAttempts: 8, verification, warnings,
      } })
    }
    const warning = "mapped.workflow.yaml flow[1] map: the list holds at most 100 items"
    launch("workflow-child", { layer: "session", filePath }, "partially_proved", [warning])
    launch("registered-workflow-child", { layer: "bundled", filePath: "/bundle/workflows/mapped.yaml" }, null, [])

    // The launching agent reads each warning in its tool result and fixes the
    // file; the person cannot act on one, so the card shows none.
    const card = (await createWorkflowToolSummaryReader(asAsyncEventReadSurface(store), parent).replay()).summaries.get("workflow-tool")
    expect(card).toBeDefined()
    expect(JSON.stringify(card)).not.toMatch(/warnings|at most 100 items|scratch\/workflows|proved|worst case/)
    const registered = (await createWorkflowToolSummaryReader(asAsyncEventReadSurface(store), flat.parent).replay()).summaries.get("workflow-tool")
    expect(JSON.stringify(registered)).not.toMatch(/warnings|bundle\/workflows/)
  })

  test("a workflow card and the run's own view name the run by the title its launch gave it, and by the workflow's name when the launch gave none", async () => {
    const titled = await parentWithChildren(1, "titled")
    const untitled = await parentWithChildren(1, "untitled")
    const compile = (childId: string) => store.append({ aggregateId: `workflow:${childId}`, sessionId: childId, timestamp: 1, actor: "flywheel", type: "workflow.compiled", version: 10, payload: {
      workflowDefinitionId: "mapped", workflowName: "Fanout Ui", userRequestArtifactId: "user-request", userRequestSha256: "a".repeat(64),
      stepIds: ["plan"], skillIds: [], steps: [], worstCaseAttempts: 8, verification: null, warnings: [],
    } })
    const call = (parentId: string, input: { readonly [key: string]: unknown }) => {
      const [fact] = mapRuntimeEventToSessionRuntimeFacts(createRuntimeEvent("tool.input.completed", {
        model_request_id: "request-1",
        tool_use: { id: "workflow-tool", name: "workflow", provider_call_id: "call-1", provider_tool_name: "workflow", executable_tool_name: "workflow", input, execution: { mode: "foreground", trace_kind: "tool" } },
      }))
      if (fact === undefined) throw new Error("the call mapped to no fact")
      store.append({ aggregateId: `session:${parentId}`, sessionId: parentId, timestamp: 1, actor: "agent", type: fact.type, version: fact.version, payload: fact.payload })
    }
    compile("titled-workflow-child")
    compile("untitled-workflow-child")
    call(titled.parent, { source: { kind: "path", path: "fanout-ui.phase.workflow.yaml" }, summary: "Debug bash edit mutation flows", description: "Review" })
    call(untitled.parent, { source: { kind: "path", path: "fanout-ui.phase.workflow.yaml" }, description: "Review" })
    const label = async (parent: string) => (await createWorkflowToolSummaryReader(asAsyncEventReadSurface(store), parent).replay()).summaries.get("workflow-tool")?.label
    expect(await label(titled.parent)).toBe("Debug bash edit mutation flows")
    expect(await label(untitled.parent)).toBe("Fanout Ui")
    // The full-size card and the agent view read the run's name from the
    // same records, so every surface names the run alike.
    expect((await readWorkflowRunRecords(asAsyncEventReadSurface(store), "titled-workflow-child"))?.name).toBe("Debug bash edit mutation flows")
    expect((await readWorkflowRunRecords(asAsyncEventReadSurface(store), "untitled-workflow-child"))?.name).toBe("Fanout Ui")
  })

  test("an interrupt recorded only in the current step's conversation refreshes the card and names who interrupted it", async () => {
    const { parent, subagent } = await parentWithChildren()
    const { reader, reads } = countingReader()
    const summaries = createWorkflowToolSummaryReader(reader, parent)
    store.append({ aggregateId: "workflow:workflow-child", sessionId: "workflow-child", type: "queue.state.changed", version: 1, timestamp: 1, actor: "flywheel", payload: { status: "running", cursor: 0 } })
    const queue = await loadQueueSnapshotFromReader(asAsyncEventReadSurface(store), "workflow-child")
    const stepId = queue?.attempts[queue.cursor]?.id
    if (stepId === undefined) throw new Error("expected a current step")
    store.append({ aggregateId: "workflow:workflow-child", sessionId: "workflow-child", type: "step.resume_state.recorded", version: 1, timestamp: 1, actor: "flywheel", payload: { stepId, conversationId: "step-conversation" } })
    const tree = await createConversationTree({ conversationId: "step-conversation", sessionId: "workflow-child", store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await tree.appendMessage({ kind: "user", content: "Review the change.", origin: "human" })
    expect((await summaries.replay()).summaries.get("workflow-tool")).toMatchObject({ status: "active" })

    // A fact elsewhere in the store leaves the card's evidence unmoved, so
    // the card is not read again.
    store.append(prepareSessionFactAppend(subagent, buildSubagentPrompted({ childRunId: "run-1", prompt: "again", task: "again", toolNames: ["read"] })))
    reads.length = 0
    expect((await summaries.replay()).changedToolUseIds.size).toBe(0)
    expect(reads.filter((read) => read.startsWith("slice") && read.includes("workflow-child"))).toEqual([])

    // The person interrupts the step: only the step's conversation records it.
    const end = interruptedTurnEnd("person")
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, "key"))
    tree.getStorage().dispose()
    const interrupted = await summaries.replay()
    expect([...interrupted.changedToolUseIds]).toEqual(["workflow-tool"])
    expect(interrupted.summaries.get("workflow-tool")).toMatchObject({ status: "paused", pausedBy: "person" })
  })

  test("a member's call reads only the new facts, in as many requests, whatever the member count", async () => {
    const HISTORY = 6
    const toolInput = (sessionId: string, toolUseId: string, parentToolUseId?: string) => ({
      aggregateId: `session:${sessionId}`, sessionId, timestamp: 1, actor: "agent", type: "tool.input.completed", version: 1,
      payload: {
        toolUseId, toolName: "read", input: { path: "a" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}",
        executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false, ...(parentToolUseId === undefined ? {} : { parentToolUseId }),
      },
    })
    /** The most facts one member's call made the card read, over the second
     *  half of 2M calls spread round robin over M members. */
    const factsPerCall = async (memberCount: number) => {
      const dir = tmp("workflow-tool-summary-members-")
      const own = createSqliteEventStore(resolveEventStoreDbFile(dir))
      try {
        const base = asAsyncEventReadSurface(own)
        const bindings = Array.from({ length: memberCount }, (_, index) => ({ attemptId: `a${index}`, conversationId: `conv-${index}` }))
        const { manager: owner, member } = await publishWorkerAttempt({ projectRoot: dir, reader: base, writer: asAsyncEventWriter(own), workflowId: "wf", ...bindings[0]!, siblings: bindings.slice(1) })
        const parent = (await owner.read(member.sessionId))?.launchedFrom?.parentSessionId
        if (parent === undefined) throw new Error("Expected a launching chat")
        const members = await Promise.all(bindings.map(async ({ attemptId }) => (await workflowMembershipReader(base).attempt("wf", attemptId))!.sessionId))
        for (const sessionId of members) {
          for (let call = 0; call < HISTORY; call++) own.append(toolInput(sessionId, `${sessionId}-${call}`))
          // A call that another call dispatched is not counted on the card.
          own.append(toolInput(sessionId, `${sessionId}-nested`, `${sessionId}-0`))
        }
        // The facts that reads for the tool count return: the reads of every
        // tool-execution fact type. The duration probe reads the newest fact
        // of each member, which this test does not measure.
        const toolFacts = (types: readonly string[] | undefined, read: readonly unknown[]) =>
          TOOL_EXECUTION_FACT_TYPES.every((type) => types?.includes(type)) ? read.length : 0
        let facts = 0
        let requests = 0
        // Every store request the card makes, whatever its kind.
        const counted = <Args extends unknown[], Result>(read: (...args: Args) => Result) => (...args: Args): Result => { requests += 1; return read(...args) }
        const reader: AsyncEventStateReadSurface = {
          ...base,
          capturePosition: counted(base.capturePosition),
          latestPosition: counted(base.latestPosition),
          readLatestPayloadByAggregateAndType: counted(base.readLatestPayloadByAggregateAndType),
          readLatestByAggregateAndTypes: counted(base.readLatestByAggregateAndTypes),
          readInFlight: counted(base.readInFlight),
          countByAggregate: counted(base.countByAggregate),
          aggregateSeq: counted(base.aggregateSeq),
          readPage: async (query, upper, after, tolerant, content) => {
            requests += 1
            const page = await base.readPage(query, upper, after, tolerant, content)
            facts += toolFacts(query.types, page.facts)
            return page
          },
          readSlice: async (query, tolerant) => {
            requests += 1
            const slice = await base.readSlice(query, tolerant)
            facts += toolFacts(query.types, slice.facts)
            return slice
          },
        }
        const summaries = createWorkflowToolSummaryReader(reader, parent)
        // A replay states the run's own figures; the client's read of the card measures its members.
        const first = await summaries.replay()
        expect(first.summaries.get("worker-launch")?.totalToolCount).toBe(0)
        expect((await first.measure(first.summaries.get("worker-launch")!)).totalToolCount).toBe(HISTORY * memberCount)
        // Every read of a member that the held membership state keeps, by any
        // reader of this project, after the card's first read.
        const visits = { count: 0 }
        for (const held of await workflowMembershipReader(reader).list("wf")) {
          for (const field of ["sessionId", "membership"] as const) {
            const value = held[field]
            Object.defineProperty(held, field, { get: () => { visits.count += 1; return value } })
          }
        }
        const perCall: { facts: number; requests: number; visits: number; folds: number }[] = []
        // The first replay after the measurement restates the card with its
        // fold. After it, the card folds its plan again only on its own
        // evidence or a member's episode end, never on a member's call.
        const folds = spyOn(outline, "workflowOutline")
        try {
          for (let call = 0; call < 2 * memberCount; call++) {
            own.append(toolInput(members[call % memberCount]!, `live-${call}`))
            const before = { facts, requests, visits: visits.count, folds: folds.mock.calls.length }
            const snapshot = await summaries.replay()
            perCall.push({ facts: facts - before.facts, requests: requests - before.requests, visits: visits.count - before.visits, folds: folds.mock.calls.length - before.folds })
            expect(snapshot.changedToolUseIds.has("worker-launch")).toBe(true)
            expect(snapshot.summaries.get("worker-launch")?.totalToolCount).toBe(HISTORY * memberCount + call + 1)
          }
          // A member's episode end moves its recorded time: one fold.
          const ended = folds.mock.calls.length
          own.append({ aggregateId: `session:${members[0]!}`, sessionId: members[0]!, timestamp: 2, actor: "flywheel", type: "session.duration.recorded", version: 1, payload: { accumulatedActiveMs: 5_000 } })
          await summaries.replay()
          expect(folds.mock.calls.length - ended).toBe(1)
        } finally { folds.mockRestore() }
        const steady = perCall.slice(memberCount)
        return {
          facts: Math.max(...steady.map((call) => call.facts)),
          requests: Math.max(...steady.map((call) => call.requests)),
          visits: Math.max(...steady.map((call) => call.visits)),
          folds: Math.max(...perCall.slice(1).map((call) => call.folds)),
        }
      } finally {
        own.close()
      }
    }
    // Eight members is where the held tool-execution projections began to evict each other.
    // A member's call moves only the card's totals: neither the facts the card
    // reads, its store requests, nor its reads of the membership grow with
    // the member count.
    const many = await factsPerCall(12)
    expect(many).toEqual(await factsPerCall(3))
    expect(many.folds).toBe(0)
  })
})
