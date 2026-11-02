import type { FrontendEvent } from "../app-service-types.js"
import {
  cursorKey,
  isRuntimeInvalidationPayload,
  isGlobalRuntimeInvalidation,
  type RuntimeCursorIdentity,
  type RuntimeInvalidationReason,
  type RuntimePosition,
  type RuntimeSnapshotScope,
  type RuntimeUiPatch,
} from "../runtime-ui-protocol-types.js"
import { createCursorIntake, isLaneBreak, type CursorIntake, type RecoveryRequest } from "./cursor-intake.js"
import { createReadRetry } from "./background-reads.js"
import { lostWithLane } from "./connection-failures.js"

/** Ordered intake of a family of cursors that share their authoritative reads.
 *
 *  A `CursorIntake` orders one cursor. A client domain is usually many
 *  cursors read together: a workspace snapshot answers for every session at
 *  one watermark, a batch read answers for the sessions it names, and a
 *  session that first appears after such a read is covered by the read's
 *  watermark, not by its own. This layer owns those reads. It routes each
 *  patch to the cursor's intake, anchors a cursor first seen outside a read at
 *  the family baseline, parks the cursors a read covers until the read seeds
 *  them, replays what arrived meanwhile, reads again after a read that ran
 *  while holding overflowed, and lets an invalidation replace a read in flight
 *  instead of waiting behind it. The terminal and the web client both run
 *  their domains on it, so what a gap costs is one decision. */

export interface FamilyIntakeAcceptance<Scope, Patch extends RuntimeUiPatch = RuntimeUiPatch> {
  readonly cursor: RuntimeCursorIdentity
  readonly scope: Scope
  readonly patch?: Patch
}

interface FamilySnapshotSeed {
  readonly snapshotPosition: RuntimePosition
  /** Only an authoritative whole-family snapshot may replace the family baseline. */
  readonly clearHeld?: boolean
  /** Concrete or partial batch snapshots cover only these cursors. */
  readonly cursors?: Iterable<RuntimeCursorIdentity>
}

interface FamilyIntakeContext<Scope> {
  /** Read one scope; a request while that scope is being read joins the read. */
  resnapshot(scope: Scope): Promise<void>
  /** Forget a cursor; its next patch anchors at the family baseline. */
  release(cursor: RuntimeCursorIdentity): void
}

export interface FamilyIntake<Scope> extends FamilyIntakeContext<Scope> {
  handle(event: FrontendEvent): void
  /** A lane opened: the family reads what it holds again. A read that is in
   *  flight already belongs to this lane, because a lane break aborts every
   *  read, so the lane's read joins it. */
  lane(): void
  cancelSnapshot(scope: Scope): void
  adoptSnapshot(seed: FamilySnapshotSeed): void
  dispose(): void
}

type FamilyIntakeDiagnostic =
  | "gap"
  | "stale"
  | "resnapshot.inflight"
  | "resnapshot.request"
  | "resnapshot"
  | "resnapshot.stale"
  | "resnapshot.error"
  | "held.overflow"

export interface FamilyIntakeOptions<Scope, Snapshot, Patch extends RuntimeUiPatch = RuntimeUiPatch> {
  /** Shares the background-read notice with other readers on this transport.
   *  A transport-independent intake uses its snapshot loader's identity. */
  readonly readTransport?: { readonly query: object }
  readonly label?: string
  /** Match the owned cursor first, then admit invalidations or refine domain data. */
  readonly accept: (patch: RuntimeUiPatch) => FamilyIntakeAcceptance<Scope, Patch> | null
  readonly scopeKey: (scope: Scope) => string
  readonly loadSnapshot: (scope: Scope, signal: AbortSignal) => Promise<Snapshot>
  /** Combines failed scopes into one authoritative read. The returned scope
   *  must cover every failed scope; without it, scopes retry separately on
   *  the family's shared backoff clock. */
  readonly mergeRetryScopes?: (scopes: readonly [Scope, ...Scope[]]) => Scope
  readonly applySnapshot: (snapshot: Snapshot, scope: Scope) => FamilySnapshotSeed
  readonly applyPayload: (patch: Patch, accepted: FamilyIntakeAcceptance<Scope, Patch>, context: FamilyIntakeContext<Scope>) => void
  /** The one scope the family reads when a lane opens, and again after a
   *  workspace invalidation. */
  readonly connectedScope?: () => Scope | null
  /** Called when a lane opens, so a domain that keeps its own read
   *  bookkeeping can start reads on the new lane. `connectedScope` names one
   *  scope to read; this serves a domain whose re-read is not one scope. */
  readonly onConnected?: () => void
  readonly globalRecoveryScopes?: () => Iterable<Scope>
  /** Starts the lane's read a task later, so the reads of a person's view
   *  go first in the lane's burst. */
  readonly deferConnectedSnapshot?: boolean
  /** Called before the read an in-order invalidation triggers, and at a lane
   *  break, so a domain whose snapshots are incremental can void resident
   *  state the invalidation declared stale. */
  readonly onInvalidate?: (scope: Scope, reason: RuntimeInvalidationReason) => void
  readonly diagnostics?: (name: FamilyIntakeDiagnostic, detail?: { readonly scope?: Scope; readonly cursor?: RuntimeCursorIdentity; readonly error?: unknown }) => void
  readonly onEvent?: (event: FrontendEvent) => void
  readonly onDispose?: () => void
}

// Recovery is off the normal in-order path. Bound both retained data and the
// synchronous replay batch before domain-specific output batching takes over.
const MAX_HELD_PATCHES = 64
const MAX_HELD_BYTES = 1024 * 1024

interface Entry<Scope> {
  readonly cursor: RuntimeCursorIdentity
  readonly intake: CursorIntake
  /** The scope whose read covers this cursor, from its last accepted patch. */
  scope: Scope | null
  scopeKey: string | null
  /** The position held before a read parked this cursor; where it re-anchors
   *  if that read ends without covering it. */
  parked: RuntimePosition | null
}

interface InFlight<Scope> {
  readonly scope: Scope
  readonly generation: number
  readonly controller: AbortController
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: PromiseWithResolvers<void>["reject"]
  overflowed: boolean
}

export function createFamilyIntake<Scope, Snapshot, Patch extends RuntimeUiPatch = RuntimeUiPatch>(
  options: FamilyIntakeOptions<Scope, Snapshot, Patch>,
): FamilyIntake<Scope> {
  const entries = new Map<string, Entry<Scope>>()
  const inflight = new Map<string, InFlight<Scope>>()
  const failedScopes = new Map<string, Scope>()
  let baseline: RuntimePosition = 0
  let generation = 0
  let disposed = false
  let connectedSnapshotTimer: ReturnType<typeof setTimeout> | null = null
  const makeRetry = () => createReadRetry(
    options.readTransport ?? { query: options.loadSnapshot },
    options.label ?? "snapshot",
    retrySnapshots,
    (error) => options.diagnostics?.("resnapshot.error", { scope: failedScopes.values().next().value, error }),
  )
  let retry = makeRetry()

  const context: FamilyIntakeContext<Scope> = { resnapshot, release }

  function entryFor(cursor: RuntimeCursorIdentity, scope: Scope | null): Entry<Scope> {
    const key = cursorKey(cursor)
    const scopeKey = scope === null ? null : options.scopeKey(scope)
    const entry = entries.get(key)
    if (!entry) {
      const created: Entry<Scope> = {
        cursor, scope, scopeKey, parked: null,
        intake: createCursorIntake({
          cursor,
          maxHeldPatches: MAX_HELD_PATCHES,
          maxHeldBytes: MAX_HELD_BYTES,
          onApply: apply,
          onRecover: (request) => recover(created, request),
        }),
      }
      entries.set(key, created)
      // A cursor first seen while its scope is read holds until that read
      // seeds it; any other anchors at the family baseline.
      if (scopeKey === null || !inflight.has(scopeKey)) created.intake.seed(baseline)
      return created
    }
    if (scope !== null) {
      entry.scope = scope
      entry.scopeKey = scopeKey
    }
    return entry
  }

  /** Hold this cursor's patches while its scope is read. */
  function park(entry: Entry<Scope>): void {
    const held = entry.intake.heldPosition
    if (held === null) return
    entry.parked = held
    entry.intake.reset()
  }

  /** Re-anchor a cursor a read left unseeded, where it was or at the baseline. */
  function anchor(entry: Entry<Scope>): void {
    if (entry.intake.heldPosition !== null) return
    const position = entry.parked ?? baseline
    entry.parked = null
    entry.intake.seed(position)
  }

  function entriesOf(key: string): Entry<Scope>[] {
    return [...entries.values()].filter((entry) => entry.scopeKey === key)
  }

  function apply(patch: RuntimeUiPatch): void {
    const accepted = options.accept(patch)
    if (!accepted) return
    // SAFETY: an omitted refinement means Patch is the raw runtime patch under the acceptor contract.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the runtime protocol cannot express this conditional generic refinement
    options.applyPayload(accepted.patch ?? (patch as Patch), accepted, context)
  }

  function recover(entry: Entry<Scope>, request: RecoveryRequest): void {
    if (disposed || entry.scope === null || entry.scopeKey === null) return
    if (request.reason === "runtime_invalidated") {
      options.onInvalidate?.(entry.scope, request.invalidation ?? "overflow")
      void startSnapshot(entry.scope, true)
      return
    }
    const current = inflight.get(entry.scopeKey)
    if (current) {
      // The read in flight may predate what was dropped: read again after it.
      current.overflowed = true
      if (request.reason === "held_overflow") options.diagnostics?.("held.overflow", { scope: entry.scope, cursor: entry.cursor })
      return
    }
    void startSnapshot(entry.scope, false)
  }

  function resnapshot(scope: Scope): Promise<void> {
    return startSnapshot(scope, false)
  }

  function retrySnapshots(): void {
    const pending = failedScopes.values()
    const first = pending.next()
    if (first.done) return
    const scopes: [Scope, ...Scope[]] = [first.value, ...pending]
    if (!options.mergeRetryScopes) {
      for (const scope of scopes) void startSnapshot(scope, false)
      return
    }
    const merged = options.mergeRetryScopes(scopes)
    const key = options.scopeKey(merged)
    failedScopes.set(key, merged)
    for (const scope of scopes) {
      const previous = options.scopeKey(scope)
      if (previous === key) continue
      cancelSnapshot(scope)
      for (const entry of entriesOf(previous)) {
        entry.scope = merged
        entry.scopeKey = key
      }
    }
    void startSnapshot(merged, false)
  }

  function snapshotFailed(scope: Scope, error: unknown): void {
    if (lostWithLane(error)) return
    failedScopes.set(options.scopeKey(scope), scope)
    retry.failed(error)
  }

  function startSnapshot(scope: Scope, replace: boolean): Promise<void> {
    if (disposed) return Promise.resolve()
    const key = options.scopeKey(scope)
    const current = inflight.get(key)
    if (current) {
      if (!replace) {
        options.diagnostics?.("resnapshot.inflight", { scope })
        return current.promise
      }
      current.controller.abort()
      current.resolve()
    }

    const controller = new AbortController()
    const snapshotGeneration = ++generation
    const { promise: completion, resolve, reject } = Promise.withResolvers<void>()
    // Snapshot work is frequently initiated by stream events. Mark rejection as
    // handled here while preserving the original promise for awaitable callers.
    void completion.catch(() => {})
    inflight.set(key, { scope, generation: snapshotGeneration, controller, promise: completion, resolve, reject, overflowed: false })
    for (const entry of entriesOf(key)) park(entry)
    options.diagnostics?.("resnapshot.request", { scope })

    let promise: Promise<Snapshot>
    try {
      promise = retry.read(() => controller.signal.aborted ? Promise.reject(controller.signal.reason) : options.loadSnapshot(scope, controller.signal))
    } catch (error) {
      finishSnapshotError(key, snapshotGeneration, error, scope)
      return completion
    }

    void promise.then(
      (snapshot) => finishSnapshot(key, snapshotGeneration, controller, snapshot, scope),
      (error) => finishSnapshotError(key, snapshotGeneration, error, scope),
    )
    return completion
  }

  function finishSnapshot(key: string, snapshotGeneration: number, controller: AbortController, snapshot: Snapshot, scope: Scope): void {
    const current = inflight.get(key)
    if (disposed || controller.signal.aborted || !current || current.generation !== snapshotGeneration) {
      options.diagnostics?.("resnapshot.stale", { scope })
      return
    }
    try {
      reseed(options.applySnapshot(snapshot, scope), scope)
      failedScopes.delete(key)
      if (failedScopes.size === 0) retry.succeeded()
      inflight.delete(key)
      // A cursor the read parked but did not cover continues where it was.
      for (const entry of entriesOf(key)) anchor(entry)
      if (current.overflowed) {
        // The read may predate dropped patches. Publish its usable state, then
        // read again after the overflow. Continuing to drop until this boundary
        // bounds memory without restarting an RPC for every incoming burst.
        void startSnapshot(scope, false).then(current.resolve, current.reject)
        return
      }
      options.diagnostics?.("resnapshot", { scope })
      current.resolve()
    } catch (error) {
      for (const entry of entriesOf(key)) anchor(entry)
      current.reject(error)
      snapshotFailed(scope, error)
      if (inflight.get(key)?.generation === snapshotGeneration) inflight.delete(key)
    }
  }

  function finishSnapshotError(key: string, snapshotGeneration: number, error: unknown, scope: Scope): void {
    const current = inflight.get(key)
    if (!current || current.generation !== snapshotGeneration) return
    inflight.delete(key)
    for (const entry of entriesOf(key)) anchor(entry)
    // An invalidation or overflow that arrived during the read asked for a
    // read after it, and this failure does not answer it. The runtime voids a
    // read that spans an executor generation change, so without this the
    // read the new generation's invalidation asked for would be lost.
    if (current.overflowed && !disposed) {
      void startSnapshot(scope, false).then(current.resolve, current.reject)
      return
    }
    current.reject(error)
    if (!current.controller.signal.aborted && !disposed) snapshotFailed(scope, error)
  }

  function reseed(seed: FamilySnapshotSeed, scope: Scope | null): void {
    if (seed.clearHeld) {
      baseline = seed.snapshotPosition
      for (const entry of entries.values()) {
        entry.parked = null
        entry.intake.seed(seed.snapshotPosition)
      }
    }
    for (const cursor of seed.cursors ?? []) {
      const entry = entryFor(cursor, scope)
      entry.parked = null
      entry.intake.seed(seed.snapshotPosition)
    }
  }

  function cancelSnapshot(scope: Scope): void {
    const key = options.scopeKey(scope)
    failedScopes.delete(key)
    if (failedScopes.size === 0) retry.succeeded()
    const current = inflight.get(key)
    if (!current) return
    current.controller.abort()
    current.resolve()
    inflight.delete(key)
    for (const entry of entriesOf(key)) anchor(entry)
  }

  function release(cursor: RuntimeCursorIdentity): void {
    const key = cursorKey(cursor)
    entries.get(key)?.intake.reset()
    entries.delete(key)
  }

  function abortSnapshots(): void {
    for (const [key, current] of inflight) {
      current.controller.abort()
      current.resolve()
      for (const entry of entriesOf(key)) anchor(entry)
    }
    inflight.clear()
  }

  function clearConnectedSnapshotTimer(): void {
    if (connectedSnapshotTimer) clearTimeout(connectedSnapshotTimer)
    connectedSnapshotTimer = null
  }

  function lane(): void {
    if (disposed) return
    clearConnectedSnapshotTimer()
    options.onConnected?.()
    const scope = options.connectedScope?.() ?? null
    if (!scope) return
    if (!options.deferConnectedSnapshot) {
      void startSnapshot(scope, false)
      return
    }
    connectedSnapshotTimer = setTimeout(() => {
      connectedSnapshotTimer = null
      void startSnapshot(scope, false)
    }, 0)
  }

  function recoveryScopes(): Iterable<Scope> {
    const scope = options.connectedScope?.()
    return options.globalRecoveryScopes?.() ?? (scope ? [scope] : [])
  }

  function handle(event: FrontendEvent): void {
    if (disposed) return
    options.onEvent?.(event)
    if (event.type !== "patch") return

    if (isLaneBreak(event.patch)) {
      // The reads in flight answer for a lane that is gone, and the next
      // lane reads every scope again.
      abortSnapshots()
      failedScopes.clear()
      retry.dispose()
      retry = makeRetry()
      clearConnectedSnapshotTimer()
      for (const scope of recoveryScopes()) options.onInvalidate?.(scope, "reconnect_required")
      return
    }

    if (isGlobalRuntimeInvalidation(event.patch)) {
      for (const current of inflight.values()) current.overflowed = true
      const scopes = recoveryScopes()
      for (const currentScope of scopes) {
        if (isRuntimeInvalidationPayload(event.patch.payload)) options.onInvalidate?.(currentScope, event.patch.payload.reason)
        const current = inflight.get(options.scopeKey(currentScope))
        if (current) current.overflowed = true
        else void startSnapshot(currentScope, false)
      }
      return
    }

    const accepted = options.accept(event.patch)
    if (!accepted) return
    const entry = entryFor(accepted.cursor, accepted.scope)
    // A cursor that moves under a scope being read holds with the rest of it.
    if (entry.scopeKey !== null && inflight.has(entry.scopeKey)) park(entry)
    switch (entry.intake.accept(event.patch)) {
      case "stale":
        options.diagnostics?.("stale", { scope: accepted.scope, cursor: accepted.cursor })
        return
      case "gap":
        // The intake holds the patch and asks for recovery on its own deadline
        // or overflow; a gap here starts the read at once, as the terminal has
        // always done, and the deadline stays the backstop.
        options.diagnostics?.("gap", { scope: accepted.scope, cursor: accepted.cursor })
        if (!inflight.has(options.scopeKey(accepted.scope))) void startSnapshot(accepted.scope, false)
        return
      case "applied":
      case "unseeded":
        return
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    failedScopes.clear()
    retry.dispose()
    clearConnectedSnapshotTimer()
    for (const current of inflight.values()) {
      current.controller.abort()
      current.resolve()
    }
    inflight.clear()
    for (const entry of entries.values()) entry.intake.reset()
    entries.clear()
    options.onDispose?.()
  }

  return {
    handle,
    lane,
    resnapshot,
    cancelSnapshot,
    release,
    adoptSnapshot(seed) { if (!disposed) reseed(seed, null) },
    dispose,
  }
}

export function runtimeSnapshotScopeKey(scope: RuntimeSnapshotScope): string {
  switch (scope.kind) {
    case "workspace":
      return `workspace:${scope.domain}`
    case "cursor":
      return `cursor:${cursorKey(scope.cursor)}`
  }
}
