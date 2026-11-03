import { Cause, Deferred, Effect, FiberSet, Layer, Scope } from "effect"
import { Worker as EffectWorker, WorkerError, WorkerRunner } from "effect/workers"
import { terminateWorker } from "../../infra/worker-termination.js"

/** Bun adapters for Effect's worker RPC transport, one per side of the
 *  channel. Effect core ships the platform-neutral protocol (worker-to-client
 *  frames: [0] ready / [1, data]; client-to-worker frames: [0, request] /
 *  [1] close) but no Bun implementation; these two layers are that
 *  implementation over the Web Worker API Bun provides. Non-array messages
 *  are ignored on both sides - they belong to the flywheel control channel
 *  (init/shutdown) that runs on the same Worker outside the RPC protocol. */

/** Client side: WorkerPlatform + Spawner over caller-created Bun Workers.
 *  The spawner is invoked per protocol (re)connect - after a worker crash the
 *  RPC protocol respawns through it - so `spawn` must create a fresh Worker
 *  each call; the caller tracks the current instance for control frames. */
export function bunWorkerClientLayers(
  spawn: () => globalThis.Worker,
  initialize?: (worker: globalThis.Worker) => void | Promise<void>,
): Layer.Layer<EffectWorker.WorkerPlatform | EffectWorker.Spawner> {
  const platform = EffectWorker.makePlatform<globalThis.Worker>()({
    setup: ({ scope, worker }) =>
      Effect.as(
        // Awaited join, not bare terminate(): the finalizer must not resolve
        // while the thread is still unwinding (see terminateWorker).
        Scope.addFinalizer(scope, Effect.promise(() => terminateWorker(worker))),
        {
          worker,
          postMessage(message: unknown, transfers: Transferable[] = []) {
            worker.postMessage(message, transfers)
          },
        },
      ),
    listen: ({ deferred, emit, port: { worker: port }, scope }) =>
      Effect.gen(function*() {
        const onMessage = (event: MessageEvent) => {
          if (Array.isArray(event.data)) emit(event.data)
        }
        const onError = (event: ErrorEvent) => {
          Deferred.doneUnsafe(deferred, Effect.fail(new WorkerError.WorkerError({
            reason: new WorkerError.WorkerUnknownError({ message: event.message || "worker error", cause: event.error }),
          })))
        }
        // A worker that exits cleanly (process.exit inside the thread, e.g.
        // its crash policy's fatal exit) emits only `close`, never `error`.
        // Without this listener the pool keeps handing out the dead worker and
        // every subsequent call times out; failing the deferred routes the
        // death through the same respawn path as a crash.
        const onClose = () => {
          Deferred.doneUnsafe(deferred, Effect.fail(new WorkerError.WorkerError({
            reason: new WorkerError.WorkerUnknownError({ message: "worker closed", cause: undefined }),
          })))
        }
        port.addEventListener("message", onMessage)
        port.addEventListener("error", onError)
        port.addEventListener("close", onClose)
        yield* Scope.addFinalizer(scope, Effect.sync(() => {
          port.removeEventListener("message", onMessage)
          port.removeEventListener("error", onError)
          port.removeEventListener("close", onClose)
        }))
        if (initialize) {
          yield* Effect.promise(async () => {
            try {
              await initialize(port)
            } catch (cause) {
              Deferred.doneUnsafe(deferred, Effect.fail(new WorkerError.WorkerError({
                reason: new WorkerError.WorkerUnknownError({ message: "worker initialization failed", cause }),
              })))
              // Effect waits for readiness before it observes the deferred failure. Open the latch so the scoped Worker finalizer can run.
              emit([0])
            }
          })
        }
      }),
  })
  return Layer.merge(
    Layer.succeed(EffectWorker.WorkerPlatform, platform),
    EffectWorker.layerSpawner(() => spawn()),
  )
}

/** Minimal structural view of a dedicated worker global scope; lets the worker
 *  server pass Bun's `self` without lib.webworker in the compilation. Bun
 *  worker globals expose no `close()`; a thread ends itself via process.exit,
 *  which surfaces as a `close` event on the owner's Worker object. */
export interface WorkerSelf {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void
  postMessage(message: unknown, transfer?: readonly unknown[]): void
}

/** Worker side: starts the runner over the worker global scope. Posts the
 *  ready frame once listening, so the client platform flushes its buffered
 *  requests only after the composition behind the handlers is live. A
 *  dedicated worker has exactly one counterpart, so the port id is always 0
 *  and close frames are ignored - shutdown flows through the control channel
 *  so the composition's ordered barrier runs before termination. */
export function bunWorkerRunnerLayer(worker: WorkerSelf): Layer.Layer<WorkerRunner.WorkerRunnerPlatform> {
  return Layer.succeed(WorkerRunner.WorkerRunnerPlatform, WorkerRunner.WorkerRunnerPlatform.of({
    start: <O, I>() =>
      Effect.succeed<WorkerRunner.WorkerRunner<O, I>>({
        run: <A, E, R>(handler: (portId: number, message: I) => Effect.Effect<A, E, R> | void) =>
          Effect.scopedWith((runScope) =>
            Effect.gen(function*() {
              const fiberSet = yield* FiberSet.make().pipe(Scope.provide(runScope))
              const runFork = yield* FiberSet.runtime(fiberSet)<R>()
              const onMessage = (event: MessageEvent) => {
                const data: unknown = event.data
                if (!Array.isArray(data) || data[0] !== 0) return
                // SAFETY: Effect's generic worker protocol owns and decodes the request payload as I.
                // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: Effect's generic worker protocol owns the decoded request payload type
                const result = handler(0, data[1] as I)
                if (Effect.isEffect(result)) runFork(result)
              }
              worker.addEventListener("message", onMessage)
              yield* Scope.addFinalizer(runScope, Effect.sync(() => worker.removeEventListener("message", onMessage)))
              worker.postMessage([0], [])
              // Handler failures surface as the runner's typed transport error;
              // the RPC protocol logs them and interrupts its fiber.
              yield* FiberSet.join(fiberSet).pipe(Effect.catchCause((cause) =>
                Effect.fail(new WorkerError.WorkerError({
                  reason: new WorkerError.WorkerUnknownError({ message: "worker runner handler failed", cause: Cause.squash(cause) }),
                }))
              ))
            })
          ),
        send: (_portId, message, transfers) => Effect.sync(() => worker.postMessage([1, message], transfers ?? [])),
        sendUnsafe: (_portId, message, transfers) => worker.postMessage([1, message], transfers ?? []),
      }),
  }))
}
