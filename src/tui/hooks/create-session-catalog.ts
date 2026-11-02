import { batch, createSignal, onCleanup } from "solid-js"
import { createStore, produce, reconcile, unwrap } from "solid-js/store"
import type { RuntimeChatDefault, RuntimeExecutorState, RuntimeServiceState, SessionCatalogError, SessionCatalogRow, AttachedRuntimeClient } from "../../protocol/app-service-types.js"
import {
  sessionCursor,
  workspaceDomainCursor,
  isRuntimeInvalidationPayload,
  type RuntimeSnapshotScope,
  type RuntimeUiPatch,
} from "../../protocol/runtime-ui-protocol-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { createStartupTimeline } from "../../infra/startup-timeline.js"
import { startupTrace } from "../../infra/startup-trace.js"
import { mergeCatalogRow } from "../../protocol/client/known-totals.js"
import { runtimeSnapshotScopeKey } from "../../protocol/client/family-intake.js"
import type { RuntimeIdentity } from "../../protocol/client/runtime-identity.js"
import { createOrderedPatchReceiver } from "./create-ordered-patch-receiver.js"

interface SessionCatalogCache {
  [sessionId: string]: SessionCatalogRow
}

export interface SessionCatalog {
  seed(row: SessionCatalogRow): void
  remove(sessionId: string): void
  /** The current catalog row for a session, or undefined if not present. Reactive:
   *  reads track the disposable cache the patch stream feeds. */
  row(sessionId: string): SessionCatalogRow | undefined
  rows(): readonly SessionCatalogRow[]
  errors(): readonly SessionCatalogError[]
  /** Workspace project identity, as the runtime reports it in each snapshot.
   *  Seeded from the startup selection so the first render has a value. */
  projectRoot(): string
  /** The account projection's exact resolved assignment for a new chat. */
  chatDefault(): RuntimeChatDefault
  /** What the runtime states about the process that runs this project's sessions. */
  executor(): RuntimeExecutorState
  /** What the runtime states about the account service that serves this project. */
  service(): RuntimeServiceState
  /** The serving backend's identity: the one the terminal's attach read
   *  from the account service's identity record, then the one each snapshot
   *  states, so a reconnect to another service replaces it. Undefined until
   *  either arrives. */
  runtimeIdentity(): RuntimeIdentity | undefined
  /** True after the first complete catalog snapshot is applied. */
  catalogReady(): boolean
}

const sessionScope = { kind: "workspace", domain: "session" } as const satisfies RuntimeSnapshotScope
/** The narrow TUI protocol client for phase-1's migrated `session` domain. It
 *  owns a disposable Solid cache of `SessionCatalogRow` keyed by id, seeded
 *  from the app-service catalog snapshot and advanced by ordered `session` patches. It
 *  never reads SessionStore: a `gap` (or a new lane) rebuilds
 *  the cache from a snapshot, so the cache can always be discarded and rebuilt
 *  from the boundary alone. The `output` domain is handled by its own live
 *  projector because it has frame-windowed deltas.
 *
 *  Must be called inside a component or `createRoot`: the shared receiver
 *  registers cleanup for its subscription and in-flight snapshots. Unlike the
 *  live output projector it needs no clock - the session domain is not frame-windowed. */
export function createSessionCatalog(deps: {
  appService: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
  projectRoot: string
  /** The identity of the service the terminal's attach reached. It resolves
   *  before the connection opens, so before any snapshot, and never rejects. */
  attachedIdentity?: Promise<RuntimeIdentity | undefined>
}): SessionCatalog {
  const [cache, setCache] = createStore<SessionCatalogCache>({})
  const [order, setOrder] = createSignal<readonly string[]>([])
  const [sessionCatalogErrors, setSessionErrors] = createSignal<readonly SessionCatalogError[]>([])
  const [projectRoot, setProjectRoot] = createSignal(deps.projectRoot)
  const [chatDefault, setChatDefault] = createSignal<RuntimeChatDefault>({ kind: "pending" })
  const [executor, setExecutor] = createSignal<RuntimeExecutorState>({ kind: "serving" })
  const [service, setService] = createSignal<RuntimeServiceState>({ kind: "serving" })
  const [runtimeIdentity, setRuntimeIdentity] = createSignal<RuntimeIdentity | undefined>()
  void deps.attachedIdentity?.then(setRuntimeIdentity)
  const timeline = createStartupTimeline({ owner: "session-catalog-hydration", stages: ["connectionWait", "snapshotRequest", "waitForTotalsPatch", "intake"], context: { projectRoot: deps.projectRoot, pid: String(process.pid) } })
  const endConnection = timeline.begin("connectionWait")
  let endSnapshot: ReturnType<ReturnType<typeof createStartupTimeline>["begin"]> | undefined
  let endWait: ReturnType<ReturnType<typeof createStartupTimeline>["begin"]> | undefined
  const [firstSnapshot, setFirstSnapshot] = createSignal(true)
  const catalogReady = () => !firstSnapshot()
  let initial: Set<string> | undefined
  let requested = 0
  let ready = 0
  let failures = 0
  let updates = 0
  let removed = 0

  function finishInitial(): void {
    if (!initial || initial.size > 0) return
    endWait?.("ready", { requested, ready, removed, updates, failures })
    timeline.finish("ready")
    initial = undefined
    startupTrace("session list ready")
  }

  onCleanup(() => {
    endConnection("incomplete")
    endSnapshot?.("incomplete", { failures })
    endWait?.("incomplete", { requested, ready, removed, updates, failures })
    timeline.finish(firstSnapshot() || initial ? "incomplete" : "ready")
    initial = undefined
  })

  createOrderedPatchReceiver({
    client: deps.appService,
    onConnected() {
      endConnection("ready")
      if (firstSnapshot() || initial) {
        endSnapshot?.("incomplete")
        endSnapshot = timeline.begin("snapshotRequest")
      }
    },
    accept(patch) {
      const ownsSession = patch.cursor.scope === "session" && patch.cursor.domain === "session"
      const ownsWorkspace = patch.cursor.scope === "workspace" && (patch.cursor.domain === "chat_default" || patch.cursor.domain === "executor" || patch.cursor.domain === "service")
      if (!ownsSession && !ownsWorkspace) return null
      if (!isRuntimeInvalidationPayload(patch.payload)
        && patch.payload.kind !== "session.added"
        && patch.payload.kind !== "session.updated"
        && patch.payload.kind !== "session.removed"
        && patch.payload.kind !== "chat_default.changed"
        && patch.payload.kind !== "executor.changed"
        && patch.payload.kind !== "service.changed") return null
      return { cursor: patch.cursor, scope: sessionScope, patch }
    },
    scopeKey: runtimeSnapshotScopeKey,
    connectedScope: () => sessionScope,
    deferConnectedSnapshot: true,
    loadSnapshot: async () => {
      const end = firstSnapshot() || initial ? endSnapshot ?? timeline.begin("snapshotRequest") : undefined
      endSnapshot = undefined
      try {
        const snapshot = await deps.appService.query({ type: "snapshot" })
        end?.("ready", { rows: snapshot.rows.length })
        return snapshot
      } catch (error) {
        if (firstSnapshot() || initial) failures++
        end?.("failed", { failures: 1 })
        throw error
      }
    },
    applySnapshot(snapshot) {
      const isFirstSnapshot = firstSnapshot()
      if (isFirstSnapshot) {
        requested = snapshot.rows.length
        initial = new Set(snapshot.rows.filter((row) => row.totalsLoading).map((row) => row.id))
        ready = requested - initial.size
        if (initial.size > 0) endWait = timeline.begin("waitForTotalsPatch")
      } else if (initial) {
        const present = new Set(snapshot.rows.map((row) => row.id))
        for (const id of initial) {
          if (!present.has(id)) {
            initial.delete(id)
            requested--
            removed++
          }
        }
        for (const row of snapshot.rows) {
          if (!row.totalsLoading && initial.delete(row.id)) { ready++; updates++ }
        }
      }
      const next: SessionCatalogCache = {}
      const cursors = []
      for (const row of snapshot.rows) {
        // A snapshot row replaces the resident one, except that a runtime
        // still loading a session's totals, as one just reattached to is,
        // keeps the totals already known (`mergeCatalogRow`).
        next[row.id] = mergeCatalogRow(unwrap(cache[row.id]), row)
        cursors.push(sessionCursor(row.id))
      }
      const endIntake = initial ? timeline.begin("intake") : undefined
      batch(() => {
        setCache(reconcile({}))
        setCache(reconcile(next))
        setOrder(snapshot.rows.map((row) => row.id))
        setSessionErrors(snapshot.errors)
        setProjectRoot(snapshot.projectRoot)
        setChatDefault(snapshot.chatDefault)
        setExecutor(snapshot.executor)
        setService(snapshot.service)
        setRuntimeIdentity({ version: snapshot.runtimeVersion, buildId: snapshot.runtimeBuildId })
        if (isFirstSnapshot) setFirstSnapshot(false)
      })
      endIntake?.("ready", { rows: snapshot.rows.length })
      finishInitial()
      return { snapshotPosition: snapshot.snapshotPosition, clearHeld: true, cursors: [...cursors, workspaceDomainCursor("chat_default"), workspaceDomainCursor("executor"), workspaceDomainCursor("service")] }
    },
    applyPayload(patch: RuntimeUiPatch, accepted) {
      const { payload } = patch
      if (payload.kind === "chat_default.changed") {
        setChatDefault(payload.chatDefault)
        return
      }
      if (payload.kind === "executor.changed") {
        setExecutor(payload.executor)
        return
      }
      if (payload.kind === "service.changed") {
        setService(payload.service)
        return
      }
      if (payload.kind === "session.removed") {
        if (accepted.cursor.scope !== "session") return
        const endIntake = initial ? timeline.begin("intake") : undefined
        const sessionId = accepted.cursor.sessionId
        if (initial?.delete(sessionId)) {
          requested--
          removed++
        }
        setOrder((ids) => ids.filter((id) => id !== sessionId))
        setCache(produce((state) => { Reflect.deleteProperty(state, sessionId) }))
        clearSessionError(sessionId)
        endIntake?.("ready", { removals: 1 })
        finishInitial()
        // Keep the held position: releasing it would make any later patch on
        // this cursor (a racing duplicate removal, a replayed flush) classify
        // as a gap and force a whole-domain resnapshot. The next snapshot
        // reseed (clearHeld) prunes the entry.
        return
      }
      if (payload.kind === "session.added" || payload.kind === "session.updated") {
        const endIntake = initial ? timeline.begin("intake") : undefined
        if (!payload.row.totalsLoading && initial?.delete(payload.row.id)) {
          ready++
          updates++
        }
        // reconcile diffs the fresh row against the resident proxy in place:
        // only leaves that actually changed notify, the row proxy keeps its
        // identity, and fields the fresh row omits are deleted. A wholesale
        // object replacement here invalidated every subscriber of every field
        // of the row on each patch - at the streaming patch rate that cascade
        // dominated the render thread (transcript pin effects, status line,
        // picker rebuilds), which the user saw as scroll and spinner freezes.
        const merged = mergeCatalogRow(unwrap(cache[payload.row.id]), payload.row)
        setCache(payload.row.id, reconcile(merged))
        setOrder((ids) => ids.includes(payload.row.id) ? ids : [...ids, payload.row.id])
        endIntake?.("ready", { rows: 1 })
        finishInitial()
      }
    },
  })

  function seed(row: SessionCatalogRow): void {
    // Reconcile the complete replacement so unchanged fields keep identity and
    // loading rows delete every aggregate field.
    const merged = mergeCatalogRow(unwrap(cache[row.id]), row)
    setCache(row.id, reconcile(merged))
    setOrder((ids) => ids.includes(row.id) ? ids : [...ids, row.id])
  }

  function remove(sessionId: string): void {
    setOrder((ids) => ids.filter((id) => id !== sessionId))
    setCache(produce((state) => { Reflect.deleteProperty(state, sessionId) }))
  }

  /** Deletion is authoritative for every error scope of the removed session. */
  function clearSessionError(sessionId: string): void {
    setSessionErrors((errors) => errors.some((error) => error.sessionId === sessionId)
      ? errors.filter((error) => error.sessionId !== sessionId)
      : errors)
  }

  return {
    seed,
    remove,
    row: (sessionId) => cache[sessionId],
    rows: () => resolveCatalogRows(order(), cache),
    errors: sessionCatalogErrors,
    projectRoot,
    chatDefault,
    executor,
    service,
    runtimeIdentity,
    catalogReady,
  }
}

/** Maps the catalog order onto its cache rows. The order list and the cache are
 *  both built from the same snapshot/patch stream, so an ordered id with no cache
 *  row is a divergence between two Flywheel-owned structures - an invariant
 *  violation, not a droppable row (ARCH-BOUNDARIES-004: fail at the reader, not silently). */
export function resolveCatalogRows(
  order: readonly string[],
  cache: Readonly<SessionCatalogCache>,
): readonly SessionCatalogRow[] {
  return order.map((id) => {
    const row = cache[id]
    if (!row) {
      throw new InvariantViolation({
        kind: "orphan-event",
        eventType: "session.catalog.order",
        eventPosition: -1,
        aggregateId: id,
        detail: `catalog order references session "${id}" absent from the cache`,
      })
    }
    return row
  })
}
