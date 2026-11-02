import { describe, expect, test } from "bun:test"
import { Rpc } from "effect/unstable/rpc"
import { asAsyncEventReadSurface, asAsyncEventWriter, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { createRuntimeUiPatchSequencer } from "../../../../src/orchestration/app-service/runtime-ui-patch-sequencer.js"
import { createSessionDetailPublisher } from "../../../../src/orchestration/app-service/session-detail-publisher.js"
import { createSessionDetailReader } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { extractToolContentFact } from "../../../../src/infra/tool-content-extraction.js"
import { childSessionResultFact } from "../../../../src/orchestration/session/child-session-completion.js"
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { projectSessionCatalogRow, readyCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import type { SessionRow } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeSessionDetailResult, RuntimeSessionDetailView } from "../../../../src/protocol/session-detail-protocol-types.js"
import type { RuntimeUiPatch } from "../../../../src/protocol/runtime-ui-protocol-types.js"
import { statusCursor, type StatusView } from "../../../../src/protocol/status-protocol-types.js"
import { budgetCursor } from "../../../../src/protocol/budget-protocol-types.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { durableRow, storedEvents, workflowEntry } from "./_frontend-projection-fixtures.js"
import { phaseBindings, phaseControl } from "../../workflows/vm/_tree-fixtures.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { buildWorkflowControlInitializedFact } from "../../../../src/workflows/vm/session-facts.js"
import { buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts.js"
import { isInterruptible } from "../../../../src/protocol/client/session-controls.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { workflowParentBinding } from "../../../helpers/workflow-parent.js"
import { replayWorkflowControl } from "../../../../src/workflows/vm/fact-fold.js"
import { replayWorkflow, transitionWorkflow } from "../../../../src/workflows/vm/transition.js"
import { workflowMembershipReader } from "../../../../src/orchestration/session/workflow-membership.js"
import { composeWorkflowCompanions } from "../../../../src/workflows/vm/companions.js"
import { readyAttempt } from "../../../../src/workflows/vm/frontier.js"

const RESTING: StatusView = {
  activity: "absent", activityStartedAt: null, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0,
  activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [], waitingOnBackgroundWork: false,
  startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null, replyWaits: [],
}

/** The detail the runtime reads for a session titled `title` now, whose
 *  totals are loading unless `totalTokens` says they are ready. */
function detail(sessionId: string, title: string, totalTokens?: number): RuntimeSessionDetailView {
  const totals = (row: SessionRow) => totalTokens === undefined ? row : readyCatalogRow(row, { totalTokens, totalCost: 0, totalBilledCost: 0, priceUnavailable: false, contextPercent: 0, contextPromptTokens: 0, durationMs: 0 })
  if (sessionId.startsWith("child")) {
    const metadata = durableRow(sessionId, { label: title, conversationId: `conv-${sessionId}` })
    if (metadata.kind !== "chat") throw new Error("Expected chat fixture")
    const row = totals(projectSessionCatalogRow({ ...metadata, kind: "subagent", parentSessionId: "chat", launchedFrom: { parentSessionId: "chat", conversationId: "conv-chat", toolUseId: "launch" } }))
    if (row.kind !== "subagent") throw new Error("Expected subagent detail")
    return { id: sessionId, kind: "subagent", source: "durable", conversationId: `conv-${sessionId}`, budget: null, row, status: RESTING }
  }
  const row = totals(projectSessionCatalogRow(durableRow(sessionId, { label: title, conversationId: `conv-${sessionId}` })))
  if (row.kind !== "chat") throw new Error("Expected chat detail")
  return { id: sessionId, kind: "chat", source: "durable", conversationId: `conv-${sessionId}`, budget: null, row, status: RESTING }
}

/** One account publisher over a fake read whose answers the test sets. */
function publisher(options: { read?: (sessionId: string) => Promise<RuntimeSessionDetailResult>; onStored?: (listener: (facts: readonly StoredFact[]) => void) => () => void; retryDelayMs?: (failures: number) => number; totalsReady?: (sessionId: string) => Promise<void>; publishOnChange?: boolean } = {}) {
  const titles = new Map<string, string>()
  const tokens = new Map<string, number>()
  const reads: string[] = []
  const gates = new Map<string, PromiseWithResolvers<void>>()
  const failing = new Set<string>()
  const failures: unknown[] = []
  const tasks: Promise<void>[] = []
  const stored = storedEvents()
  const bus = createRuntimeUiBus({ publishOnChange: options.publishOnChange ?? false })
  const patches: RuntimeUiPatch[] = []
  bus.addListener((event) => { if (event.type === "patch") patches.push(event.patch) })
  const details = createSessionDetailPublisher({
    state: { onStored: options.onStored ?? stored.onStored },
    bus,
    own: (work) => { tasks.push(work.catch((error: unknown) => { failures.push(error) })) },
    closing: () => false,
    ...(options.retryDelayMs ? { retryDelayMs: options.retryDelayMs } : {}),
    ...(options.totalsReady ? { totalsReady: options.totalsReady } : {}),
    async read(sessionId) {
      reads.push(sessionId)
      await gates.get(sessionId)?.promise
      if (failing.delete(sessionId)) throw new Error(`history read of ${sessionId} timed out`)
      if (options.read) return options.read(sessionId)
      const title = titles.get(sessionId)
      return { view: title === undefined ? null : detail(sessionId, title, tokens.get(sessionId)) }
    },
  })
  return {
    details, titles, tokens, reads, gates, failing, failures, stored, patches,
    /** Every read the publisher started has answered and every patch it published was delivered. */
    async settled() {
      while (tasks.length > 0) await tasks.shift()
      await bus.drain()
    },
    titleOf: (sessionId: string) => patches.filter((patch) => patch.cursor.scope === "session" && patch.cursor.sessionId === sessionId)
      .map((patch) => patch.payload.kind === "session_detail.changed" ? patch.payload.row?.title ?? null : undefined),
  }
}

describe("session detail publisher", () => {
  const tmp = temporaryDirectories()

  test("a step turn end publishes Resume while its concurrent sibling stays interruptible without a status edge", async () => {
    const projectRoot = tmp("detail-workflow-park-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ projectRoot, executionCwd: projectRoot, store })
    const control = phaseControl(true)
    const initialQueue = queueFactsForState(null, flattenWorkflowView(control, phaseBindings(true)))
    await manager.publishWorkflow({
      id: "flow", description: "Flow", workflowDefinitionId: "side-by-side", initialRoles: {},
      launchedFrom: await workflowParentBinding(manager, { workflowDefinitionId: "side-by-side" }),
      facts: [buildContextInputSeededFact("side-by-side", "Work"), buildWorkflowControlInitializedFact({ ...control, aggregateSeq: initialQueue.length + 1 }), ...initialQueue],
    })
    async function commit(event: Parameters<typeof transitionWorkflow>[1]) {
      const before = replayWorkflowControl(store.read({ aggregateId: "workflow:flow" }))
      const next = composeWorkflowCompanions(transitionWorkflow(replayWorkflow(before), event), {
        queue: flattenWorkflowView(before, phaseBindings(true)), resolvedAgents: phaseBindings(true), timestamp: 1, addenda: [],
      })
      if (next.command.kind !== "commit") throw new Error("Expected commit")
      const proposal = next.command.proposal
      const result = await manager.commitWorkflow({ workflowId: "flow", events: proposal.facts.map((fact, index) => ({ ...fact, aggregateId: "workflow:flow", sessionId: "flow", timestamp: 1, ...(index === 0 ? { expectedSeq: proposal.expectedSeq } : {}) })) })
      if (result.kind !== "stored") throw new Error("Unexpected conflict")
    }
    await commit({ type: "START" })
    for (let index = 0; index < 2; index++) {
      const attempt = readyAttempt(replayWorkflowControl(store.read({ aggregateId: "workflow:flow" })))
      if (!attempt) throw new Error("Missing ready sibling")
      await commit({ type: "ATTEMPT_STARTED", attemptId: attempt.id, conversationId: `member-${index}` })
    }
    const members = await workflowMembershipReader(reader).list("flow")
    const siblingMember = members[0]
    const targetMember = members[1]
    if (!siblingMember || !targetMember) throw new Error("Missing concurrent members")
    const read = createSessionDetailReader({
      projectRoot, reader, projectionReader: reader,
      sessionStore: { get: (id) => workflowEntry({ conversationId: id === targetMember.sessionId ? targetMember.conversationId : siblingMember.conversationId, runnerState: "streaming", streamPhase: "generating" }) },
      manager,
    })
    const p = publisher({ onStored: store.onStored, read })
    const sibling = await tryOpenConversationTree({ conversationId: siblingMember.conversationId, sessionId: siblingMember.sessionId, store: reader, writer })
    const tree = await tryOpenConversationTree({ conversationId: targetMember.conversationId, sessionId: targetMember.sessionId, store: reader, writer })
    if (!sibling || !tree) throw new Error("Missing member conversations")
    try {
      await sibling.appendMessage({ kind: "user", content: "Sibling work", origin: "human" })
      const snapshot = await p.details.snapshot(undefined, [targetMember.sessionId, siblingMember.sessionId], async () => {})
      expect(isInterruptible(snapshot.views[0]?.view?.status)).toBe(true)
      expect(snapshot.views[0]?.view?.row.admittedActions).not.toContain("chat.resume")
      p.reads.length = 0
      await tree.appendMessage({ kind: "user", content: "Work", origin: "human" })
      await p.settled()
      expect(p.reads).toEqual([])
      await tree.appendMessage({ kind: "user", content: "Interrupted", origin: "system" }, "itb-paused-person-cut")
      await p.settled()
      const updates = p.patches.flatMap((patch) => patch.payload.kind === "session_detail.changed" ? [patch.payload.row] : [])
      expect(p.reads).toEqual([targetMember.sessionId])
      expect(updates.at(-1)?.admittedActions).toContain("chat.resume")
      expect(isInterruptible((await read(siblingMember.sessionId)).view?.status)).toBe(true)
      expect(p.failures).toEqual([])
    } finally {
      sibling.getStorage().dispose()
      tree.getStorage().dispose()
      p.details.dispose()
      store.close()
    }
  })

  test("plain appends to a held chat and subagent read nothing; a turn end and a rename each read once", async () => {
    const projectRoot = tmp("detail-appends-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const p = publisher({ onStored: store.onStored })
    const chatTree = await createConversationTree({ conversationId: "conv-chat", sessionId: "chat", store: reader, writer })
    const childTree = await createConversationTree({ conversationId: "conv-child", sessionId: "child", store: reader, writer })
    try {
      p.titles.set("chat", "Chat")
      p.titles.set("child", "Child")
      await p.details.snapshot(undefined, ["chat", "child"], async () => {})
      await p.settled()
      p.reads.length = 0
      for (let index = 0; index < 25; index++) {
        await chatTree.appendMessage({ kind: "user", content: `message ${index}`, origin: "human" })
        await chatTree.appendMessage({ kind: "assistant", content: [{ type: "text", text: `answer ${index}` }] })
        await childTree.appendMessage({ kind: "assistant", content: [{ type: "text", text: `work ${index}` }] })
        await childTree.appendMessage({ kind: "user", content: `note ${index}`, origin: "system" })
      }
      await p.settled()
      expect(p.reads).toEqual([])
      await chatTree.appendMessage({ kind: "user", content: "The user interrupted this turn before it finished.", origin: "system" }, "itb-paused-person-cut")
      await p.settled()
      expect(p.reads).toEqual(["chat"])
      p.titles.set("chat", "Renamed")
      p.details.refresh(["chat"])
      await p.settled()
      expect(p.reads).toEqual(["chat", "chat"])
      expect(p.titleOf("chat")).toEqual(["Renamed"])
      expect(p.failures).toEqual([])
    } finally {
      chatTree.getStorage().dispose()
      childTree.getStorage().dispose()
      p.details.dispose()
      store.close()
    }
  })

  test("a parent's result whose large text is stored by reference settles its held child", async () => {
    const projectRoot = tmp("detail-reference-result-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
    const p = publisher({ onStored: store.onStored })
    const writer = createSessionFactWriter({ sessionId: "chat", writer: asAsyncEventWriter(store) })
    try {
      p.titles.set("child", "Child")
      await p.details.snapshot(undefined, ["child"], async () => {})
      await p.settled()
      p.reads.length = 0
      // The producer path: map the runtime event, then move large text to a
      // content row, as every durable writer of a tool result does.
      const extracted = extractToolContentFact(childSessionResultFact({ toolUseId: "launch", parentToolUseId: "code" }, "x".repeat(4096), "ok"))
      const stored = await writer.record(extracted.fact, extracted.contentRows)
      expect(stored?.version).toBe(4)
      await p.settled()
      expect(p.reads).toEqual(["child"])
    } finally {
      writer.dispose()
      p.details.dispose()
      store.close()
    }
  })

  test("a parent's result in a shape this release cannot read reads every held session again", async () => {
    const p = publisher()
    p.titles.set("child", "Child")
    p.titles.set("other", "Other")
    await p.details.snapshot(undefined, ["child", "other"], async () => {})
    await p.settled()
    p.reads.length = 0
    p.stored.emit([{
      id: "future-result", position: 9, seq: 0, timestamp: 1, actor: "flywheel",
      aggregateId: "session:chat", sessionId: "chat", type: "tool.result.recorded", version: 99,
      payload: { toolUseId: "elsewhere" },
    }])
    await p.settled()
    expect(p.reads.toSorted()).toEqual(["child", "other"])
  })

  test("a held workflow is read again when its Resume is rejected for a changed definition", async () => {
    const p = publisher()
    p.titles.set("workflow", "Workflow")
    p.titles.set("other", "Other")
    await p.details.snapshot(undefined, ["workflow", "other"], async () => {})
    await p.settled()
    p.reads.length = 0
    p.stored.emit([{
      id: "drift", position: 9, seq: 3, timestamp: 1, actor: "flywheel",
      aggregateId: "workflow:workflow", sessionId: "workflow", type: "definition.drift_rejected", version: 1,
      payload: { workflowId: "implement", changes: [{ component: "version", recorded: "2", current: "3" }], latestSeq: 2 },
    }])
    await p.settled()
    expect(p.reads).toEqual(["workflow"])
  })

  test("a snapshot taken for a second holder still delivers the change to the first holder", async () => {
    const p = publisher()
    const terminal = new Rpc.ServerClient(1)
    const phone = new Rpc.ServerClient(2)
    p.titles.set("child", "K1")
    await p.details.snapshot(terminal, ["child"], async () => {})
    // Client B snapshots while a rename commits; its read answers the new title.
    p.titles.set("child", "K2")
    p.gates.set("child", Promise.withResolvers())
    const second = p.details.snapshot(phone, ["child"], async () => {})
    await Bun.sleep(0)
    p.details.refresh(["child"])
    p.gates.get("child")?.resolve()
    const snapshot = await second
    await p.settled()
    expect(snapshot.views[0]?.view?.row.title).toBe("K2")
    // Client A's copy is K1, so the change reaches it; B drops it by position.
    const delivered = p.patches.filter((patch) => patch.cursor.scope === "session" && patch.cursor.sessionId === "child")
    expect(delivered.map((patch) => patch.payload.kind === "session_detail.changed" ? patch.payload.row?.title : undefined)).toEqual(["K2"])
    expect(delivered.every((patch) => patch.position <= snapshot.snapshotPosition)).toBe(true)
  })

  test("a session stays held until its last holder lets go, and is never read after that", async () => {
    const p = publisher()
    const terminal = new Rpc.ServerClient(1)
    const phone = new Rpc.ServerClient(2)
    p.titles.set("child", "Child")
    await p.details.snapshot(terminal, ["child"], async () => {})
    await p.details.snapshot(phone, ["child"], async () => {})
    p.details.release(terminal, "child", "read")
    p.reads.length = 0
    p.details.refresh(["child"])
    await p.settled()
    expect(p.reads).toEqual(["child"])
    p.details.drop(phone)
    p.details.refresh(["child"])
    await p.settled()
    expect(p.reads).toEqual(["child"])
  })

  test("a value a new holder read and the bus never published does not hide the next equal publication", async () => {
    const p = publisher({ publishOnChange: true })
    const terminal = new Rpc.ServerClient(1)
    const phone = new Rpc.ServerClient(2)
    p.titles.set("child", "K0")
    await p.details.snapshot(terminal, ["child"], async () => {})
    p.titles.set("child", "K1")
    p.details.refresh(["child"])
    await p.settled()
    p.details.drop(terminal)
    // The new holder's read answers K2, which nothing publishes.
    p.titles.set("child", "K2")
    await p.details.snapshot(phone, ["child"], async () => {})
    p.titles.set("child", "K1")
    p.details.refresh(["child"])
    await p.settled()
    expect(p.titleOf("child")).toEqual(["K1", "K1"])
  })

  test("a failed read publishes its change after its backoff with no later change, and no other change reads it sooner", async () => {
    const p = publisher({ retryDelayMs: () => 20 })
    p.titles.set("chat", "Chat").set("child", "Child")
    await p.details.snapshot(undefined, ["chat", "child"], async () => {})
    p.titles.set("chat", "Renamed chat").set("child", "Renamed child")
    p.failing.add("chat")
    p.reads.length = 0
    p.details.refresh(["chat", "child"])
    await p.settled()
    // The failure never holds back the sessions read after it.
    expect(p.reads).toEqual(["chat", "child"])
    expect(p.titleOf("chat")).toEqual([])
    expect(p.titleOf("child")).toEqual(["Renamed child"])
    // A busy project's stored batches, and a new change of the failed
    // session itself, do not read it before its backoff ends.
    p.details.refresh([])
    p.details.refresh(["chat"])
    await p.settled()
    expect(p.reads).toEqual(["chat", "child"])
    // Nothing else changes, and the change still reaches its holders.
    await Bun.sleep(25)
    await p.settled()
    expect(p.reads).toEqual(["chat", "child", "chat"])
    expect(p.titleOf("chat")).toEqual(["Renamed chat"])
    expect(p.failures).toEqual([])
    p.details.dispose()
  })

  test("letting go of a read detail keeps the detail its holder shows, and the reverse", async () => {
    const p = publisher()
    const terminal = new Rpc.ServerClient(1)
    p.titles.set("chat", "Chat")
    p.details.hold(terminal, ["chat"])
    await p.details.snapshot(terminal, ["chat"], async () => {})
    await p.settled()
    p.details.release(terminal, "chat", "read")
    p.reads.length = 0
    p.details.refresh(["chat"])
    await p.settled()
    expect(p.reads).toEqual(["chat"])

    await p.details.snapshot(terminal, ["chat"], async () => {})
    p.details.release(terminal, "chat", "shown")
    p.reads.length = 0
    p.details.refresh(["chat"])
    await p.settled()
    expect(p.reads).toEqual(["chat"])

    p.details.release(terminal, "chat", "read")
    p.details.refresh(["chat"])
    await p.settled()
    expect(p.reads).toEqual(["chat"])
  })

  test("activity changes inside a turn read nothing, and each edge of what Interrupt can cut reads once", async () => {
    const p = publisher()
    const sequencer = createRuntimeUiPatchSequencer()
    const report = (sessionId: string, activity: StatusView["activity"]) =>
      p.details.apply(sequencer.publish({ cursor: statusCursor(sessionId), payload: { kind: "status.updated", status: { ...RESTING, activity } } }))
    p.titles.set("chat", "Chat").set("child", "Child")
    // The first status of a session is the baseline its edges start from.
    for (const sessionId of ["chat", "child"]) report(sessionId, "idle")
    await p.details.snapshot(undefined, ["chat", "child"], async () => {})
    p.reads.length = 0
    for (const sessionId of ["chat", "child"]) report(sessionId, "thinking")
    await p.settled()
    expect(p.reads).toEqual(["chat", "child"])
    for (const activity of ["generating", "executing_tools", "thinking", "generating"] as const) {
      for (const sessionId of ["chat", "child"]) report(sessionId, activity)
    }
    await p.settled()
    expect(p.reads).toEqual(["chat", "child"])
    for (const sessionId of ["chat", "child"]) report(sessionId, "idle")
    await p.settled()
    expect(p.reads).toEqual(["chat", "child", "chat", "child"])
  })

  test("a held child's provider retry with no activity edge reads it once at each connection edge", async () => {
    const p = publisher()
    const sequencer = createRuntimeUiPatchSequencer()
    const report = (connectionState: StatusView["connectionState"], accumulatedActiveMs = 0) =>
      p.details.apply(sequencer.publish({ cursor: statusCursor("child"), payload: { kind: "status.updated", status: { ...RESTING, activity: "generating", connectionState, accumulatedActiveMs } } }))
    p.titles.set("child", "Child")
    report("connected")
    await p.details.snapshot(undefined, ["child"], async () => {})
    p.reads.length = 0
    // The retry notice lives on the row, so the edge into a retry reads it.
    report("retrying")
    await p.settled()
    expect(p.reads).toEqual(["child"])
    report("retrying", 40)
    await p.settled()
    expect(p.reads).toEqual(["child"])
    report("connected", 40)
    await p.settled()
    expect(p.reads).toEqual(["child", "child"])
  })

  test("a held child read while its totals load is read again once they are ready, and its holders receive them", async () => {
    const ready = Promise.withResolvers<void>()
    const waited: string[] = []
    const p = publisher({ totalsReady: async (sessionId) => { waited.push(sessionId); await ready.promise } })
    p.titles.set("child", "Child")
    const snapshot = await p.details.snapshot(undefined, ["child"], async () => {})
    expect(snapshot.views[0]?.view?.row.totalsLoading).toBe(true)
    // A refresh that reads the row still loading waits for the same totals.
    p.details.refresh(["child"])
    await Bun.sleep(0)
    expect(waited).toEqual(["child"])
    p.tokens.set("child", 42)
    ready.resolve()
    await p.settled()
    const delivered = p.patches.flatMap((patch) => patch.payload.kind === "session_detail.changed" ? [patch.payload.row] : [])
    expect(delivered.map((row) => row?.totalsLoading === false ? row.totalTokens : "loading")).toEqual([42])
    expect(p.reads).toEqual(["child", "child", "child"])
  })

  test("a held row whose totals stay loading after they are ready waits once, then reads only at the backoff or on a real change", async () => {
    // The summary index is ready at once, but the row stays loading, as it
    // does for a live session whose executor summary failed. A defect waits
    // and reads again without end; the fake refuses past five waits so the
    // test ends even then.
    let waits = 0
    const p = publisher({ retryDelayMs: () => 20, totalsReady: async () => { waits += 1; if (waits > 5) throw new Error("waited in a loop") } })
    p.titles.set("child", "Child")
    await p.details.snapshot(undefined, ["child"], async () => {})
    await p.settled()
    expect(waits).toBe(1)
    expect(p.reads).toEqual(["child", "child"])
    // A real change, such as a turn end, still reads the row, because only
    // its totals are late. It arms no new wait.
    p.details.refresh(["child"])
    await p.settled()
    expect(waits).toBe(1)
    expect(p.reads).toEqual(["child", "child", "child"])
    // Each backoff reads it once and arms no new wait.
    await Bun.sleep(25)
    await p.settled()
    expect(waits).toBe(1)
    expect(p.reads).toHaveLength(4)
    // The totals arrive, and the next backoff read delivers them.
    p.tokens.set("child", 42)
    await Bun.sleep(25)
    await p.settled()
    expect(p.reads).toHaveLength(5)
    const delivered = p.patches.flatMap((patch) => patch.payload.kind === "session_detail.changed" ? [patch.payload.row] : [])
    expect(delivered.map((row) => row?.totalsLoading === false ? row.totalTokens : "loading")).toEqual([42])
    // The row is ready, so a later change reads it at once again.
    p.details.refresh(["child"])
    await p.settled()
    expect(p.reads).toHaveLength(6)
    expect(p.failures).toEqual([])
    p.details.dispose()
  })

  test("the executor's totals arriving for a held row that shows them loading reads it once", async () => {
    const p = publisher({ totalsReady: async () => {} })
    const sequencer = createRuntimeUiPatchSequencer()
    const budget = (sessionId: string, totalsLoading: boolean) => p.details.apply(sequencer.publish({
      cursor: budgetCursor(sessionId),
      payload: { kind: "budget.updated", budget: totalsLoading ? { totalsLoading } : { totalsLoading, tokens: 42, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: 0, contextPromptTokens: 0 } },
    }))
    p.titles.set("child", "Child")
    await p.details.snapshot(undefined, ["child"], async () => {})
    await p.settled()
    p.reads.length = 0
    budget("child", true)
    await p.settled()
    expect(p.reads).toEqual([])
    p.tokens.set("child", 42)
    budget("child", false)
    await p.settled()
    expect(p.reads).toEqual(["child"])
    const delivered = p.patches.flatMap((patch) => patch.payload.kind === "session_detail.changed" ? [patch.payload.row] : [])
    expect(delivered.map((row) => row?.totalsLoading === false ? row.totalTokens : "loading")).toEqual([42])
    // Later totals reach clients through the budget domain, not a detail read.
    budget("child", false)
    await p.settled()
    expect(p.reads).toEqual(["child"])
  })

  test("a client's snapshot waits behind at most one background read", async () => {
    const p = publisher()
    for (const sessionId of ["a", "b", "c"]) p.titles.set(sessionId, sessionId.toUpperCase())
    p.titles.set("child", "Child")
    p.gates.set("a", Promise.withResolvers())
    // A restart that shows three tabs reads each one once.
    p.details.hold(undefined, ["a", "b", "c"])
    await Bun.sleep(0)
    expect(p.reads).toEqual(["a"])
    const snapshot = p.details.snapshot(undefined, ["child"], async () => {})
    await Bun.sleep(0)
    p.gates.get("a")?.resolve()
    expect((await snapshot).views[0]?.view?.row.title).toBe("Child")
    expect(p.reads.slice(0, 2)).toEqual(["a", "child"])
    await p.settled()
    expect(p.reads).toEqual(["a", "child", "b", "c"])
  })
})
