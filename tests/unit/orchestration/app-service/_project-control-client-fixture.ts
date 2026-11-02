import type { ProjectControlClientOptions, ProjectControlExecutor } from "../../../../src/orchestration/app-service/project-control-client.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import type { FrontendMutation, RuntimeChatDefault, RuntimeExecutorState } from "../../../../src/protocol/app-service-types.js"
import type { SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import type { DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"
import type { AuthProfileResolution } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import { projectSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import type { RuntimeBackgroundLane } from "../../../../src/orchestration/app-service/runtime-background-lane.js"
import { durableRow, durableSessionFromCatalogRow, storedEvents } from "./_frontend-projection-fixtures.js"
import { servingAccountService } from "../../../helpers/account-service-state.js"
import { idleAccountUpdates } from "../../../helpers/account-updates.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { asAsyncEventReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"

export const never = <T>(): Promise<T> => new Promise(() => {})

export function fixture(executor: ProjectControlClientOptions["executor"] = never()) {
  const metadata = new Map<string, DurableSessionCatalogRow>()
  const changes = new Set<(change: SessionMetadataChange) => void>()
  const stored = storedEvents()
  const facts: StoredFact[] = []
  const reader = asAsyncEventReadSurface(inMemoryEventReader(facts))
  const creates: Parameters<ProjectControlClientOptions["state"]["sessions"]["createChat"]>[0][] = []
  const failures: unknown[] = []
  // The waiter of each escalation that an executor proven wedged answered.
  const terminated: Parameters<ProjectControlClientOptions["endIfWedged"]>[0]["waiter"][] = []
  let wedge = Promise.withResolvers<void>()
  let executorState: RuntimeExecutorState = { kind: "serving" }
  let nextId = 0
  let createBarrier = Promise.resolve()
  let chatDefault: RuntimeChatDefault = { kind: "pending" }
  let auth: AuthProfileResolution = {
    retirements: {},
    id: "first", persistedId: "first", displayName: "First", source: "sticky", directory: "/auth/first",
    availableProfiles: [{ id: "first", displayName: "First" }, { id: "second", displayName: "Second" }], projectBinding: undefined,
  }
  const notify = (change: SessionMetadataChange) => { for (const listener of changes) listener(change) }
  const history: RuntimeBackgroundLane = {
    start() {},
    recall: never,
    transcriptSearch: never,
    snapshot: async () => ({
      rows: [...metadata.values()].map((row) => projectSessionCatalogRow(row)).filter((row) => row.kind === "chat"),
      errors: [],
      totalsLoading: true,
      generationSpeeds: {},
    }),
    sessionSummaryImmediate: async (ids) => ({
      rows: ids.flatMap((id) => {
        const row = metadata.get(id)
        return row ? [projectSessionCatalogRow(row)] : []
      }),
      errors: [],
      totalsLoading: true,
      generationSpeeds: {},
    }),
    waitForTotals: never,
    sessionDetail: async () => ({ view: null }),
    sessionChangeSummary: never,
    moduleSnapshot: never,
    async dispose() {},
  }
  const state: ProjectControlClientOptions["state"] = {
    onStored: stored.onStored,
    capturePosition: reader.capturePosition,
    readPage: reader.readPage,
    sessions: {
      allocateId: () => `local-${++nextId}`,
      async createChat(input) {
        creates.push(input)
        await createBarrier
        const id = input.id ?? "missing"
        // The durable create is guarded: it writes only a session that does not exist.
        if (metadata.has(id)) throw new Error(`Session already exists: ${id}`)
        metadata.set(id,durableRow(id, { label: input.name ?? id, name: input.name, conversationId: input.conversationId, lifecycleState: input.initialState ?? "inactive" }))
        notify({ kind: "changed", sessionIds: [id] })
        return id
      },
      listForIds: async (ids) => ({ sessions: ids.flatMap((id) => {
        const row = metadata.get(id)
        return row ? [row] : []
      }), errors: [] }),
      read: async (id) => durableSessionFromCatalogRow(metadata.get(id)),
      async updateLifecycleState(id, lifecycleState) {
        const row = metadata.get(id)
        if (!row) throw new Error("Missing session")
        metadata.set(id, { ...row, lifecycleState })
        notify({ kind: "changed", sessionIds: [id] })
      },
      async updateLabel(id, labels) {
        const row = metadata.get(id)
        if (!row) return false
        metadata.set(id, { ...row, ...labels })
        notify({ kind: "changed", sessionIds: [id] })
        return true
      },
      subscribe(listener) { changes.add(listener); return () => { changes.delete(listener) } },
      // No session in these fixtures is owed a continuation.
      interruptOwed: async () => false,
    },
  }
  const options: ProjectControlClientOptions = {
    state, executor, history, awaitGenerationRecovery: async () => {}, directories: { projectRoot: "/workspace" }, executionCwd: "/workspace", runtimeVersion: "test-version", runtimeBuildId: "0123456789abcdef",
    authProfiles: { inspect: () => auth }, onError: (error) => { failures.push(error) },
    chatDefault: () => chatDefault,
    setChatDefault: (value) => { chatDefault = value },
    async endIfWedged({ waiter }) {
      await wedge.promise
      terminated.push(waiter)
    },
    executorState: () => executorState,
    updates: idleAccountUpdates(),
    service: servingAccountService(),
    sessionHolds: { holdProject: () => undefined, projectIdleGraceMs: undefined },
  }
  return { options, metadata, creates, failures, changes, stored, facts, terminated, notify,
    /** The executor is proven wedged, which answers every escalation that waits. */
    wedged: () => { wedge.resolve(); wedge = Promise.withResolvers<void>() },
    executor: (next: RuntimeExecutorState) => { executorState = next },
    profile: (value: Partial<AuthProfileResolution>) => { auth = { ...auth, ...value } },
    blockCreate: (promise: Promise<void>) => { createBarrier = promise },
  }
}

export function privateExecutor() {
  const bus = createRuntimeUiBus()
  // A hide is the account's private call, which the executor takes in order with its mutations.
  const commands: Array<FrontendMutation | { readonly type: "hide"; readonly sessionId: string }> = []
  let closes = 0
  const client: ProjectControlExecutor = {
    query: () => never(),
    dispatch(command) { commands.push(command); return never() },
    async hideSession(sessionId) { commands.push({ type: "hide", sessionId }) },
    subscribe(listener) {
      bus.addListener(listener)
      return () => bus.removeListener(listener)
    },
    async close() { closes++ },
  }
  return { client, bus, commands, closes: () => closes }
}

/** The stored measurement of one response that generated `outputTokens` in `durationMs`. */
export function generationFact(position: number, sessionId: string, outputTokens: number, durationMs: number) {
  return {
    id: String(position), position, seq: position - 1, timestamp: position, actor: "flywheel",
    aggregateId: `session:${sessionId}`, sessionId, type: "model.stream.summary.recorded", version: 3,
    payload: {
      requestId: String(position), identity: { providerSessionKey: sessionId }, turn: 1, rawEventCount: 2,
      countsBySource: {}, countsByKind: {},
      interDelta: { count: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 },
      watchdog: { thinkingStallCount: 0 }, recovery: { streamRetryCount: 0, reasoningDisabledRetryCount: 0 }, bigGapTransitions: [],
      generation: { kind: "recorded", basis: "O200kBase", outputTokens, durationMs, measuredBlocks: 1, excludedBlocks: 0 },
    },
  }
}
