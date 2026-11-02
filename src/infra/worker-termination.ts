/** Minimal structural view of a terminatable Bun Worker: enough for the
 *  termination helper without dragging lib.webworker into every consumer. */
interface TerminatableWorker {
  terminate(): void
  addEventListener(type: "close", listener: () => void, options?: { once: boolean }): void
}

const closedWorkers = new WeakSet<TerminatableWorker>()

/** Record when a worker's thread exits so terminateWorker can skip it.
 *  Calling terminate() on a worker whose thread already exited dereferences
 *  a freed native handle and segfaults Bun 1.3.12 (crash reports at exit:
 *  0xE8 inside jsWorkerPrototypeFunction_terminate). Threads that finish
 *  their work exit naturally - e.g. the runtime worker after its shutdown
 *  barrier - so every spawn site registers here at creation. Close dispatch
 *  and terminate() both run on the owning thread, so the flag cannot race. */
export function trackWorkerClose<W extends TerminatableWorker>(worker: W): W {
  worker.addEventListener("close", () => closedWorkers.add(worker), { once: true })
  return worker
}

/** Bun's Worker.terminate() is fire-and-forget: it starts the thread's
 *  teardown and returns before the thread has exited. The `close` event on
 *  the Worker object is the release signal, not a native-thread join: Bun
 *  documents that the thread can outlive `close` briefly. Exiting the owning
 *  thread or the process while a teardown is still unwinding is a native race
 *  that can segfault Bun (observed at TUI exit on Bun 1.3.12 with workers
 *  alive in the crash report), so ordered disposal awaits `close` and then a
 *  macrotask, which is the latest point the runtime reports. No timer can
 *  replace this signal: a thread that never sends `close` is ended by the
 *  independent process watchdog, never by a caller that decides the thread is
 *  gone. */
export function terminateWorker(worker: TerminatableWorker): Promise<void> {
  if (closedWorkers.has(worker)) return Promise.resolve()
  const join = new Promise<void>((resolve) => {
    // `close` is dispatched synchronously inside native teardown paths;
    // resolving on a fresh macrotask keeps the awaiting shutdown sequence
    // (often the next worker's terminate()) off that native stack.
    worker.addEventListener("close", () => setTimeout(resolve, 0), { once: true })
  })
  worker.terminate()
  return join
}
