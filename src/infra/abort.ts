/** True when `error` is an abort/cancel signal rather than a real failure: a
 *  DOMException or Error named "AbortError" (the shape `AbortController.abort()`
 *  and fetch/stream cancellation both throw). The one predicate every caller
 *  routes through so interrupt-vs-failure classification has a single
 *  definition. Structural signal checks (`signal.aborted`) stay the primary test
 *  where a signal is in scope; this is the error-shape fallback. */
export function isAbortError(error: unknown): boolean {
  return (error instanceof DOMException || error instanceof Error) && error.name === "AbortError"
}

/** Combine two abort signals into one that aborts when either does. Returns the
 *  lone signal when only one is present, or undefined when neither is, so callers
 *  avoid allocating an `AbortSignal.any` wrapper for the common single-signal case. */
export function mergeAbortSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal
export function mergeAbortSignals(a: AbortSignal, b: AbortSignal | undefined): AbortSignal
export function mergeAbortSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined
export function mergeAbortSignals(a: AbortSignal | undefined, b: AbortSignal | undefined): AbortSignal | undefined {
  if (a && b) return AbortSignal.any([a, b])
  return a ?? b
}

/** Sleeps for `ms` unless `signal` aborts first, in which case it rejects with
 *  the signal's reason and the timer is cleared, so a cancelled wait holds no
 *  handle open. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", aborted, { once: true })
    function cleanup(): void {
      clearTimeout(timer)
      signal.removeEventListener("abort", aborted)
    }
    function done(): void {
      cleanup()
      resolve()
    }
    function aborted(): void {
      cleanup()
      reject(signal.reason)
    }
  })
}

/** Waits for shared work without giving one caller ownership of the shared operation's lifetime. */
export function awaitWithAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { reject(signal.reason) }
    signal.addEventListener("abort", aborted, { once: true })
    void operation.then(
      (value) => { signal.removeEventListener("abort", aborted); resolve(value) },
      (error: unknown) => { signal.removeEventListener("abort", aborted); reject(error) },
    )
  })
}
