import { describe, expect, it } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncEventStateReadSurface, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { createWorkflowLiveProtocolProjection } from "../../../../../src/orchestration/modules/workflows/live-protocol.js"
import { createWorkflowRunWriter } from "../../../../../src/orchestration/modules/workflows/run-facts.js"
import { createStartedAgentStates, type StartedAgentStates } from "../../../../../src/orchestration/workflow-host/started-agent-states.js"
import type { StartedAgent } from "../../../../../src/workflows/vm/host-commit-controller.js"
import { tryOpenConversationTree } from "../../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { interruptedTurnMessage, turnEndEntryId } from "../../../../../src/orchestration/session/conversation/turn-end-record.js"
import { workflowMembershipReader } from "../../../../../src/orchestration/session/workflow-membership.js"
import type { SessionEntry } from "../../../../../src/orchestration/session-store/types.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import type { WorkflowLiveView } from "../../../../../src/protocol/workflow-view-protocol-types.js"
import { foldWorkflowLiveChange } from "../../../../../src/protocol/modules/workflows.js"
import { recoverWorkflowControl } from "../../../../../src/workflows/vm/recovery.js"
import { WORKFLOW_ROOT_FACT_TYPES } from "../../../../../src/workflows/workflow-root.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { countStateRequests } from "../../../../helpers/state-requests.js"
import { commitWorkflowEvent, publishWorkerAttempt } from "../../workflow-host/_workflow-host-fixtures.js"

const temporary = temporaryDirectories()

/** The live projection with the agent owner that production composes beside it. */
function liveProjection(deps: Omit<Parameters<typeof createWorkflowLiveProtocolProjection>[0], "agents">) {
  const agents = createStartedAgentStates({ reader: deps.reader, onStored: deps.onStored })
  const projection = createWorkflowLiveProtocolProjection({ ...deps, agents })
  return { ...projection, dispose() { projection.dispose(); agents.dispose() } }
}

/** A stored-fact feed that a test drives, with every listener it subscribed. */
function storedFeed() {
  const listeners = new Set<(events: readonly StoredFact[]) => void>()
  return {
    onStored: (listener: (events: readonly StoredFact[]) => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    stored: (events: readonly StoredFact[]) => { for (const listener of listeners) listener(events) },
  }
}

/** The view that a client holds after it applies each patch published
 *  since the last call to the view it held, as the protocol's fold does. */
function clientView(published: readonly RuntimeUiPatchInput[], start: WorkflowLiveView | null) {
  let view = start
  let applied = 0
  return () => {
    for (; applied < published.length; applied++) {
      const payload = published[applied]!.payload
      if (payload.kind === "workflow_live.removed") view = null
      else if (payload.kind === "workflow_live.changed") view = foldWorkflowLiveChange(view, payload)
      else throw new Error(`Expected a workflow live patch, got ${payload.kind}`)
    }
    return view
  }
}

/** The aggregate of every durable read through `reader`, or `*` for a read across aggregates. */
function countingReader(reader: AsyncEventStateReadSurface) {
  const reads: string[] = []
  return {
    reads,
    reader: {
      ...reader,
      readSlice: (query, tolerant) => { reads.push(query.aggregateId ?? "*"); return reader.readSlice(query, tolerant) },
      readPage: (query, upper, after, tolerant, content) => { reads.push(query.aggregateId ?? "*"); return reader.readPage(query, upper, after, tolerant, content) },
      readLatestByAggregateAndTypes: (aggregateId, types) => { reads.push(aggregateId); return reader.readLatestByAggregateAndTypes(aggregateId, types) },
    } satisfies AsyncEventStateReadSurface,
  }
}

describe("workflow live protocol projection", () => {
  it("reads durable state only for the facts that can change it", async () => {
    const dir = temporary("flywheel-workflow-live-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    try {
      const base = asAsyncEventReadSurface(store)
      const { member } = await publishWorkerAttempt({
        projectRoot: dir, reader: base, writer: asAsyncEventWriter(store), workflowId: "wf",
        attemptId: "a", conversationId: "conv-a", siblings: [{ attemptId: "b", conversationId: "conv-b" }],
      })
      const { reader, reads } = countingReader(base)
      let storeChanged: (changed: ReadonlySet<string> | undefined) => void = () => {}
      const { onStored, stored } = storedFeed()
      const published: RuntimeUiPatchInput[] = []
      const projection = liveProjection({
        reader,
        sessionStore: { get: () => undefined, onChange: (listener) => { storeChanged = listener; return () => {} } },
        onStored,
        publish: (patch) => { published.push(patch); return undefined },
      })
      const fact = (aggregateId: string): StoredFact => ({ ...store.read({ limit: 1 })[0]!, aggregateId, type: "chat.entries.appended" })
      try {
        expect((await projection.snapshot("wf"))?.agents.map(({ attemptId }) => attemptId).toSorted()).toEqual(["a", "b"])

        reads.length = 0
        storeChanged(new Set(["unrelated"]))
        storeChanged(new Set([member.sessionId]))
        stored([fact("conversation:unrelated"), fact("workflow:other")])
        await projection.settled()
        expect(reads).toEqual([])

        stored([fact("conversation:conv-a")])
        await projection.settled()
        expect(reads.length).toBeGreaterThan(0)
        expect(new Set(reads)).toEqual(new Set(["conversation:conv-a"]))

        reads.length = 0
        stored([fact("workflow:wf")])
        await projection.settled()
        expect(reads).toContain("workflow:wf")
        expect(reads.filter((aggregateId) => aggregateId.startsWith("conversation:"))).toEqual([])
        expect(published).toEqual([])
      } finally {
        projection.dispose()
      }
    } finally {
      store.close()
    }
  })

  it("installs a snapshot in order with the refresh work, so the snapshot and the patches after it reach the current state", async () => {
    const dir = temporary("flywheel-workflow-live-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    const reader = asAsyncEventReadSurface(store)
    const writer = asAsyncEventWriter(store)
    const { member } = await publishWorkerAttempt({ projectRoot: dir, reader, writer, workflowId: "wf", attemptId: "a", conversationId: "conv-a" })
    const owner = createStartedAgentStates({ reader, onStored: store.onStored })
    /** Holds the next read of conversations once it has read, until the test releases it. */
    let gate: { readonly reached: PromiseWithResolvers<void>; readonly release: PromiseWithResolvers<void> } | undefined
    const published: RuntimeUiPatchInput[] = []
    const projection = createWorkflowLiveProtocolProjection({
      reader, onStored: store.onStored, sessionStore: { get: () => undefined, onChange: () => () => {} },
      agents: {
        ...owner,
        conversations: async (...args) => {
          const answer = await owner.conversations(...args)
          const held = gate
          gate = undefined
          if (held) { held.reached.resolve(); await held.release.promise }
          return answer
        },
      },
      publish: (patch) => { published.push(patch); return undefined },
    })
    try {
      expect((await projection.snapshot("wf"))?.agents.map(({ operations }) => operations)).toEqual([0])
      const held = { reached: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
      gate = held
      // A client subscribes again: it starts from the snapshot and folds each patch published after it.
      const snapshot = projection.snapshot("wf").then((view) => ({ view, from: published.length }))
      await held.reached.promise
      // The conversation moves after the snapshot read it and before the snapshot is installed.
      const tree = await tryOpenConversationTree({ conversationId: "conv-a", sessionId: member.sessionId, store: reader, writer })
      await tree!.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "u1", name: "bash", input: {} }] })
      held.release.resolve()
      const { view, from } = await snapshot
      await projection.settled()
      const client = clientView(published.slice(from), view)()
      const fresh = await projection.snapshot("wf")
      expect(fresh?.agents.map(({ operations }) => operations)).toEqual([1])
      expect(client).toEqual(fresh)
    } finally {
      projection.dispose()
      owner.dispose()
      store.close()
    }
  })

  it("keeps every agent that settled while one read of the started agents waited, with no live operations", async () => {
    const dir = temporary("flywheel-workflow-live-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    const reader = asAsyncEventReadSurface(store)
    const { manager, workflow } = await publishWorkerAttempt({
      projectRoot: dir, reader, writer: asAsyncEventWriter(store), workflowId: "wf",
      attemptId: "a", conversationId: "conv-a", siblings: [{ attemptId: "b", conversationId: "conv-b" }, { attemptId: "c", conversationId: "conv-c" }],
    })
    /** Holds every read of the workflow's facts while it is set. */
    let gate: PromiseWithResolvers<void> | undefined
    const gated = async <T,>(aggregateId: string | undefined, read: () => Promise<T>) => {
      if (aggregateId === "workflow:wf") await gate?.promise
      return await read()
    }
    const owner = createStartedAgentStates({
      reader: {
        ...reader,
        readSlice: (query, tolerant) => gated(query.aggregateId, () => reader.readSlice(query, tolerant)),
        readPage: (query, upper, after, tolerant, content) => gated(query.aggregateId, () => reader.readPage(query, upper, after, tolerant, content)),
      },
      onStored: store.onStored,
    })
    const published: RuntimeUiPatchInput[] = []
    // Each member's session entry outlives its attempt and still counts the
    // operations it ran, which only a started agent publishes.
    const projection = createWorkflowLiveProtocolProjection({
      reader, agents: owner, onStored: store.onStored, sessionStore: { get: () => ({ outputBlocks: () => [], runnerState: "streaming", streamPhase: "waiting", accumulatedActiveMs: 0, streamingStartedAt: null, operations: 7 }), onChange: () => () => {} },
      publish: (patch) => { published.push(patch); return undefined },
    })
    try {
      const client = clientView(published, await projection.snapshot("wf"))
      gate = Promise.withResolvers()
      for (const attemptId of ["a", "b", "c"]) {
        await commitWorkflowEvent({ manager, projectionReader: reader }, "wf", workflow, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId, conversationId: `conv-${attemptId}`, handoff: { summary: "done" }, reassessment: null } })
      }
      gate.resolve()
      await projection.settled()
      expect(client()?.agents.map(({ attemptId, operations }) => [attemptId, operations])).toEqual([["a", undefined], ["b", undefined], ["c", undefined]])
      expect(client()).toEqual(await projection.snapshot("wf"))
    } finally {
      projection.dispose()
      owner.dispose()
      store.close()
    }
  })

  it("applies a settlement that follows a commit that started and settled no agent", async () => {
    const dir = temporary("flywheel-workflow-live-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    const reader = asAsyncEventReadSurface(store)
    const { manager, workflow } = await publishWorkerAttempt({
      projectRoot: dir, reader, writer: asAsyncEventWriter(store), workflowId: "wf",
      attemptId: "a", conversationId: "conv-a", siblings: [{ attemptId: "b", conversationId: "conv-b" }],
    })
    const published: RuntimeUiPatchInput[] = []
    const projection = liveProjection({
      reader, onStored: store.onStored, sessionStore: { get: () => undefined, onChange: () => () => {} },
      publish: (patch) => { published.push(patch); return undefined },
    })
    try {
      const client = clientView(published, await projection.snapshot("wf"))
      expect(await createWorkflowRunWriter(reader, manager.commitWorkflow).update("wf", (state) => ({ ...state, name: "renamed" }), "user")).toBe(true)
      await projection.settled()
      await commitWorkflowEvent({ manager, projectionReader: reader }, "wf", workflow, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: "a", conversationId: "conv-a", handoff: { summary: "done" }, reassessment: null } })
      await projection.settled()
      expect(client()?.agents.map(({ attemptId, operations }) => [attemptId, operations])).toEqual([["a", undefined], ["b", 0]])
      expect(client()).toEqual(await projection.snapshot("wf"))
    } finally {
      projection.dispose()
      store.close()
    }
  })

  it("applies a settlement that lands while the first snapshot of a workflow loads", async () => {
    const dir = temporary("flywheel-workflow-live-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    const reader = asAsyncEventReadSurface(store)
    const { manager, workflow } = await publishWorkerAttempt({
      projectRoot: dir, reader, writer: asAsyncEventWriter(store), workflowId: "wf",
      attemptId: "a", conversationId: "conv-a", siblings: [{ attemptId: "b", conversationId: "conv-b" }],
    })
    const owner = createStartedAgentStates({ reader, onStored: store.onStored })
    const reached = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let first = true
    const published: RuntimeUiPatchInput[] = []
    const projection = createWorkflowLiveProtocolProjection({
      reader, onStored: store.onStored, sessionStore: { get: () => undefined, onChange: () => () => {} },
      agents: {
        ...owner,
        conversations: async (...args) => {
          const answer = await owner.conversations(...args)
          if (first) { first = false; reached.resolve(); await release.promise }
          return answer
        },
      },
      publish: (patch) => { published.push(patch); return undefined },
    })
    try {
      const snapshot = projection.snapshot("wf").then((view) => ({ view, from: published.length }))
      await reached.promise
      await commitWorkflowEvent({ manager, projectionReader: reader }, "wf", workflow, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: "a", conversationId: "conv-a", handoff: { summary: "done" }, reassessment: null } })
      await owner.settled()
      release.resolve()
      const { view, from } = await snapshot
      await projection.settled()
      const client = clientView(published.slice(from), view)()
      expect(client?.agents.map(({ attemptId, operations }) => [attemptId, operations])).toEqual([["a", undefined], ["b", 0]])
      expect(client).toEqual(await projection.snapshot("wf"))
    } finally {
      release.resolve()
      projection.dispose()
      owner.dispose()
      store.close()
    }
  })

  it("reads and scans only what a workflow commit moved, whatever the agents started before it", async () => {
    /** What one commit that settles one agent costs the view, with `siblingCount` other agents started. */
    const commitCost = async (siblingCount: number) => {
      const dir = temporary("flywheel-workflow-live-")
      const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
      try {
        const base = asAsyncEventReadSurface(store)
        const { manager, workflow } = await publishWorkerAttempt({
          projectRoot: dir, reader: base, writer: asAsyncEventWriter(store), workflowId: "wf",
          attemptId: "a", conversationId: "conv-a", siblings: Array.from({ length: siblingCount }, (_, index) => ({ attemptId: `s${index}`, conversationId: `conv-s${index}` })),
        })
        const returned: StoredFact[] = []
        const keep = (facts: readonly (StoredFact | Error)[]) => { for (const fact of facts) if (!(fact instanceof Error)) returned.push(fact) }
        const reader: AsyncEventStateReadSurface = {
          ...base,
          readSlice: async (query, tolerant) => { const slice = await base.readSlice(query, tolerant); keep(slice.facts); return slice },
          readPage: async (query, upper, after, tolerant, content) => { const page = await base.readPage(query, upper, after, tolerant, content); keep(page.facts); return page },
        }
        const { onStored, stored } = storedFeed()
        let entryReads = 0
        const published: RuntimeUiPatchInput[] = []
        const owner = createStartedAgentStates({ reader, onStored })
        const { agents, scans } = scanCountingAgents(owner)
        const projection = createWorkflowLiveProtocolProjection({
          reader, agents, onStored,
          sessionStore: { get: () => { entryReads++; return undefined }, onChange: () => () => {} },
          publish: (patch) => { published.push(patch); return undefined },
        })
        try {
          expect((await projection.snapshot("wf"))?.agents).toHaveLength(siblingCount + 1)
          entryReads = 0
          scans.count = 0
          // Every agent's start commits to the workflow while the facts of every
          // earlier start are there: the started agents advance from the facts
          // after the last read, so no commit reads the run's history again.
          returned.length = 0
          const before = store.read({ aggregateId: "workflow:wf" }).at(-1)!.position
          await commitWorkflowEvent({ manager, projectionReader: base }, "wf", workflow, { type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: "a", conversationId: "conv-a", handoff: { summary: "done" }, reassessment: null } })
          stored(store.read({ aggregateId: "workflow:wf", afterPosition: before }))
          await projection.settled()
          // The newest root bounds the queue's family: one fact, whatever the history.
          const roots: readonly string[] = WORKFLOW_ROOT_FACT_TYPES
          expect(returned.filter((fact) => fact.aggregateId === "workflow:wf" && fact.position <= before && !roots.includes(fact.type)).map(({ type }) => type)).toEqual([])
          // The commit settled one agent: the view composes that member alone,
          // reads no conversation, and publishes that agent without live operations.
          expect(returned.filter((fact) => fact.aggregateId.startsWith("conversation:"))).toEqual([])
          expect(published.map(({ payload }) => payload.kind === "workflow_live.changed" ? payload.agents.map(({ attemptId, operations }) => [attemptId, operations]) : payload.kind)).toEqual([[["a", undefined]]])
          return { entryReads, memberScans: scans.count }
        } finally {
          projection.dispose()
          owner.dispose()
        }
      } finally {
        store.close()
      }
    }
    const one = await commitCost(1)
    // One read decides whether the member reads its recorded time, one composes it.
    expect(one.entryReads).toBe(2)
    expect(await commitCost(6)).toEqual(one)
  })

  it("publishes the view that each persisted transition produces", async () => {
    const dir = temporary("flywheel-workflow-live-")
    const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
    try {
      const reader = asAsyncEventReadSurface(store)
      const writer = asAsyncEventWriter(store)
      const { manager, workflow } = await publishWorkerAttempt({
        projectRoot: dir, reader, writer, workflowId: "wf",
        attemptId: "a", conversationId: "conv-a", siblings: [{ attemptId: "b", conversationId: "conv-b" }], retry: { max: 2, stuck: false },
      })
      const members = workflowMembershipReader(reader)
      const sessionOf = async (attemptId: string) => (await members.attempt("wf", attemptId))!.sessionId
      const [sessionA, sessionB] = [await sessionOf("a"), await sessionOf("b")]
      const conversation = async (sessionId: string, conversationId: string) => {
        const tree = await tryOpenConversationTree({ conversationId, sessionId, store: reader, writer })
        if (!tree) throw new Error(`Missing conversation ${conversationId}`)
        return tree
      }
      const toolUse = (id: string) => ({ kind: "assistant" as const, content: [{ type: "tool_use" as const, id, name: "bash", input: {} }] })
      const entries = new Map<string, Pick<SessionEntry, "outputBlocks" | "runnerState" | "streamPhase" | "accumulatedActiveMs" | "streamingStartedAt">>()
      let storeChanged: (changed: ReadonlySet<string> | undefined) => void = () => {}
      const published: RuntimeUiPatchInput[] = []
      const projection = liveProjection({
        reader,
        sessionStore: { get: (id) => entries.get(id), onChange: (listener) => { storeChanged = listener; return () => {} } },
        onStored: store.onStored,
        publish: (patch) => { published.push(patch); return undefined },
      })
      let client: () => WorkflowLiveView | null = () => null
      const latest = async (): Promise<WorkflowLiveView | null> => {
        await projection.settled()
        return client()
      }
      const agents = (view: WorkflowLiveView | null) => Object.fromEntries((view?.agents ?? []).map(({ attemptId, operations, interruptedAt, revision }) => [attemptId, { operations, revision, ...(interruptedAt === undefined ? {} : { interruptedAt }) }]))
      try {
        const snapshot = await projection.snapshot("wf")
        client = clientView(published, snapshot)
        expect(agents(snapshot)).toEqual({ a: { operations: 0, revision: 0 }, b: { operations: 0, revision: 0 } })

        const treeA = await conversation(sessionA, "conv-a")
        await treeA.appendMessage(toolUse("a-1"))
        expect(agents(await latest())).toEqual({ a: { operations: 1, revision: 0 }, b: { operations: 0, revision: 0 } })

        await treeA.appendMessage({ kind: "user", content: interruptedTurnMessage("person", true), origin: "system" }, turnEndEntryId({ reason: "paused", pausedBy: "person" }, "k"))
        const interrupted = agents(await latest()).a!
        expect(interrupted).toEqual({ operations: 1, revision: 0, interruptedAt: expect.any(Number) })

        // A fact can reach the projection before the runner opens the runtime
        // entry; the entry that opens later composes with the durable count.
        const treeB = await conversation(sessionB, "conv-b")
        await treeB.appendMessage(toolUse("b-1"))
        expect(agents(await latest()).b).toEqual({ operations: 1, revision: 0 })
        let readsOfA = 0
        entries.set(sessionA, { accumulatedActiveMs: 0, streamingStartedAt: 1, runnerState: "streaming", streamPhase: "waiting", outputBlocks: () => { readsOfA++; return [] } })
        storeChanged(new Set([sessionA]))
        await projection.settled()
        // A member that a runner holds reads its session's clock from its entry.
        expect((await latest())?.agents.find(({ sessionId }) => sessionId === sessionA)).toMatchObject({ runtimeActivity: "waiting", duration: 0, activeStartedAt: 1 })
        const beforeFirstCall = published.length
        entries.get(sessionA)!.streamPhase = "thinking"
        storeChanged(new Set([sessionA]))
        expect((await latest())?.agents.find(({ sessionId }) => sessionId === sessionA)).toMatchObject({ runtimeActivity: "thinking" })
        expect(published).toHaveLength(beforeFirstCall + 1)
        const composedA = readsOfA
        entries.set(sessionB, { accumulatedActiveMs: 0, streamingStartedAt: 1, runnerState: "streaming", streamPhase: "tool_executing", outputBlocks: () => [{ kind: "tool", id: "b-1", name: "bash", presentation: { name: "Bash", detail: "echo" }, sentence: { name: "Ran", detail: "echo" }, timestamp: 1, status: "pending" }] })
        storeChanged(new Set([sessionB]))
        const afterCall = await latest()
        expect(afterCall?.agents.find(({ sessionId }) => sessionId === sessionB)).toMatchObject({ activity: { name: "Ran", detail: "echo" } })
        const live = agents(afterCall).b
        expect(live?.operations).toBe(1)
        expect(live?.revision).toBeGreaterThan(0)
        const afterFirstCall = published.length
        entries.get(sessionB)!.streamPhase = "thinking"
        storeChanged(new Set([sessionB]))
        await projection.settled()
        expect(published).toHaveLength(afterFirstCall)
        entries.set(sessionB, { accumulatedActiveMs: 0, streamingStartedAt: 1, runnerState: "streaming", streamPhase: "generating", outputBlocks: () => [{ kind: "tool", id: "b-1", name: "bash", presentation: { name: "Bash", detail: "echo" }, sentence: { name: "Ran", detail: "echo" }, timestamp: 1, status: "completed" }] })
        storeChanged(new Set([sessionB]))
        expect(agents(await latest()).b?.revision).toBe(live!.revision + 1)
        expect(published).toHaveLength(afterFirstCall + 1)
        // A change of one member composes that member alone.
        expect(readsOfA).toBe(composedA)
        entries.delete(sessionA)
        storeChanged(new Set([sessionA]))
        entries.delete(sessionB)
        storeChanged(new Set([sessionB]))

        // A retry runs the agent in a new attempt and conversation, which
        // holds none of the failed one's operations.
        const commit = (event: Parameters<typeof commitWorkflowEvent>[3]) => commitWorkflowEvent({ manager, projectionReader: reader }, "wf", workflow, event)
        await commit({ type: "ATTEMPT_FAILED", failure: { attemptId: "b", kind: "handoff", reason: "missing summary", conversationId: "conv-b" } })
        const recovered = recoverWorkflowControl((await reader.readSlice({ aggregateId: "workflow:wf" }, true)).facts)
        if (!recovered.executable) throw new Error("Expected executable workflow")
        const retry = recovered.control.attempts.find(({ id, state }) => id !== "a" && id !== "b" && state._tag !== "failed")!.id
        await commit({ type: "ATTEMPT_STARTED", attemptId: retry, conversationId: "conv-b2" })
        const sessionRetry = await sessionOf(retry)
        // The failed attempt keeps its line with no live operations.
        expect(agents(await latest())).toEqual({ a: interrupted, b: { operations: undefined, revision: 0 }, [retry]: { operations: 0, revision: 0 } })
        const treeB2 = await conversation(sessionRetry, "conv-b2")
        await treeB2.appendMessage(toolUse("b2-1"))
        await treeB2.appendMessage(toolUse("b2-2"))
        expect(agents(await latest())[retry]).toEqual({ operations: 2, revision: 0 })

        const plan = await manager.admitDeletion(sessionRetry)
        for (const target of plan.targets) await manager.finalizeDeletionTarget(target)
        expect(Object.keys(agents(await latest()))).toEqual(["a", "b"])

        // The patches carry the agents that moved, and the client that folds
        // them holds the view that a new read composes.
        expect(await latest()).toEqual(await projection.snapshot("wf"))

        await commit({ type: "ATTEMPT_SUCCEEDED", outcome: { attemptId: "a", conversationId: "conv-a", handoff: { summary: "done" }, reassessment: null } })
        expect(agents(await latest())).toEqual({ a: { operations: undefined, revision: 0 }, b: { operations: undefined, revision: 0 } })
        // A settled agent that no runner holds states the active time that its
        // session recorded, and follows a later record.
        expect((await latest())?.agents.find(({ attemptId }) => attemptId === "a")).toMatchObject({ duration: 0 })
        store.append({ aggregateId: `session:${sessionA}`, sessionId: sessionA, type: "session.duration.recorded", version: 1, actor: "flywheel", timestamp: Date.now(), payload: { accumulatedActiveMs: 4_200 } })
        expect((await latest())?.agents.find(({ attemptId }) => attemptId === "a")).toMatchObject({ duration: 4_200 })
        expect(await latest()).toEqual(await projection.snapshot("wf"))
      } finally {
        projection.dispose()
      }
    } finally {
      store.close()
    }
  })

  it("reads no tree of a running agent and composes and publishes only the agent that moved, whatever the number of agents", async () => {
    const HISTORY = 12
    const toolUse = (id: string) => ({ kind: "assistant" as const, content: [{ type: "tool_use" as const, id, name: "bash", input: {} }] })
    /** The most facts that one conversation fact made the projection read,
     *  and the most state requests (durable reads and live entry reads) that
     *  one store change and one conversation fact made, over the second half
     *  of 2M changes spread round robin over M agents. */
    const workPerChange = async (agentCount: number) => {
      const dir = temporary("flywheel-workflow-live-")
      const store = createSqliteEventStore(resolveEventStoreDbFile(dir))
      try {
        const base = asAsyncEventReadSurface(store)
        const writer = asAsyncEventWriter(store)
        const bindings = Array.from({ length: agentCount }, (_, index) => ({ attemptId: `a${index}`, conversationId: `conv-${index}` }))
        await publishWorkerAttempt({ projectRoot: dir, reader: base, writer, workflowId: "wf", ...bindings[0]!, siblings: bindings.slice(1) })
        const members = workflowMembershipReader(base)
        const agents = await Promise.all(bindings.map(async ({ attemptId, conversationId }) => {
          const sessionId = (await members.attempt("wf", attemptId))!.sessionId
          const tree = await tryOpenConversationTree({ conversationId, sessionId, store: base, writer })
          if (!tree) throw new Error(`Missing conversation ${conversationId}`)
          for (let call = 0; call < HISTORY; call++) await tree.appendMessage(toolUse(`${attemptId}-${call}`))
          return { attemptId, sessionId, tree }
        }))
        // Every agent runs, and its attempt counts its operations on its entry.
        let composed = 0
        const entries = new Map<string, Pick<SessionEntry, "runnerState" | "streamPhase" | "outputBlocks" | "accumulatedActiveMs" | "streamingStartedAt"> & { operations: number }>(agents.map(({ sessionId }) => [sessionId, { runnerState: "streaming", streamPhase: "waiting", accumulatedActiveMs: 0, streamingStartedAt: 1, outputBlocks: () => { composed++; return [] }, operations: HISTORY }]))
        const { counted, reader: factReader } = factCountingReader(base)
        const requests = countStateRequests(factReader)
        let entryReads = 0
        /** The durable reads and the live entry reads since the last call. */
        const stateRequests = () => {
          const taken = requests.take().length + entryReads
          entryReads = 0
          return taken
        }
        let storeChanged: (changed: ReadonlySet<string> | undefined) => void = () => {}
        const published: RuntimeUiPatchInput[] = []
        const projection = liveProjection({
          reader: requests.reader,
          sessionStore: { get: (id) => { entryReads++; return entries.get(id) }, onChange: (listener) => { storeChanged = listener; return () => {} } },
          onStored: store.onStored,
          publish: (patch) => { published.push(patch); return undefined },
        })
        let client: () => WorkflowLiveView | null = () => null
        const operations = () => Object.fromEntries((client()?.agents ?? []).map((agent) => [agent.attemptId, agent.operations]))
        try {
          client = clientView(published, await projection.snapshot("wf"))
          const perChange: number[] = []
          const storeRequests: number[] = []
          const factRequests: number[] = []
          for (let change = 0; change < 2 * agentCount; change++) {
            const agent = agents[change % agentCount]!
            const entry = entries.get(agent.sessionId)!
            entry.operations += 1
            const before = counted.facts
            const [composedBefore, publishedBefore] = [composed, published.length]
            entry.streamPhase = change % 2 === 0 ? "thinking" : "generating"
            stateRequests()
            storeChanged(new Set([agent.sessionId]))
            await projection.settled()
            storeRequests.push(stateRequests())
            expect(counted.facts).toBe(before)
            // A change of one member composes that member and publishes it alone.
            expect(composed - composedBefore).toBe(1)
            expect(published.slice(publishedBefore).map(({ payload }) => payload.kind === "workflow_live.changed" ? payload.agents.map(({ attemptId }) => attemptId) : [])).toEqual([[agent.attemptId]])
            await agent.tree.appendMessage(toolUse(`${agent.attemptId}-live-${change}`))
            await projection.settled()
            factRequests.push(stateRequests())
            perChange.push(counted.facts - before)
          }
          expect(operations()).toEqual(Object.fromEntries(agents.map(({ attemptId }) => [attemptId, HISTORY + 2])))

          // An agent whose attempt stopped shows its durable count, read once.
          const stopped = agents[0]!
          entries.delete(stopped.sessionId)
          storeChanged(new Set([stopped.sessionId]))
          await projection.settled()
          expect(operations()[stopped.attemptId]).toBe(HISTORY + 2)
          const most = (counts: readonly number[]) => Math.max(...counts.slice(agentCount))
          return { facts: most(perChange), storeRequests: most(storeRequests), factRequests: most(factRequests) }
        } finally {
          projection.dispose()
        }
      } finally {
        store.close()
      }
    }
    // Eight agents is where the held conversation trees began to evict each other.
    expect(await workPerChange(12)).toEqual(await workPerChange(3))
  })
})

/** The agent owner with every started agent it hands out counted each time
 *  the view reads one of its fields: what the view scans in memory. */
function scanCountingAgents(owner: StartedAgentStates) {
  const scans = { count: 0 }
  const counted = (agent: StartedAgent): StartedAgent => ({
    get agent() { scans.count++; return agent.agent },
    get attemptId() { scans.count++; return agent.attemptId },
    get conversationId() { scans.count++; return agent.conversationId },
  })
  // Each list keeps one counted copy, so the lists keep their identities.
  const copies = new WeakMap<readonly StartedAgent[], readonly StartedAgent[]>()
  const list = (agents: readonly StartedAgent[]) => {
    let copy = copies.get(agents)
    if (!copy) copies.set(agents, copy = agents.map(counted))
    return copy
  }
  const agents: StartedAgentStates = {
    ...owner,
    started: async (workflowId) => list(await owner.started(workflowId)),
    onStarted: (listener) => owner.onStarted((workflowId, change) => listener(workflowId, { before: list(change.before), after: list(change.after), started: list(change.started), settled: list(change.settled) })),
  }
  return { agents, scans }
}

/** Counts the facts each durable read returns, which is what a rebuilt projection pays for. */
function factCountingReader(reader: AsyncEventStateReadSurface) {
  const counted = { facts: 0 }
  return {
    counted,
    reader: {
      ...reader,
      readPage: async (query, upper, after, tolerant, content) => {
        const page = await reader.readPage(query, upper, after, tolerant, content)
        counted.facts += page.facts.length
        return page
      },
      readSlice: async (query, tolerant) => {
        const slice = await reader.readSlice(query, tolerant)
        counted.facts += slice.facts.length
        return slice
      },
    } satisfies AsyncEventStateReadSurface,
  }
}
