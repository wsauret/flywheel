import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import type { FrontendEvent } from "../../protocol/app-service-types.js"
import { createRuntimeUiPatchSequencer, type RuntimeReadAnchor } from "./runtime-ui-patch-sequencer.js"
import { cursorKey, runtimeDeliveryPolicy, type RuntimeCursorIdentity, type RuntimePosition, type RuntimeUiPatch, type RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"


type Listener = (event: FrontendEvent) => void

interface Delivery {
  readonly patch: RuntimeUiPatch
  /** The listeners attached when the patch was published. */
  readonly listeners: readonly Listener[]
}

interface RuntimeUiPatchLogFields {
  [field: string]: unknown
}

/** The runtime->TUI patch transport: one sequencer mints every position, and
 * one ordered lane hands each patch to every listener attached when it was
 * published, in publish order. `publish` mints synchronously and delivers
 * later; overload drops newest patches and enqueues one in-order invalidation
 * per cursor so clients resnapshot instead of replaying.
 * `Published` is `RuntimeUiPatch` on a bus that publishes every patch. */
export interface RuntimeUiBus<Published extends RuntimeUiPatch | undefined = RuntimeUiPatch | undefined> {
  /** Returns `undefined` when publish-on-change declines an equal repeat. */
  publish(input: RuntimeUiPatchInput): Published
  snapshotPosition(anchor: RuntimeReadAnchor): RuntimePosition
  /** Attaches one delivery listener. The bus carries internal consumers and
   *  protocol clients alike, so it deliberately reports nothing about listener
   *  counts: "first bus listener" is not "first client", and a caller that
   *  gated client-only work on it once lost every catalog patch. */
  addListener(listener: (event: FrontendEvent) => void): void
  removeListener(listener: (event: FrontendEvent) => void): void
  drain(): Promise<void>
  clear(): Promise<void>
}

const log = Log.create({ service: "runtime-ui-bus" })
const MAX_PENDING_DELIVERIES = 20_000

export interface RuntimeUiBusOptions {
  readonly maxPendingDeliveries?: number
  /** Declines an equal whole-value repeat (`RuntimeUiPatchSequencerOptions`).
   *  Only the account's public bus sets it: the executor's one reader merges
   *  its patches with the account's own state and answers some reads from
   *  history, so that reader does not always hold the last publication. */
  readonly publishOnChange?: boolean
}

export function createRuntimeUiBus(options?: Omit<RuntimeUiBusOptions, "publishOnChange">): RuntimeUiBus<RuntimeUiPatch>
export function createRuntimeUiBus(options: RuntimeUiBusOptions): RuntimeUiBus
export function createRuntimeUiBus(options: RuntimeUiBusOptions = {}): RuntimeUiBus {
  const sequencer = createRuntimeUiPatchSequencer({ publishOnChange: options.publishOnChange ?? false })
  const maxPendingDeliveries = options.maxPendingDeliveries ?? MAX_PENDING_DELIVERIES
  const subscribers = new Set<Listener>()
  // The deliveries not yet handed to their listeners. `clear` empties it,
  // which stops a delivery in progress and every delivery still queued on the lane.
  const pending = new Set<Delivery>()
  // Coalesce only until delivery begins: a listener can snapshot synchronously,
  // then publish another dropped update before the current delivery ends.
  const overflowInvalidated = new Map<string, Delivery>()
  // `deliver` contains each listener's failure, so no delivery stops the lane.
  const deliveries = createOrderedLane()
  let overflowCount = 0

  function publish(input: RuntimeUiPatchInput): RuntimeUiPatch | undefined {
    const patch = sequencer.publish(input)
    if (!patch) {
      log.debug("publish patch", { ...patchFields(input), unchanged: true })
      return undefined
    }
    const active = [...subscribers]
    // Debug, not info: publish runs per output delta, so at INFO this floods
    // the log and burns worker time formatting lines during streaming.
    log.debug("publish patch", {
      ...patchFields(input),
      position: patch.position,
      prevPosition: patch.prevPosition,
      activeSubscribers: active.length,
      pendingDeliveries: pending.size,
      overflowCount,
    })
    if (active.length === 0) return patch
    if (pending.size >= maxPendingDeliveries) {
      overflowCount += 1
      log.warn("publish overflow", { ...patchFields(input), pendingDeliveries: pending.size, overflowCount })
      if (runtimeDeliveryPolicy(input.cursor.domain) !== "query-only") enqueueOverflowInvalidation(input.cursor, active)
      return patch
    }
    enqueue(patch, active)
    return patch
  }

  function enqueue(patch: RuntimeUiPatch, listeners: readonly Listener[]): Delivery {
    const delivery: Delivery = { patch, listeners }
    pending.add(delivery)
    void deliveries.run(() => deliver(delivery))
    return delivery
  }

  /** Overflow recovery rides the SAME ordered lane as the patches it supersedes
   *  (item 16). Delivering it directly put the invalidation ahead of every still-
   *  queued older patch, so the client resnapshotted and then replayed a backlog
   *  minted before its new baseline. The one deliberate cap overshoot keeps the
   *  recovery signal deliverable when the lane is exactly full. */
  function enqueueOverflowInvalidation(cursor: RuntimeCursorIdentity, active: readonly Listener[]): void {
    const key = cursorKey(cursor)
    if (overflowInvalidated.has(key)) return
    const invalidation = sequencer.publish({ cursor, payload: { kind: "runtime.invalidate", reason: "overflow" } })
    // An invalidation always publishes; the sequencer declines whole values only.
    if (!invalidation) return
    overflowInvalidated.set(key, enqueue(invalidation, active))
  }

  function addListener(listener: Listener): void {
    subscribers.add(listener)
  }

  // A removed listener still receives the patches published while it was
  // attached: each delivery names its listeners when it is published.
  function removeListener(listener: Listener): void {
    subscribers.delete(listener)
  }

  /** Delivers one patch to each of its listeners in order. */
  function deliver(delivery: Delivery): void {
    const key = cursorKey(delivery.patch.cursor)
    if (overflowInvalidated.get(key) === delivery) overflowInvalidated.delete(key)
    const event: FrontendEvent = { type: "patch", patch: delivery.patch }
    try {
      for (const listener of delivery.listeners) {
        // A listener can call `clear`, which delivers nothing more.
        if (!pending.has(delivery)) return
        try {
          listener(event)
        } catch (err) {
          log.warn("listener error", { error: errorMessage(err), errorDetail: errorDetail(err) })
        }
      }
    } finally {
      pending.delete(delivery)
    }
  }

  // Every pending delivery is queued on the lane, so the lane settling covers
  // it; deliveries a listener publishes meanwhile keep the loop going.
  async function drain(): Promise<void> {
    while (pending.size > 0) await deliveries.settled()
  }

  return {
    publish,
    snapshotPosition: sequencer.snapshotPosition,
    addListener,
    removeListener,
    drain,
    async clear(): Promise<void> {
      subscribers.clear()
      pending.clear()
      await deliveries.settled()
    },
  }
}

function patchFields(input: RuntimeUiPatchInput): RuntimeUiPatchLogFields {
  return {
    cursorScope: input.cursor.scope,
    cursorDomain: input.cursor.domain,
    sessionId: input.cursor.scope === "session" ? input.cursor.sessionId : undefined,
    payloadKind: input.payload.kind,
  }
}
