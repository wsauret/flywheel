import { isRecord } from "../../infra/record.js"
import {
  classifyRuntimeUiPatch,
  cursorKey,
  isRuntimeInvalidationPayload,
  isGlobalRuntimeInvalidation,
  runtimeDeliveryPolicy,
  type RuntimeCursorIdentity,
  type RuntimeInvalidationReason,
  type RuntimePatchClassification,
  type RuntimePosition,
  type RuntimeUiPatch,
} from "../runtime-ui-protocol-types.js"

/** The client half of ARCH-PROTOCOL-012: ordered intake of one runtime cursor.
 *
 *  The failure this exists to prevent is not a crash. It is a pane that looks
 *  healthy and is wrong, because one patch was dropped or arrived out of order
 *  and nothing noticed. So every patch is classified against the position this
 *  receiver holds, and the three answers are acted on differently: apply and
 *  advance, ignore as already seen, or hold and recover.
 *
 *  The classification rule itself is imported from the runtime, not restated
 *  here. It is a pure function over the receiver's held position, and the whole
 *  point of a shared ordering contract is that both ends evaluate it
 *  identically. A second copy of it in this repository would be a second
 *  opinion about what "in order" means. */

/** Why a cursor's resident state is being thrown away and rebuilt. The runtime
 *  publishes its own reasons through `runtime.invalidate`; these are the two
 *  the client itself can conclude. */
type RecoveryReason =
  | "runtime_invalidated"
  | "gap_unclosed"
  | "held_overflow"

export interface CursorIntakeOptions {
  readonly cursor: RuntimeCursorIdentity
  /** Apply one patch to resident state. Only ever called in position order,
   *  after the held position advances to the patch's position. */
  readonly onApply: (patch: RuntimeUiPatch) => void
  /** Rebuild this cursor from an authoritative read. The caller chooses what
   *  that means from the domain's delivery policy, which is why the policy
   *  travels with the request. */
  readonly onRecover: (request: RecoveryRequest) => void
  /** How many out-of-order patches to hold before giving up on the gap closing.
   *  A gap that stays open past this is cheaper to repair with one authoritative
   *  read than to keep hoping about. */
  readonly maxHeldPatches?: number
  /** How much held payload to retain, estimated without serializing it. One
   *  oversized patch is enough to give up holding: an authoritative read is
   *  cheaper than keeping it. Unbounded when absent. */
  readonly maxHeldBytes?: number
  /** How long to wait for a gap to close before recovering. Overflow alone is
   *  not enough: a cursor whose missing patch simply never arrives would sit
   *  quiet and stale forever, holding one patch and looking fine. */
  readonly gapDeadlineMs?: number
  readonly setTimer?: (run: () => void, ms: number) => Timer
  readonly clearTimer?: (timer: Timer) => void
}

type Timer = ReturnType<typeof setTimeout>

export interface RecoveryRequest {
  readonly cursor: RuntimeCursorIdentity
  readonly reason: RecoveryReason
  readonly policy: ReturnType<typeof runtimeDeliveryPolicy>
  /** The runtime's own reason, when the recovery is a `runtime.invalidate`. */
  readonly invalidation?: RuntimeInvalidationReason
}

const DEFAULT_MAX_HELD_PATCHES = 256
const DEFAULT_GAP_DEADLINE_MS = 2_000

export interface CursorIntake {
  /** Anchor this receiver at the position a snapshot was answered from. Any
   *  patch already held is reclassified against it, so a snapshot that raced
   *  the live stream settles instead of stranding what arrived first. */
  seed(snapshotPosition: RuntimePosition): void
  /** A snapshot read that will seed this cursor is out. Call it when that read
   *  starts, not when it is queued, and only when no earlier read can seed
   *  after it. Drops resident position and held patches like `reset`, and
   *  holds what arrives early with no deadline, because that read's seed
   *  reclassifies it. Only overflow still asks for recovery. */
  beginRead(): void
  /** The read that `beginRead` announced ended without a seed. The hold gets
   *  its deadline back, so held patches still end in recovery. The caller
   *  calls this only for its current read. No effect in any other phase. */
  abandonRead(): void
  accept(patch: RuntimeUiPatch): RuntimePatchClassification | "unseeded"
  /** Drop resident position and held patches. The next seed re-anchors. */
  reset(): void
  readonly heldPosition: RuntimePosition | null
  readonly pendingCount: number
}

/** Where this receiver stands against its authoritative reads. `unseeded`
 *  holds early patches on a deadline because no read is known to be out;
 *  `reading` holds them for the seed of the read that is out; `seeded`
 *  classifies against the held position. */
type IntakePhase =
  | { readonly kind: "unseeded" }
  | { readonly kind: "reading" }
  | { readonly kind: "seeded"; readonly held: RuntimePosition }

const UNSEEDED: IntakePhase = { kind: "unseeded" }
const READING: IntakePhase = { kind: "reading" }

/** What moves an intake between phases. `anchored` is both a seed and every
 *  applied patch: each sets the position the next patch is classified against. */
type IntakeEvent =
  | { readonly kind: "read_began" }
  | { readonly kind: "read_abandoned" }
  | { readonly kind: "reset" }
  | { readonly kind: "anchored"; readonly position: RuntimePosition }

/** The one transition of the intake phase. An abandoned read moves only the
 *  phase that announced it, so a late failure never unanchors a seeded cursor
 *  and the unchanged phase is returned as the same value. */
function nextIntakePhase(phase: IntakePhase, event: IntakeEvent): IntakePhase {
  switch (event.kind) {
    case "read_began": return READING
    case "read_abandoned": return phase.kind === "reading" ? UNSEEDED : phase
    case "reset": return UNSEEDED
    case "anchored": return { kind: "seeded", held: event.position }
  }
}

export function createCursorIntake(options: CursorIntakeOptions): CursorIntake {
  const maxHeld = options.maxHeldPatches ?? DEFAULT_MAX_HELD_PATCHES
  const maxHeldBytes = options.maxHeldBytes ?? Number.POSITIVE_INFINITY
  const gapDeadlineMs = options.gapDeadlineMs ?? DEFAULT_GAP_DEADLINE_MS
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  const policy = runtimeDeliveryPolicy(options.cursor.domain)

  let phase: IntakePhase = UNSEEDED
  const enter = (event: IntakeEvent): void => { phase = nextIntakePhase(phase, event) }
  const heldOf = (): RuntimePosition | null => phase.kind === "seeded" ? phase.held : null
  // Keyed by position so a duplicate delivery of the same patch replaces rather
  // than queues; the wire may repeat, and a repeat is not a second event.
  const pending = new Map<RuntimePosition, RuntimeUiPatch>()
  const pendingBytes = new Map<RuntimePosition, number>()
  let heldBytes = 0
  let gapTimer: Timer | undefined

  const hold = (patch: RuntimeUiPatch): boolean => {
    heldBytes -= pendingBytes.get(patch.position) ?? 0
    const bytes = retainedBytes(patch, maxHeldBytes - heldBytes)
    pending.set(patch.position, patch)
    pendingBytes.set(patch.position, bytes)
    heldBytes += bytes
    return pending.size <= maxHeld && heldBytes <= maxHeldBytes
  }
  const unhold = (position: RuntimePosition): void => {
    pending.delete(position)
    heldBytes -= pendingBytes.get(position) ?? 0
    pendingBytes.delete(position)
  }
  const clearHeld = (): void => {
    pending.clear()
    pendingBytes.clear()
    heldBytes = 0
  }

  const cancelGapTimer = (): void => {
    if (gapTimer === undefined) return
    clearTimer(gapTimer)
    gapTimer = undefined
  }

  const recover = (reason: RecoveryReason, invalidation?: RuntimeInvalidationReason): void => {
    cancelGapTimer()
    // An unseeded hold holds only early patches. The seed that ends the
    // recovery reclassifies them, and a read already out when the deadline
    // passed answers from before some of them, so dropping them would open a
    // gap that seed cannot close. Only overflow drops them, to bound the hold.
    if (phase.kind === "seeded" || reason === "held_overflow") clearHeld()
    // Held position is not cleared here. The recovering read answers with its
    // own snapshot position and seeds over this one; clearing first would make
    // every patch that arrives mid-recovery look like it belongs to a fresh
    // cursor rather than a stale one.
    options.onRecover({ cursor: options.cursor, reason, policy, ...(invalidation === undefined ? {} : { invalidation }) })
  }

  const armGapTimer = (): void => {
    if (gapTimer !== undefined) return
    gapTimer = setTimer(() => {
      gapTimer = undefined
      if (pending.size > 0) recover("gap_unclosed")
    }, gapDeadlineMs)
    // A pending recovery timer must not be the reason the host stays alive.
    gapTimer?.unref?.()
  }

  const unanchor = (event: IntakeEvent): void => {
    cancelGapTimer()
    enter(event)
    clearHeld()
  }
  const reset = (): void => { unanchor({ kind: "reset" }) }

  /** Apply whatever the new held position has unblocked, in position order. */
  const drain = (): void => {
    let progressed = true
    while (progressed && pending.size > 0) {
      progressed = false
      for (const position of [...pending.keys()].sort((a, b) => a - b)) {
        const patch = pending.get(position)
        if (patch === undefined || phase.kind !== "seeded") continue
        const classification = classifyRuntimeUiPatch(patch, { cursor: options.cursor, heldPosition: phase.held })
        if (classification === "gap") continue
        unhold(position)
        progressed = true
        if (classification === "stale") continue
        enter({ kind: "anchored", position: patch.position })
        options.onApply(patch)
      }
    }
    if (pending.size === 0) cancelGapTimer()
    else armGapTimer()
  }

  return {
    get heldPosition() {
      return heldOf()
    },
    get pendingCount() {
      return pending.size
    },
    seed(snapshotPosition) {
      cancelGapTimer()
      enter({ kind: "anchored", position: snapshotPosition })
      drain()
    },
    beginRead() { unanchor({ kind: "read_began" }) },
    abandonRead() {
      const before = phase
      enter({ kind: "read_abandoned" })
      if (phase !== before && pending.size > 0) armGapTimer()
    },
    reset,
    accept(patch) {
      if (!isGlobalRuntimeInvalidation(patch) && cursorKey(patch.cursor) !== cursorKey(options.cursor)) return "gap"

      if (isLaneBreak(patch)) {
        // What this cursor holds descends from a lane that broke. The seed the
        // next lane opens with anchors it again; a read now would only fail
        // with the lane, or answer twice.
        reset()
        return "applied"
      }
      // A newer recovery directive need not follow the held position, but an
      // adopted snapshot can already cover it.
      if (isRuntimeInvalidationPayload(patch.payload)) {
        const held = heldOf()
        if (held !== null && patch.position <= held) return "stale"
        recover("runtime_invalidated", patch.payload.reason)
        return "applied"
      }

      if (phase.kind !== "seeded") {
        // Not anchored yet. A patch that arrives before its snapshot is not
        // wrong, it is early, and dropping it would open a gap the snapshot
        // cannot close.
        // Holding while unseeded needs the same liveness as holding on a gap.
        // A seed that never arrives, because the read behind it failed, would
        // otherwise leave this cursor buffering every patch forever: it cannot
        // classify a gap without a held position, so nothing would ever ask for
        // recovery again and the pane would stay blank on a healthy socket.
        if (!hold(patch)) {
          recover("held_overflow")
          return "unseeded"
        }
        // While a read is out its seed answers for the hold, so the deadline
        // would only supersede that read with another one.
        if (phase.kind === "unseeded") armGapTimer()
        return "unseeded"
      }

      const classification = classifyRuntimeUiPatch(patch, { cursor: options.cursor, heldPosition: phase.held })
      if (classification === "stale") return "stale"
      if (classification === "applied") {
        enter({ kind: "anchored", position: patch.position })
        options.onApply(patch)
        drain()
        return "applied"
      }

      if (!hold(patch)) {
        recover("held_overflow")
        return "gap"
      }
      armGapTimer()
      return "gap"
    },
  }
}

/** Whether a patch is the connection's statement that its lane broke. Every
 *  receiver voids what it holds and reads nothing until the next lane opens,
 *  because that lane's seed reads it again. Every other invalidation reason
 *  still asks for its read at once. */
export function isLaneBreak(patch: RuntimeUiPatch): boolean {
  return isGlobalRuntimeInvalidation(patch) && isRuntimeInvalidationPayload(patch.payload) && patch.payload.reason === "reconnect_required"
}

/** Every live cursor this client holds, so one arriving patch reaches exactly
 *  one receiver and an unknown cursor is visibly unhandled rather than quietly
 *  dropped. */
export interface IntakeRegistry {
  register(intake: CursorIntake, cursor: RuntimeCursorIdentity): () => void
  /** Returns false when no receiver is bound to the patch's cursor, which is a
   *  client wiring defect rather than a runtime one. */
  deliver(patch: RuntimeUiPatch): boolean
  /** Drop resident state on every cursor, for a transport that was lost and
   *  whose local positions can no longer be trusted. */
  resetAll(): void
  readonly size: number
}

export function createIntakeRegistry(): IntakeRegistry {
  const receivers = new Map<string, CursorIntake>()
  return {
    get size() {
      return receivers.size
    },
    register(intake, cursor) {
      const key = cursorKey(cursor)
      receivers.set(key, intake)
      return () => {
        if (receivers.get(key) === intake) receivers.delete(key)
      }
    },
    deliver(patch) {
      if (isGlobalRuntimeInvalidation(patch)) {
        for (const receiver of receivers.values()) receiver.accept(patch)
        return receivers.size > 0
      }
      const receiver = receivers.get(cursorKey(patch.cursor))
      if (!receiver) return false
      receiver.accept(patch)
      return true
    },
    resetAll() {
      for (const receiver of receivers.values()) receiver.reset()
    },
  }
}

/** Estimate retained plain protocol data without allocating a serialized copy.
 * Stop once the remaining budget is exceeded, including inside a large body. */
function retainedBytes(value: unknown, budget: number): number {
  if (typeof value === "string") return value.length * 2
  if (Array.isArray(value)) {
    let bytes = 32
    for (const item of value) {
      bytes += 8 + retainedBytes(item, budget - bytes)
      if (bytes > budget) break
    }
    return bytes
  }
  if (!isRecord(value)) return 8
  let bytes = 32
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      bytes += key.length * 2 + retainedBytes(value[key], budget - bytes)
      if (bytes > budget) break
    }
  }
  return bytes
}
