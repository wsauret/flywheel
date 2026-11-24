/** A project store with the sessions a background index reads, and the
 *  owner a runtime composes over it, shared by the index's tests and its
 *  owner's tests. The session records carry only the fields the index reads;
 *  the facts are real. Each test file calls `backgroundIndexFixtures()` once
 *  at its top level, so the hooks that close what a case opened and remove
 *  its directories bind to that file. */
import { afterEach, expect } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type LocalSqliteEventStore, type StoredFact } from "../../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths"
import type { BackgroundCommandRecord } from "../../../../../src/infra/runtime-fact-types"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store"
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work"
import { createBackgroundIndex } from "../../../../../src/orchestration/app-service/background/background-index"
import { composeBackgroundIndex } from "../../../../../src/orchestration/app-service/background/background-index-publisher"
import { buildDurableSubagentCreated, buildSubagentCompleted } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import { openReplyWait, readReplyWaitViews } from "../../../../../src/orchestration/session/control/messaging/reply-waits"
import type { ReplayedSession } from "../../../../../src/orchestration/session/metadata/schemas"
import { createSessionFactWriter } from "../../../../../src/orchestration/session/persistence/session-fact-writer"
import type { ActiveBackgroundCommandView } from "../../../../../src/protocol/status-protocol-types"
import { temporaryDirectories } from "../../../../helpers/directories"
import { createSessionManager } from "../../../../../src/orchestration/session/manager"
import { workflowRunWriter } from "../../../../../src/orchestration/module-catalog"
import { publishTestWorkflow } from "../../session/_session-manager-fixtures"
import { replayWorkflowControl } from "../../../../../src/workflows/vm/fact-fold"
import { replayDecodedWorkflow, transitionDecodedWorkflow } from "../../../../../src/workflows/vm/transition"
import { workflowMembershipReader } from "../../../../../src/orchestration/session/metadata/workflow-membership"
import { loadQueueFromEvents } from "../../../../../src/workflows/view/view-projection"
import { queueFactsForState } from "../../../../../src/workflows/view/view-diff"
import { flattenWorkflowView } from "../../../../../src/workflows/vm/view-flatten"
import { testResolvedAgent, testResolvedAgents, testSkill } from "../../../../helpers/skill-fixtures"
import type { BackgroundWorkRow } from "../../../../../src/protocol/background-index-protocol-types"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types"
import type { SessionStore } from "../../../../../src/orchestration/session-store/types"
import { chatEntry } from "../app-service-doubles"

interface SessionRecord {
  readonly kind: "chat" | "subagent"
  readonly createdAtMs: number
  readonly label: string
  readonly lifecycleState?: "active" | "inactive"
  readonly parent?: { readonly sessionId: string; readonly toolUseId: string }
  readonly children?: readonly string[]
}

type Project = ReturnType<typeof project>

/** A project store and the sessions its index reads. */
function project(temporaryDirectory: (prefix: string) => string) {
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
  // Every session the index read in full, in order.
  const sessionReads: string[] = []
  // A read of a session named here answers what it read only once its gate opens.
  const gates = new Map<string, Promise<void>>()
  // A read of a session named here fails, as a busy or broken store does.
  const refusals = new Set<string>()
  const readSession = async (sessionId: string): Promise<ReplayedSession | undefined> => {
    const read = readRecord(sessionId)
    await gates.get(sessionId)
    return await read
  }
  const readRecord = async (sessionId: string): Promise<ReplayedSession | undefined> => {
    sessionReads.push(sessionId)
    if (refusals.has(sessionId)) throw new Error(`the store refused the read of ${sessionId}`)
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
  const indexOn = (reader: AsyncEventStateReadSurface) => createBackgroundIndex({
    reader,
    readSession,
    liveCommands: (sessionId) => live.get(sessionId) ?? [],
    // The waits the sessions store, read as the runtime's index reads them.
    replyWaits: (sessionId) => readReplyWaitViews(reader, async (id) => await readSession(id) ?? null, sessionId),
  })
  const indexOver = (reader: LocalSqliteEventStore) => indexOn(asAsyncEventReadSurface(reader))
  const facts = (sessionId: string) => createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(store) })
  return {
    store, manager, sessions, live, sessionReads, gates, refusals, readSession, indexOn,
    async workflow(startMember = false) {
      await manager.createChat({ id: "chat", conversationId: "conversation", name: "Chat" })
      await publishTestWorkflow(manager, { id: "workflow", description: "Implement", launchedFrom: { parentSessionId: "chat", conversationId: "conversation", toolUseId: "toolu_workflow" } })
      let memberId: string | undefined
      if (startMember) {
        const advance = async (event: Parameters<typeof transitionDecodedWorkflow>[1]) => {
          const control = replayWorkflowControl(store.read({ aggregateId: "workflow:workflow" }))
          const proposed = transitionDecodedWorkflow(replayDecodedWorkflow(control), event)
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
      return indexOver(open())
    },
    /** Opens a wait of `waiterSessionId` on `addressee`, which the sessions
     *  store and which the readers of `reader`'s waits hear of. */
    async wait(waiterSessionId: string, addressee: { readonly sessionId: string; readonly name: string }, reader: AsyncEventStateReadSurface = asAsyncEventReadSurface(store)): Promise<void> {
      await openReplyWait({
        projectionReader: reader,
        eventWriter: asAsyncEventWriter(store),
        addresseeState: async () => "running",
        lineage: async (sessionId) => [sessionId],
      }, {
        waiter: { sessionId: waiterSessionId, tasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }) },
        addressee,
        toolUseId: `toolu_wait_${waiterSessionId}_${addressee.sessionId}`,
      })
    },
    async command(sessionId: string, record: BackgroundCommandRecord): Promise<void> {
      const writer = facts(sessionId)
      await writer.record({ type: "tool.background_command.recorded", version: 1, actor: "flywheel", payload: record })
      writer.dispose()
    },
    async subagentRun(sessionId: string, status?: "completed" | "partial" | "failed"): Promise<void> {
      const writer = facts(sessionId)
      await writer.transaction(() => {
        void writer.record(buildDurableSubagentCreated({
          childSessionId: sessionId, childRunId: `${sessionId}-run`, conversationId: `conversation-${sessionId}`,
          parentSessionId: "chat", parentConversationId: "conversation", parentToolCallId: `${sessionId}-run`, modelRequestId: "request",
          persona: { name: "worker", kind: "persona" },
          capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: "grant" },
          admittedModuleIds: [], skillsRevision: 1, model: "model", effort: "low", tools: [], executionCwd: dir,
          budget: { maxTurns: 4, maxTokens: 0 }, parentDepth: 0, description: sessionId,
        }))
        if (status) void writer.record(buildSubagentCompleted({ childRunId: `${sessionId}-run`, status, isError: status === "failed", content: "done", durationMs: 10 }))
      })
      writer.dispose()
    },
    /** Ends the run `subagentRun` started for `sessionId`. */
    async endRun(sessionId: string, status: "completed" | "partial" | "failed"): Promise<void> {
      const writer = facts(sessionId)
      await writer.record(buildSubagentCompleted({ childRunId: `${sessionId}-run`, status, isError: status === "failed", content: "done", durationMs: 10 }))
      writer.dispose()
    },
    close: () => { for (const opened of stores) opened.close() },
  }
}

export const byId = (rows: readonly BackgroundWorkRow[]) => [...rows].sort((left, right) => left.id.localeCompare(right.id))

/** The fixtures of one test file, whose stores, owners, and directories
 *  close after each case of that file. */
export function backgroundIndexFixtures() {
  const temporaryDirectory = temporaryDirectories()
  let closing: Array<() => void> = []
  afterEach(() => {
    for (const close of closing) close()
    closing = []
  })

  /** A project whose store and owners close after the test. */
  function closedProject(): Project {
    const fixture = project(temporaryDirectory)
    closing.push(fixture.close)
    return fixture
  }

  /** A chat that ran two commands and started a workflow, whose subagent
   *  started a subagent of its own, and a subagent that finished. */
  async function chatWithWork() {
    const fixture = closedProject()
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

  /** The background index owner a runtime composes over the fixture's store,
   *  read through `reader`, with the live-command word and the keeper's word
   *  in the test's hand. `sessionStore` replaces the store of the fixture's
   *  live commands. The owner hears each batch the store writes, and each batch
   *  `deliver` hands it that the store never wrote. */
  function ownedIndex(fixture: Project, options: {
    readonly reader?: AsyncEventStateReadSurface
    readonly sessionStore?: Pick<SessionStore, "onChange" | "get" | "allIds">
  } = {}) {
    const reader = options.reader ?? asAsyncEventReadSurface(fixture.store)
    let liveChanged: ((changed: ReadonlySet<string> | undefined) => void) | undefined
    let keptChanged: ((sessionId: string) => void) | undefined
    const listeners = new Set<(events: readonly StoredFact[]) => void>()
    const deliver = (events: readonly StoredFact[]): void => { for (const listener of listeners) listener(events) }
    const stopStored = fixture.store.onStored(deliver)
    const patches: RuntimeUiPatchInput[] = []
    const owner = composeBackgroundIndex({
      reader,
      readSession: fixture.readSession,
      onStored: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      publish: (patch) => { patches.push(patch) },
      snapshotPosition: () => patches.length,
      sessionStore: options.sessionStore ?? {
        onChange: (listener) => { liveChanged = listener; return () => {} },
        get: (sessionId) => chatEntry({ activeBackgroundCommands: fixture.live.get(sessionId) ?? [] }),
        allIds: () => [...fixture.live.keys()],
      },
      onKeptChange: (listener) => { keptChanged = listener; return () => {} },
    })
    closing.push(() => {
      owner.dispose()
      stopStored()
    })
    return {
      owner, patches, deliver,
      liveChanged(sessionId: string): void { liveChanged?.(new Set([sessionId])) },
      keptChanged(sessionId: string): void { keptChanged?.(sessionId) },
      /** Opens a wait that this owner hears of. */
      wait: (waiterSessionId: string, addressee: { readonly sessionId: string; readonly name: string }) => fixture.wait(waiterSessionId, addressee, reader),
      /** Waits until the owner advanced by every change so far. */
      async settled(sessionId = "chat"): Promise<void> {
        await Bun.sleep(5)
        await owner.snapshot(sessionId)
      },
    }
  }

  /** A client that follows the chat's index through an owner over the
   *  fixture's store. Its rows are the snapshot with every later patch
   *  applied. */
  async function follow(fixture: Project, reader: AsyncEventStateReadSurface = asAsyncEventReadSurface(fixture.store)) {
    const owned = ownedIndex(fixture, { reader })
    const { owner, patches, settled } = owned
    const snapshot = await owner.snapshot("chat")
    const rows = new Map(snapshot.rows.map((row) => [row.id, row]))
    let applied = snapshot.snapshotPosition
    return {
      settled: () => settled(),
      async rows(): Promise<readonly BackgroundWorkRow[]> {
        await settled()
        for (const { payload } of patches.slice(applied)) {
          if (payload.kind === "background.row.updated") rows.set(payload.row.id, payload.row)
          else if (payload.kind === "background.row.removed") rows.delete(payload.rowId)
          else throw new Error(`unexpected patch ${payload.kind}`)
        }
        applied = patches.length
        return byId([...rows.values()])
      },
      liveChanged: owned.liveChanged,
      wait: owned.wait,
    }
  }

  return { closedProject, chatWithWork, ownedIndex, follow }
}
