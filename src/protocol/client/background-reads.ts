import { reconnectBackoffMs } from "./connection.js"
import { explainedByConnection, lostWithLane } from "./connection-failures.js"
import type { RuntimeClientDiagnostic } from "../runtime-client-diagnostics.js"

interface ReadFailures {
  readonly pending: Set<object>
  readonly listeners: Set<() => void>
  diagnostic?: (message: string, detail?: unknown) => void
  report?: (diagnostic: RuntimeClientDiagnostic) => void
}

const failures = new WeakMap<object, ReadFailures>()

/** Readers that share a query transport share one background-read notice. */
export function backgroundReads(connection: { readonly query: object }) {
  let state = failures.get(connection.query)
  if (state === undefined) {
    state = { pending: new Set(), listeners: new Set() }
    failures.set(connection.query, state)
  }
  const held = state
  return {
    get failing() { return held.pending.size > 0 },
    diagnose(diagnostic: ((message: string, detail?: unknown) => void) | undefined, report?: (diagnostic: RuntimeClientDiagnostic) => void) {
      held.diagnostic = diagnostic
      held.report = report
    },
    subscribe(listener: () => void) {
      held.listeners.add(listener)
      return () => { held.listeners.delete(listener) }
    },
    state: held,
  }
}

/** Owns one reader's admission, backoff, and failure episode. `read` holds queries
 * through backoff; `request` coalesces recovery requests. A new lane or person
 * action can expedite admission. Success and disposal release the notice. */
export function createReadRetry(connection: { readonly query: object }, label: string, retry: () => void, onFailure?: (cause: unknown) => void) {
  const { state } = backgroundReads(connection)
  const key = {}
  let attempt = 0
  let repeats = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  let errorKind = "unknown"
  let waiting = Promise.withResolvers<void>()
  let requested = false
  function releaseWaiters(): void {
    waiting.resolve()
    waiting = Promise.withResolvers<void>()
  }
  const notify = () => { for (const listener of state.listeners) listener() }
  /** Counts a failure of the read's own toward the shared notice. */
  function noticeFailure(cause: unknown): void {
    if (state.pending.has(key)) {
      repeats++
      return
    }
    state.pending.add(key)
    errorKind = cause instanceof Error ? cause.name.slice(0, 64) : typeof cause
    state.report?.({ kind: "background_read", reader: label, errorKind, phase: "failed", repeats: 0 })
    state.diagnostic?.(`${label} read failed`, cause)
    onFailure?.(cause)
    notify()
  }
  function read<T>(query: () => Promise<T>): Promise<T> {
    return timer === undefined ? query() : waiting.promise.then(() => read(query))
  }
  function request(): void {
    if (disposed || requested) return
    requested = true
    void read(async () => {
      requested = false
      if (!disposed) retry()
    })
  }
  function clear(phase: "recovered" | "disposed" = "recovered"): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    releaseWaiters()
    attempt = 0
    if (!state.pending.delete(key)) return
    state.report?.({ kind: "background_read", reader: label, errorKind, phase, repeats })
    repeats = 0
    notify()
  }
  return {
    read,
    request,
    expedite(): void {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      releaseWaiters()
    },
    failed(cause: unknown) {
      if (disposed || lostWithLane(cause)) return
      // A read the connection explains raises no notice: the connection's
      // health says what a person must know. One that timed out while the
      // runtime was silent still reads again, because its lane may live on.
      if (!explainedByConnection(cause)) noticeFailure(cause)
      if (timer !== undefined) return
      timer = setTimeout(() => {
        timer = undefined
        request()
        releaseWaiters()
      }, reconnectBackoffMs(attempt++))
    },
    succeeded: clear,
    dispose() { disposed = true; clear("disposed") },
  }
}
