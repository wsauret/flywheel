import { Effect, Fiber, Queue, Schema, Stream } from "effect"
import type { OperationLogger } from "../../infra/operation-log.js"
import type { RuntimeEventFrame } from "../../protocol/app-service-types.js"
import { RuntimeEventFrameSchema } from "../../protocol/runtime-protocol-schemas.js"
import type { RuntimeLivenessPolicy } from "../../protocol/runtime-liveness.js"
import type { FlywheelAppService } from "./app-service.js"

/** A catalog hydration publishes both session and budget frames. This bound
 *  accommodates the measured 1,308-frame startup burst with headroom while
 *  keeping slow connections' retained work bounded. A 4,096-frame limit is a
 *  possible next step, but retains more memory per connection; remeasure
 *  frame sizes and heap usage before increasing it. */
const EVENT_QUEUE_CAPACITY = 2048
const QUEUE_PRESSURE_THRESHOLDS = [1000, 1500] as const

/** Subscribes when the stream runs, then calls `onSubscribed` before delivery.
 *  A caller can use that hook to release commands or resolve its readiness wait.
 *  The consumer scope owns the subscription, heartbeat fiber, and sliding queue.
 *  Stream completion or interruption awaits their release.
 *
 *  A client that falls behind keeps its lane. A dropped cursor's final patch
 *  has no successor to expose a gap, so an overflowed batch ends with an
 *  explicit invalidation, outside the sliding queue that could drop it too.
 *  Frames use the existing wire codec; invalid frames fail as schema defects.
 *  An optional drain effect stops subscription and heartbeat admission, then
 *  completes after the retained batch and overflow invalidation are consumed.
 *  Interruption still cancels delivery immediately.
 *
 *  `watches` names the sessions whose `output.delta` this subscriber
 *  receives; every other frame, output invalidations included, is delivered.
 *  A subscriber without it, such as a headless run, receives every delta. */
export function runtimeEventDelivery(
  client: Pick<FlywheelAppService, "subscribe">,
  log: OperationLogger,
  liveness: RuntimeLivenessPolicy,
  onSubscribed: () => void,
  options: { readonly drain?: Effect.Effect<void>; readonly watches?: (sessionId: string) => boolean } = {},
): Stream.Stream<RuntimeEventFrame> {
  const { drain, watches } = options
  const decodeFrame = Schema.decodeUnknownSync(RuntimeEventFrameSchema)
  return Stream.unwrap(Effect.gen(function*() {
    const end = Symbol("runtime-event-drained")
    let draining = false
    const queue = yield* Effect.acquireRelease(
      Queue.sliding<RuntimeEventFrame | typeof end>(EVENT_QUEUE_CAPACITY),
      (ownedQueue) => Queue.shutdown(ownedQueue),
    )
    const streamId = crypto.randomUUID()
    const startedAt = performance.now()
    let highWaterMark = 0
    let nextWarning = 0
    log.info("runtime event stream subscribed", { streamId, capacity: EVENT_QUEUE_CAPACITY })
    // Reported once per subscription: the first drop says this client fell
    // behind, and the rate of later drops is not a fact anyone acts on.
    let dropped = false
    let overflowPending = false
    // The newest patch position offered, dropped or not. The bus delivers in
    // publish order, so it covers every frame the sliding queue dropped. An
    // ordered receiver whose read answered at or past it lost nothing and
    // ignores the invalidation; every receiver behind it reads again.
    let newestPosition = 0
    const offer = (event: RuntimeEventFrame): void => {
      if (event.type === "patch") newestPosition = event.patch.position
      if (Queue.sizeUnsafe(queue) >= EVENT_QUEUE_CAPACITY) {
        overflowPending = true
        if (!dropped) {
          dropped = true
          log.info("runtime event stream overflowed; invalidating after the retained batch", { streamId, capacity: EVENT_QUEUE_CAPACITY })
        }
      }
      Queue.offerUnsafe(queue, event)
      const queuedFrames = Queue.sizeUnsafe(queue)
      highWaterMark = Math.max(highWaterMark, queuedFrames)
      const threshold = QUEUE_PRESSURE_THRESHOLDS[nextWarning]
      if (threshold !== undefined && queuedFrames >= threshold) {
        nextWarning += 1
        log.warn("runtime event queue heavy load", {
          streamId,
          threshold,
          queuedFrames,
          highWaterMark,
          capacity: EVENT_QUEUE_CAPACITY,
          remainingCapacity: EVENT_QUEUE_CAPACITY - queuedFrames,
          elapsedMs: Math.round(performance.now() - startedAt),
        })
      }
    }
    // Nothing precedes the connected frame unless overflow drops it.
    offer({ type: "runtime.connected" })
    // These events are synthesized by the transport client, not wire frames.
    const stopSubscription = yield* Effect.acquireRelease(
      Effect.sync(() => client.subscribe((event) => {
        if (event.type === "runtime.startup" || event.type === "runtime.health") return
        if (watches && event.type === "patch" && event.patch.payload.kind === "output.delta" && event.patch.cursor.scope === "session" && !watches(event.patch.cursor.sessionId)) return
        offer(event)
      })).pipe(Effect.map((unsubscribe) => {
        let active = true
        return () => {
          if (!active) return
          active = false
          unsubscribe()
          log.info("runtime event stream unsubscribed", {
            streamId,
            highWaterMark,
            capacity: EVENT_QUEUE_CAPACITY,
            remainingCapacity: EVENT_QUEUE_CAPACITY - highWaterMark,
            elapsedMs: Math.round(performance.now() - startedAt),
          })
        }
      })),
      (stop) => Effect.sync(stop),
    )
    onSubscribed()
    const heartbeat = yield* Stream.runForEach(
      Stream.tick(liveness.heartbeatIntervalMs),
      () => Effect.sync(() => offer({ type: "runtime.heartbeat" })),
    ).pipe(Effect.forkScoped)
    if (drain) yield* Effect.gen(function*() {
      yield* drain
      yield* Fiber.interrupt(heartbeat)
      stopSubscription()
      draining = true
      // A full retained batch gets its terminator when it is taken. Offering
      // into that sliding queue here would discard one last retained frame.
      if (Queue.sizeUnsafe(queue) === 0) Queue.offerUnsafe(queue, end)
    }).pipe(Effect.forkScoped)
    return Stream.fromQueue(queue).pipe(
      Stream.mapArray((frames) => {
        const tail = draining ? [...frames, end] as const : frames
        if (!overflowPending) return tail
        overflowPending = false
        const invalidation: RuntimeEventFrame = {
          type: "patch",
          patch: {
            cursor: { scope: "workspace", domain: "runtime" },
            position: newestPosition,
            prevPosition: 0,
            payload: { kind: "runtime.invalidate", reason: "overflow" },
          },
        }
        return draining ? [...frames, invalidation, end] as const : [...frames, invalidation] as const
      }),
      Stream.takeWhile((frame): frame is RuntimeEventFrame => frame !== end),
      Stream.map((frame) => decodeFrame(frame)),
    )
  }))
}
