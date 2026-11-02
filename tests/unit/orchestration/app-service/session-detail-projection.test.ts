import { describe, expect, mock, test } from "bun:test"
import { Schema } from "effect"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { FIXTURE_EXECUTION_CWD, temporaryDirectories } from "../../../helpers/directories.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventWriter, type EventStore, type EventStoreReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createSessionDetailProjection as createDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { createProjectControlClient } from "../../../../src/orchestration/app-service/project-control-client.js"
import { fixture } from "./_project-control-client-fixture.js"
import { durableRow } from "./_frontend-projection-fixtures.js"
import { buildDurableSubagentCreated, buildSubagentPaused } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { interruptedTurnEnd, interruptedTurnMessage, turnEndEntryId, type TurnInterruption } from "../../../../src/orchestration/session/conversation/turn-end-record.js"
import { authorizePlannedSessionContinuation, PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, retirePlannedSessionContinuation } from "../../../../src/orchestration/session/planned-session-continuation.js"
import { prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer.js"
import type { ChatSessionEntry } from "../../../../src/orchestration/session-store/types.js"
import type { SessionSummaryIndex } from "../../../../src/orchestration/session/session-summary-index.js"
import type { SessionManager } from "../../../../src/orchestration/session/manager.js"
import { isInterruptible, offeredSessionControls } from "../../../../src/protocol/client/session-controls.js"
import { SessionCatalogRowSchema } from "../../../../src/protocol/session-catalog-protocol-schemas.js"
import type { RuntimeSessionDetailResult } from "../../../../src/protocol/session-detail-protocol-types.js"
import { WORKFLOW_LAUNCH_OPERATION_KIND, type WorkflowLaunchOperation } from "../../../../src/orchestration/workflow-host/launch-operation-contract.js"
import { CONTINUATION_MESSAGES } from "../../../../src/orchestration/agent-runtime/continuation-messages.js"
import { createOutputSession } from "../../../../src/orchestration/runner/output-session.js"
import { projectBlocksFromEntries } from "../../../../src/orchestration/session/conversation/conversation-block-projection.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { publishTestWorkflow, startTestWorkflowMember } from "../session/_session-manager-fixtures.js"
import { createWorkflowDetailReader } from "../../../../src/orchestration/modules/workflows/detail.js"

function createSessionDetailProjection(deps: Omit<Parameters<typeof createDetailProjection>[0], "reader" | "projectionReader"> & {
  reader: EventStoreReadSurface
  projectionReader?: Parameters<typeof createDetailProjection>[0]["projectionReader"]
}) {
  const reader = asAsyncEventReadSurface(deps.reader)
  return createDetailProjection({ ...deps, reader, projectionReader: deps.projectionReader ?? reader })
}

function entry(activeForegroundBashToolCallIds: readonly string[]): ChatSessionEntry {
  return {
    kind: "chat", runner: null, conversationId: "conv-1", description: "Chat", entryEpoch: 1,
    outputBlocks: () => [],
    outputSequenceStart: 0,
    visibleMessageCountPrefix: 0,
    visibleMessageCountSuffix: 0,
    streamingToolText: {},
    tokens: 0, cost: 0,
    billedCost: 0,
    priceUnavailable: false,
    contextPercent: 0,
    streamingOutputChars: 0,
    contextPromptTokens: 0,
    startedAt: 100,
    streamPhase: null,
    runnerState: "idle",
    activityStartedAt: 100,
    streamingStartedAt: null,
    accumulatedActiveMs: 0,
    connectionState: "connected",
    notices: [],
    compactionStartedAt: null,
    activeSubagents: new Set(),
    waitingOnBackgroundWork: false,
    activeBackgroundCommands: [],
    activeForegroundBashToolCallIds,
  }
}

function metadata(lifecycleState: "active" | "inactive") {
  return {
    label: "Chat",
    lastUpdated: "2026-01-01T00:00:00.000Z",
    lifecycleState,
    executionCwd: FIXTURE_EXECUTION_CWD,
    name: "Chat",
    kind: "chat" as const,
    command: "chat" as const,
    conversationId: "conv-1",
  }
}

function subagentMetadata(lifecycleState: "active" | "inactive") {
  return {
    label: "Child",
    lastUpdated: "2026-01-01T00:00:00.000Z",
    lifecycleState,
    executionCwd: FIXTURE_EXECUTION_CWD,
    name: "Child",
    kind: "subagent" as const,
    command: "subagent" as const,
    conversationId: "child-conv",
    launchedFrom: { parentSessionId: "parent", conversationId: "parent-conv", toolUseId: "toolu_child" },
  }
}

function projection(lifecycleState: "active" | "inactive", liveEntry?: ChatSessionEntry) {
  return createSessionDetailProjection({
    projectRoot: FIXTURE_EXECUTION_CWD,
    sessionStore: { get: () => liveEntry },
    manager: { read: async () => metadata(lifecycleState) },
    reader: inMemoryEventReader([]),
  })
}

function summaryIndex(readImmediate: SessionSummaryIndex["readImmediate"]): Pick<SessionSummaryIndex, "readImmediate"> {
  return { readImmediate }
}

describe("history query status projection", () => {
  test("ordinary member output keeps its live tail after durable history without another member's output", async () => {
    const directories = temporaryDirectories()
    const projectRoot = directories("fw-roster-tail-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
    const flow = await publishTestWorkflow(manager)
    const memberId = await startTestWorkflowMember(manager, store, flow)
    const member = await manager.read(memberId)
    if (member?.kind !== "workflow-agent") throw new Error("Missing member")
    const tree = await tryOpenConversationTree({ conversationId: member.conversationId, sessionId: memberId, store: reader, writer })
    if (!tree) throw new Error("Missing member conversation")
    await tree.appendMessage({ kind: "user", content: "Seed prompt.", origin: "system" })
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage("person", true), origin: "system" }, turnEndEntryId(interruptedTurnEnd("person"), "cut"))
    await tree.appendMessage({ kind: "user", content: CONTINUATION_MESSAGES.resumed, origin: "system" })
    await tree.appendMessage({ kind: "assistant", content: [{ type: "text", text: "Durable answer." }] })
    const live = createOutputSession({ updateEntry: () => {}, sessionId: memberId, executionCwd: projectRoot, priorBlocks: projectBlocksFromEntries(await tree.getBranch(), { executionCwd: projectRoot }) })
    tree.getStorage().dispose()
    live.pushSystemMessage("Background work still runs.", 2)
    live.pushUserMessage("Wrap up.", 3, { queued: true })
    live.flush()
    let attached = true
    const history = createSessionDetailProjection({
      projectRoot, reader: store,
      sessionStore: { get: (id) => attached && id === memberId ? { ...entry([]), kind: "workflow-agent", workflowId: flow, operations: null, conversationId: member.conversationId, outputBlocks: live.getBlocks } : undefined },
      manager,
    })
    try {
      const request = { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 10_000 } as const
      const range = await history.outputRange(memberId, request)
      expect(range.kind).toBe("ok")
      if (range.kind !== "ok") throw new Error("Expected output range")
      expect(range.blocks.map((block) => block.kind)).toEqual(["system", "system", "text", "system", "userMessage"])
      expect(range.blocks.filter((block) => block.kind === "system").map(({ message }) => message)).toEqual(["Interrupted", "Resumed", "Background work still runs."])
      expect(range.blocks[3]).toMatchObject({ message: "Background work still runs." })
      attached = false
      const durable = await history.outputRange(memberId, request)
      if (durable.kind !== "ok") throw new Error("Expected output range")
      expect(durable.blocks.map((block) => block.kind)).toEqual(["system", "system", "text"])
    } finally {
      await history.dispose()
      live.dispose()
      store.close()
    }
  })
  test("retained deterministic input admits Resume without a model turn and retirement removes it", async () => {
    const operation: WorkflowLaunchOperation = {
      kind: WORKFLOW_LAUNCH_OPERATION_KIND, version: 1, operationId: "launch",
      parentSessionId: "chat-1", parentConversationId: "conv-1",
      childSessionId: "flow", toolUseId: "launch-tool", parentEntryId: "accepted",
      acceptedAt: "2026-10-02T00:00:00.000Z", initiator: "person",
      launch: { workflowDefinitionId: "work", description: "Do work" },
    }
    let pending = true
    const reader: EventStoreReadSurface = {
      ...inMemoryEventReader([]),
      readInFlight: (_id, kind) => pending && kind === operation.kind
        ? [{ kind: operation.kind, key: operation.operationId, payload: { ...operation }, raw: JSON.stringify(operation) }]
        : [],
    }
    const history = createSessionDetailProjection({
      projectRoot: FIXTURE_EXECUTION_CWD, sessionStore: { get: () => undefined },
      manager: { read: async () => metadata("inactive") }, reader,
    })
    try {
      expect((await history.sessionDetail("chat-1")).view?.row.admittedActions).toContain("chat.resume")
      pending = false
      expect((await history.sessionDetail("chat-1")).view?.row.admittedActions).not.toContain("chat.resume")
    } finally {
      await history.dispose()
    }
  })
  test.each([
    { mode: "indexed", live: false, source: "index", loading: false },
    { mode: "durable summary", live: false, source: "summaries", loading: false },
    { mode: "live summary", live: true, source: "summaries", loading: false },
    { mode: "loading summary", live: true, source: "summaries", loading: true },
  ] as const)("detail budget carries the speed its summary states, and the account facade passes it on without a history read ($mode)", async ({ live, source, loading }) => {
    const totals = { totalCost: 1, totalBilledCost: 0.5, priceUnavailable: false, totalTokens: 42, contextPercent: 20, contextPromptTokens: 200 }
    const row = {
      id: "chat-1", kind: "chat" as const, title: "Chat", lifecycleState: "inactive" as const,
      notices: [], inputMode: { kind: "chat" as const }, lastUpdated: "2026-01-01T00:00:00.000Z",
      executionCwd: FIXTURE_EXECUTION_CWD, totalsLoading: false as const, ...totals, durationMs: 100,
    }
    const history = createSessionDetailProjection({
      projectRoot: FIXTURE_EXECUTION_CWD, manager: { read: async () => metadata("inactive") },
      sessionStore: { get: () => live ? entry([]) : undefined },
      reader: inMemoryEventReader([]),
      ...(source === "index" ? { summaryIndex: summaryIndex(async (sessionIds) => ({
        status: "ready", throughPosition: 1,
        summaries: new Map(sessionIds.map((sessionId) => [sessionId, {
          budget: { ...totals, outputTokens: 10 }, duration: { accumulatedActiveMs: 100 }, diffStats: null,
          averageGenerationTokensPerSecond: 18.2, errors: {},
        }])),
      })) } : { summaries: {
        admit: async () => {},
        view: () => loading ? { totalsLoading: true as const } : { totalsLoading: false as const, row, averageGenerationTokensPerSecond: 18.2 },
        subscribe: () => () => {}, settled: async () => {}, dispose() {},
      } }),
    })
    const f = fixture()
    f.metadata.set("chat-1", durableRow("chat-1", { lifecycleState: "inactive" }))
    let historyReads = 0
    const options = { ...f.options, state: {
      ...f.options.state,
      async readPage(...args: Parameters<typeof f.options.state.readPage>) {
        historyReads++
        return f.options.state.readPage(...args)
      },
    }, history: {
      ...f.options.history,
      sessionDetail: ({ sessionId }: { sessionId: string }) => history.sessionDetail(sessionId),
      // The account answers a budget batch from the background summary that states the same totals.
      sessionSummaryImmediate: async () => ({ rows: [row], errors: [], totalsLoading: loading, generationSpeeds: { "chat-1": 18.2 } }),
    } }
    const client = createProjectControlClient(options)
    try {
      const budget = (await client.query({ type: "sessionDetail", sessionId: "chat-1" })).view?.budget
      if (loading) expect(budget).toEqual({ totalsLoading: true })
      else expect(budget).toEqual({ totalsLoading: false, tokens: 42, cost: 1, billedCost: 0.5, priceUnavailable: false, contextPercent: 20, contextPromptTokens: 200, averageGenerationTokensPerSecond: 18.2 })
      expect((await client.query({ type: "budgetSnapshot", sessionIds: ["chat-1"] })).views[0]?.view).toEqual(budget)
      expect(historyReads).toBe(0)
    } finally {
      await client.close()
      await history.dispose()
    }
  })

  test("one transcript read reads session metadata once", async () => {
    let reads = 0
    const history = createSessionDetailProjection({
      projectRoot: FIXTURE_EXECUTION_CWD,
      sessionStore: { get: () => entry([]) },
      manager: { read: async () => { reads += 1; return metadata("active") } },
      reader: inMemoryEventReader([]),
    })
    const range = { anchor: { kind: "tail" }, maxBlocks: 10, maxBytes: 10_000 } as const
    const counted = async (read: () => Promise<object>): Promise<number> => {
      reads = 0
      await read().catch(() => {})
      return reads
    }
    expect(await counted(() => history.outputWindow("s1", range))).toBe(1)
    expect(await counted(() => history.outputRange("s1", range))).toBe(1)
    expect(await counted(() => history.outputGroupChildren("s1", { groupBlockIds: [], maxBytes: 10_000 }))).toBe(1)
    expect(await counted(() => history.outputBlockBody("s1", { blockId: "missing" }))).toBe(1)
  })

  test("live active history projects its foreground Bash tool call IDs", async () => {
    const history = projection("active", entry(["toolu_1", "toolu_2"]))

    const result = await history.sessionDetail("chat-1")

    expect(result.view?.status.activeForegroundBashToolCallIds).toEqual(["toolu_1", "toolu_2"])
    expect(result.view?.status.settledOutputPosition).toBeNull()
    expect(result.view?.budget).toMatchObject({ priceUnavailable: false })
    await history.dispose()
  })

  test("a live chat with no short title yet sends a row the client's strict schema accepts", async () => {
    const history = projection("active", entry([]))

    const row = (await history.sessionDetail("chat-1")).view?.row

    expect(row).toBeDefined()
    expect(Object.hasOwn(row ?? {}, "shortTitle")).toBe(false)
    expect(() => Schema.decodeUnknownSync(SessionCatalogRowSchema)(row)).not.toThrow()
    await history.dispose()
  })

  test("inactive live and durable history expose no foreground Bash tool call IDs", async () => {
    const inactiveLive = projection("inactive", entry(["toolu_stale"]))
    const durable = projection("inactive")

    expect((await inactiveLive.sessionDetail("chat-1")).view?.status.activeForegroundBashToolCallIds).toEqual([])
    expect((await durable.sessionDetail("chat-1")).view?.status.activeForegroundBashToolCallIds).toEqual([])
    expect((await inactiveLive.sessionDetail("chat-1")).view?.status.settledOutputPosition).toBeNull()
    expect((await durable.sessionDetail("chat-1")).view?.status.settledOutputPosition).toBeNull()
    expect((await inactiveLive.sessionDetail("chat-1")).view?.budget).toMatchObject({ priceUnavailable: false })
    expect((await durable.sessionDetail("chat-1")).view?.budget).toMatchObject({ priceUnavailable: false })
    await inactiveLive.dispose()
    await durable.dispose()
  })


  test("subagent detail keeps durable identity and controls with or without a live entry", async () => {
    let session = subagentMetadata("inactive")
    const live = mock((): ReturnType<typeof entry> | undefined => undefined)
    const read = mock(async () => session)
    const history = createSessionDetailProjection({
      projectRoot: FIXTURE_EXECUTION_CWD,
      sessionStore: { get: () => {
        const current = live()
        return current ? { ...current, kind: "subagent", conversationId: "child-conv" } : undefined
      } },
      manager: { read },
      reader: inMemoryEventReader([]),
    })

    await expect(history.sessionDetail("child-1")).resolves.toMatchObject({
      view: {
        kind: "subagent",
        conversationId: "child-conv",
        row: {
          kind: "subagent",
          parentSessionId: "parent",
          inputMode: { kind: "message" },
          admittedActions: ["session.delete"],
        },
      },
    })
    expect(read).toHaveBeenCalledTimes(1)
    session = { ...session, label: "Renamed child" }
    await expect(history.sessionDetail("child-1")).resolves.toMatchObject({
      view: { row: { title: "Renamed child" } },
    })
    expect(read).toHaveBeenCalledTimes(2)
    live.mockReturnValue(entry([]))
    await expect(history.sessionDetail("child-1")).resolves.toMatchObject({
      view: { row: { title: "Renamed child", lastUpdated: session.lastUpdated } },
    })
    await history.dispose()
  })

  test("durable detail distinguishes loading totals from a settled budget-scope error", async () => {
    const loading = createSessionDetailProjection({
      projectRoot: FIXTURE_EXECUTION_CWD,
      sessionStore: { get: () => undefined },
      manager: { read: async () => metadata("inactive") },
      reader: inMemoryEventReader([]),
      summaryIndex: summaryIndex(async () => ({ status: "loading", throughPosition: 0, summaries: new Map() })),
    })
    await expect(loading.sessionDetail("chat-1")).resolves.toMatchObject({
      view: {
        budget: { totalsLoading: true },
        row: { id: "chat-1" },
      },
    })
    expect((await loading.sessionDetail("chat-1")).view?.row.totalCost).toBeUndefined()

    const failedBudget = createSessionDetailProjection({
      projectRoot: FIXTURE_EXECUTION_CWD,
      sessionStore: { get: () => undefined },
      manager: { read: async () => metadata("inactive") },
      reader: inMemoryEventReader([]),
      summaryIndex: summaryIndex(async (sessionIds) => ({
        status: "ready",
        throughPosition: 4,
        summaries: new Map(sessionIds.map((sessionId) => [sessionId, {
          duration: { accumulatedActiveMs: 9 },
          diffStats: { added: 2, modified: 1, removed: 0 },
          errors: { budget: "damaged usage" },
        }])),
      })),
    })
    await expect(failedBudget.sessionDetail("chat-1")).resolves.toMatchObject({
      view: {
        budget: null,
        row: { totalsLoading: true },
        status: { accumulatedActiveMs: 9 },
      },
    })
    const failedRow = (await failedBudget.sessionDetail("chat-1")).view?.row
    expect(failedRow?.durationMs).toBeUndefined()
    expect(failedRow?.diffStats).toBeUndefined()
    await loading.dispose()
    await failedBudget.dispose()
  })
})

describe("detail of a session a planned replacement cut", () => {
  /** A chat whose last turn ended with the interrupt `by`, holding a
   *  continuation row of a handoff when `owed`. */
  function cutChat(by: TurnInterruption, owed: boolean): EventStoreReadSurface {
    const timestamp = "2026-09-25T00:00:00.000Z"
    const facts: StoredFact[] = [{
      id: "c-1", position: 1, seq: 0, aggregateId: "conversation:conv-1", sessionId: "chat-1", timestamp: 1, actor: "flywheel",
      type: "chat.entries.appended", version: 1,
      payload: { conversationId: "conv-1", entries: [
        { kind: "message", id: "u-1", parentId: null, timestamp, message: { kind: "user", content: "fix it" } },
        { kind: "message", id: turnEndEntryId(interruptedTurnEnd(by), "k"), parentId: "u-1", timestamp, message: { kind: "user", content: interruptedTurnMessage(interruptedTurnEnd(by).pausedBy, true), origin: "system" } },
      ] },
    }]
    const row = { version: 2, sessionId: "chat-1", kind: "chat", handoffId: "handoff-1" }
    return {
      ...inMemoryEventReader(facts),
      readInFlight: (sessionId, kind) => owed && sessionId === "chat-1" && kind === PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND
        ? [{ kind: PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND, key: "chat-1", payload: row, raw: JSON.stringify(row) }]
        : [],
    }
  }

  function detail(reader: EventStoreReadSurface, liveEntry?: ChatSessionEntry) {
    return createSessionDetailProjection({ projectRoot: FIXTURE_EXECUTION_CWD, sessionStore: { get: () => liveEntry }, manager: { read: async () => metadata("active") }, reader })
  }

  test("shows the session waiting while a successor owes it the continuation, whether or not a runner holds it", async () => {
    for (const history of [detail(cutChat("replacement", true)), detail(cutChat("replacement", true), entry([]))]) {
      expect((await history.sessionDetail("chat-1")).view?.status).toMatchObject({ activity: "waiting", settledOutputPosition: null })
      await history.dispose()
    }
  })

  test("shows a person's interrupt, and a cut no successor owes, at rest", async () => {
    const byPerson = detail(cutChat("person", true))
    const unowed = detail(cutChat("replacement", false), entry([]))
    expect((await byPerson.sessionDetail("chat-1")).view?.status.activity).toBe("absent")
    expect((await unowed.sessionDetail("chat-1")).view?.status.activity).toBe("idle")
    await byPerson.dispose()
    await unowed.dispose()
  })
})

type SessionMetadata = NonNullable<Awaited<ReturnType<SessionManager["read"]>>>

describe("controls of a session a successor owes its continuation", () => {
  const tmp = temporaryDirectories()
  const HANDOFF = "handoff-1"

  function openStore() {
    const projectRoot = tmp("fw-owed-detail-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    return { projectRoot, store, writer: asAsyncEventWriter(store) }
  }

  /** Records a turn of `conversationId` and the runtime's planned cut of it. */
  async function cutTurn(store: EventStore, writer: AsyncEventWriter, sessionId: string, conversationId: string): Promise<void> {
    const options = { conversationId, sessionId, store: asAsyncEventReadSurface(store), writer }
    const tree = await tryOpenConversationTree(options) ?? await createConversationTree(options)
    const end = interruptedTurnEnd("replacement")
    await tree.appendMessage({ kind: "user", content: "Do the work.", origin: "human" })
    await tree.appendMessage({ kind: "user", content: interruptedTurnMessage(end.pausedBy, false), origin: "system" }, turnEndEntryId(end, "cut"))
    tree.getStorage().dispose()
  }

  /** The detail a client reads once the service that cut the session has
   *  released it: no runner holds it, and the successor has recovered it
   *  as inactive. */
  async function detailOf(store: EventStore, sessionId: string, session: SessionMetadata): Promise<RuntimeSessionDetailResult> {
    const history = createSessionDetailProjection({ projectRoot: FIXTURE_EXECUTION_CWD, sessionStore: { get: () => undefined }, manager: { read: async () => session }, reader: store })
    try {
      return await history.sessionDetail(sessionId)
    } finally {
      await history.dispose()
    }
  }

  /** The one control every client offers from the detail: the child
   *  viewer, the prompt hint, the step bar, and the web composer. */
  function offered(detail: RuntimeSessionDetailResult) {
    return offeredSessionControls(detail.view?.row, isInterruptible(detail.view?.status)).primary
  }

  test("a child the cut paused offers its Interrupt, not its Resume", async () => {
    const { store, writer } = openStore()
    try {
      await writer.append(prepareSessionFactAppend("child", buildDurableSubagentCreated({
        childSessionId: "child",
        childRunId: "run",
        conversationId: "child-conversation",
        parentSessionId: "parent",
        parentConversationId: "parent-conversation",
        parentToolCallId: "dispatch-1",
        persona: { name: "explorer", kind: "persona" },
        capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "test" },
        admittedModuleIds: [],
        skillsRevision: 1,
        model: "test/model",
        tools: ["read"],
        executionCwd: FIXTURE_EXECUTION_CWD,
        budget: { maxTurns: 10, maxTokens: 0 },
        parentDepth: 0,
        description: "child",
      })))
      await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(store), writer, continuation: { target: { sessionId: "child", kind: "subagent" }, handoffId: HANDOFF, runId: "run" } })
      await cutTurn(store, writer, "child", "child-conversation")
      await writer.append(prepareSessionFactAppend("child", buildSubagentPaused({ childRunId: "run", pausedBy: "runtime" })))

      const detail = await detailOf(store, "child", { ...subagentMetadata("inactive"), conversationId: "child-conversation" })

      expect(detail.view?.status.activity).toBe("waiting")
      expect(detail.view?.row.admittedActions).toContain("subagent.interrupt")
      expect(offered(detail)).toBe("interrupt")
    } finally {
      store.close()
    }
  })

  test("a workflow in the successor admits Interrupt before its duty resumes it", async () => {
    const { projectRoot, store, writer } = openStore()
    try {
      const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
      const workflowId = await publishTestWorkflow(manager)
      const memberId = await startTestWorkflowMember(manager, store, workflowId)
      const member = await manager.read(memberId)
      if (member?.kind !== "workflow-agent") throw new Error("Missing member")
      await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(store), writer, continuation: { target: { workflowId, kind: "workflow" }, handoffId: HANDOFF } })
      await cutTurn(store, writer, memberId, member.conversationId)

      const detail = await createWorkflowDetailReader({ projectRoot, reader: asAsyncEventReadSurface(store), manager })(workflowId)
      expect(detail?.admittedActions).toContain("workflow.interrupt")
    } finally {
      store.close()
    }
  })

  test("a session whose capacity wait no run holds shows the wait with its agent and continue time, with or without an idle runner, until the wait is withdrawn", async () => {
    const { store, writer } = openStore()
    const continuesAt = Date.parse("2026-10-29T02:00:00.000Z")
    const notices = async (liveEntry?: ChatSessionEntry) => {
      const history = createSessionDetailProjection({ projectRoot: FIXTURE_EXECUTION_CWD, sessionStore: { get: () => liveEntry }, manager: { read: async () => metadata("inactive") }, reader: store })
      try {
        return (await history.sessionDetail("chat-1")).view?.row.notices.map(({ title, message, retry, wait }) => ({ title, message, retry, wait }))
      } finally {
        await history.dispose()
      }
    }
    try {
      await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(store), writer, continuation: { target: { sessionId: "chat-1", kind: "chat" }, continuesAt } })
      const waiting = [{ title: "Waiting for model capacity", message: `No provider can run the model of agent "Chat" now. The agent continues at ${new Date(continuesAt).toLocaleString()}.`, retry: undefined, wait: { agentName: "Chat", continuesAt } }]
      expect(await notices()).toEqual(waiting)
      expect(await notices(entry([]))).toEqual(waiting)

      await retirePlannedSessionContinuation({ reader: asAsyncEventReadSurface(store), writer, sessionId: "chat-1", capacity: true })
      expect(await notices()).toEqual([])
      expect(await notices(entry([]))).toEqual([])
    } finally {
      store.close()
    }
  })

  test("a chat an unexpected exit cut while it waited for model capacity shows working and offers its Interrupt, not its Resume, until the wait is withdrawn", async () => {
    const { store, writer } = openStore()
    try {
      const options = { conversationId: "conv-1", sessionId: "chat-1", store: asAsyncEventReadSurface(store), writer }
      const tree = await createConversationTree(options)
      await tree.appendMessage({ kind: "user", content: "Do the work.", origin: "human" })
      tree.getStorage().dispose()
      await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(store), writer, continuation: { target: { sessionId: "chat-1", kind: "chat" }, continuesAt: Date.now() + 60_000 } })

      const waiting = await detailOf(store, "chat-1", metadata("inactive"))
      expect(waiting.view?.status.activity).toBe("waiting")
      expect(waiting.view?.row.admittedActions).toEqual(["chat.interrupt", "session.delete"])
      expect(offered(waiting)).toBe("interrupt")

      await retirePlannedSessionContinuation({ reader: asAsyncEventReadSurface(store), writer, sessionId: "chat-1", capacity: true })
      expect(offered(await detailOf(store, "chat-1", metadata("inactive")))).toBe("resume")
    } finally {
      store.close()
    }
  })

  test("a chat in the successor, before its duty resumes it, offers its Interrupt, not its Resume", async () => {
    const { store, writer } = openStore()
    try {
      await authorizePlannedSessionContinuation({ reader: asAsyncEventReadSurface(store), writer, continuation: { target: { sessionId: "chat-1", kind: "chat" }, handoffId: HANDOFF } })
      await cutTurn(store, writer, "chat-1", "conv-1")

      const detail = await detailOf(store, "chat-1", metadata("inactive"))

      expect(detail.view?.status.activity).toBe("waiting")
      expect(detail.view?.row.admittedActions).toEqual(["chat.interrupt", "session.delete"])
      expect(offered(detail)).toBe("interrupt")
    } finally {
      store.close()
    }
  })
})
