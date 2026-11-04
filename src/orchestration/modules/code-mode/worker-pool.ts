import { Exit, Schema } from "effect"
import { createBoundedWorkerSpawner } from "../../../infra/bounded-worker-spawner.js"
import { embeddedEntrySpecifier, runsThroughBun } from "../../../infra/cli-subprocess.js"
import { DebugLog } from "../../../infra/debug-log.js"
import { trackLoopSpan } from "../../../infra/event-loop-lag.js"
import { terminateWorker } from "../../../infra/worker-termination.js"
import { GuestMessageSchema, type HostMessage } from "./invocation-protocol.js"

/** The host's view of one invocation Worker. A Bun `Worker` satisfies it,
 *  and a test can host the guest on its own thread behind it. */
export type InvocationWorker = Pick<Worker, "postMessage" | "addEventListener" | "removeEventListener" | "terminate">

/** Starts one default-mode Worker for the pool. Its spawner allows one
 *  generation, so a constructor that throws is never replaced. */
export function spawnInvocationWorker(): InvocationWorker {
  const spawn = createBoundedWorkerSpawner("code-mode-invocation")
  const specifier = runsThroughBun(process.execPath)
    ? new URL("code-mode-invocation-worker.ts", import.meta.url).href
    : embeddedEntrySpecifier(import.meta.dir, "code-mode-invocation-worker.js")
  const worker = spawn(specifier, { name: "code-mode-invocation" })
  DebugLog.record({ type: "runtime.worker.allocated", payload: { kind: "code-mode" } })
  return worker
}

/** Why the pool terminates a Worker instead of keeping it. */
export type RetireReason =
  | "interrupted" | "timeout" | "failed" | "heap-limit" | "crashed"
  | "used-up" | "reset-failed" | "idle" | "closed"

/** The retirements that a defect causes. Every other reason is a decision
 *  the pool takes by design. A pool whose resets fail goes back to one thread
 *  join per invocation, so these records reach the default log level. */
const FAULTS: ReadonlySet<RetireReason> = new Set(["failed", "crashed", "reset-failed"])

export interface WorkerPoolSettings {
  /** How many invocations one Worker serves before the pool retires it. */
  readonly maxUses: number
  /** How long a Worker may wait unused in the pool before the pool retires it. */
  readonly idleMs: number
  /** How long the pool waits for a guest to confirm a reset. */
  readonly resetTimeoutMs: number
}

/** A Worker that is retired after 100 invocations has removed 99 thread
 *  joins from the executor's invocation path. The cap still bounds memory
 *  that a full collection does not return, such as compiled code and
 *  allocator fragmentation, to the work of 100 programs. A one-minute idle
 *  limit keeps the Workers alive across the model turns between an agent's
 *  consecutive Code Mode calls, and returns their memory once Code Mode goes
 *  quiet. A reset is one full collection of one Worker's heap, which takes
 *  milliseconds, so a guest that has not confirmed it after one second is
 *  defective. */
export const CODE_MODE_WORKER_POOL: WorkerPoolSettings = Object.freeze({
  maxUses: 100,
  idleMs: 60_000,
  resetTimeoutMs: 1_000,
})

/** One Worker leased to one invocation. */
interface WorkerLease {
  readonly worker: InvocationWorker
  /** Gives the Worker back, once. `reuse` resets the guest and keeps the
   *  Worker when the guest confirms the reset in time; a retire reason, a
   *  spent use count, or a failed reset terminates it. The promise settles
   *  only when the Worker is idle in the pool or has closed, so its owner
   *  never holds a Worker in an unknown state. */
  release(verdict: "reuse" | RetireReason): Promise<void>
}

/** The process's invocation Workers. Every Worker serves one invocation at a
 *  time, and a lease returns it only after a confirmed reset, so no guest
 *  state of one invocation reaches the next. The pool starts no Worker until
 *  the first lease and holds none once every Worker idled out. It sets no
 *  size limit of its own: a release settles before its owner gives up its
 *  admission slot, so the pool never holds more Workers than the admission
 *  that leases them admits invocations. */
export interface InvocationWorkerPool {
  /** Leases the most recently returned idle Worker, or opens a new one.
   *  Throws what `openWorker` throws. */
  lease(): WorkerLease
  /** Terminates every idle Worker. A lease released after this retires its
   *  Worker. */
  close(): Promise<void>
}

/** A Worker's history: the invocations it served and the heap its guest
 *  reported after its last reset, absent before the first reset. */
interface Service {
  readonly uses: number
  readonly baselineHeapBytes?: number
}

interface IdleWorker {
  readonly worker: InvocationWorker
  readonly service: Service
  readonly expiry: ReturnType<typeof setTimeout>
}

/** Asks the guest to reset and resolves with its confirmation, or with
 *  `undefined` when the guest answers anything else, fails, ends, or misses
 *  the deadline. The confirmation carries the guest's new heap baseline. */
function resetGuest(worker: InvocationWorker, timeoutMs: number): Promise<number | undefined> {
  const { promise, resolve } = Promise.withResolvers<number | undefined>()
  const settle = (heapBytes: number | undefined): void => {
    clearTimeout(deadline)
    worker.removeEventListener("message", onMessage)
    worker.removeEventListener("error", onEnd)
    worker.removeEventListener("close", onEnd)
    resolve(heapBytes)
  }
  const onMessage = (event: MessageEvent): void => {
    const decoded = Schema.decodeUnknownExit(GuestMessageSchema)(event.data)
    settle(Exit.isSuccess(decoded) && decoded.value.type === "ready" ? decoded.value.heapBytes : undefined)
  }
  const onEnd = (): void => settle(undefined)
  const deadline = setTimeout(onEnd, timeoutMs)
  worker.addEventListener("message", onMessage)
  worker.addEventListener("error", onEnd)
  worker.addEventListener("close", onEnd)
  try {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: Bun Worker.postMessage has no target origin
    worker.postMessage({ type: "reset" } satisfies HostMessage)
  } catch {
    settle(undefined)
  }
  return promise
}

export function createInvocationWorkerPool(openWorker: () => InvocationWorker, settings: WorkerPoolSettings): InvocationWorkerPool {
  // The most recently returned Worker is last. Leasing it first lets the
  // Workers that a smaller load no longer needs reach their idle expiry.
  const idle: IdleWorker[] = []
  // Terminations still in progress, so closing the pool waits for each one.
  const retiring = new Set<Promise<void>>()
  let closed = false

  const retire = (worker: InvocationWorker, reason: RetireReason, service: Service): Promise<void> => {
    DebugLog.record({ type: "runtime.worker.retired", payload: { kind: "code-mode", reason, ...service }, ...(FAULTS.has(reason) ? { notable: true } : {}) })
    // Bun joins the ended Worker's thread on this thread, outside any JS
    // frame, in the native task that dispatches `close`, after its listeners
    // run. A span from `close` to the next macrotask covers that join and not
    // the guest teardown before it, so a stall names the join only when the
    // join ran in the stall.
    worker.addEventListener("close", () => {
      const end = trackLoopSpan("worker-exit", "code-mode-invocation")
      setTimeout(end, 0)
    }, { once: true })
    const terminated = terminateWorker(worker)
    retiring.add(terminated)
    void terminated.then(() => retiring.delete(terminated))
    return terminated
  }

  const park = (worker: InvocationWorker, service: Service): void => {
    const entry: IdleWorker = {
      worker,
      service,
      expiry: setTimeout(() => {
        idle.splice(idle.indexOf(entry), 1)
        void retire(worker, "idle", service)
      }, settings.idleMs),
    }
    // The expiry stays referenced: a live Worker already holds the event
    // loop open, and the expiry is what lets that loop drain without disposal.
    idle.push(entry)
  }

  const leaseOf = (worker: InvocationWorker, service: Service): WorkerLease => {
    let released = false
    return {
      worker,
      async release(verdict) {
        if (released) return
        released = true
        if (verdict !== "reuse") return retire(worker, verdict, service)
        if (closed) return retire(worker, "closed", service)
        if (service.uses >= settings.maxUses) return retire(worker, "used-up", service)
        const baselineHeapBytes = await resetGuest(worker, settings.resetTimeoutMs)
        if (baselineHeapBytes === undefined) return retire(worker, "reset-failed", service)
        if (closed) return retire(worker, "closed", { ...service, baselineHeapBytes })
        park(worker, { ...service, baselineHeapBytes })
      },
    }
  }

  return {
    lease() {
      const reused = idle.pop()
      if (reused === undefined) return leaseOf(openWorker(), { uses: 1 })
      clearTimeout(reused.expiry)
      return leaseOf(reused.worker, { ...reused.service, uses: reused.service.uses + 1 })
    },
    async close() {
      closed = true
      for (const { worker, service, expiry } of idle.splice(0)) {
        clearTimeout(expiry)
        void retire(worker, "closed", service)
      }
      await Promise.all(retiring)
    },
  }
}
