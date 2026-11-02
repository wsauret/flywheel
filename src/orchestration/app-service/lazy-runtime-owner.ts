import { createRuntimeOwnership, type RuntimeOwnership } from "./runtime-ownership.js"

export interface LazyRuntimeOwner<T> {
  /** Start or join initialization. Calls after disposal starts are rejected. */
  get(): Promise<T>
  /** Close admission, abort initialization, and wait until the active attempt settles. */
  dispose(): Promise<void>
}

export type LazyRuntimeInitializer<T> = (
  signal: AbortSignal,
  ownership: RuntimeOwnership,
) => Promise<T>

/** Demand-starts one single-flight runtime and transfers successful acquisitions
 * into the outer ownership graph. Failed attempts roll their child scope back. */
export function createLazyRuntimeOwner<T>(
  outerOwnership: RuntimeOwnership,
  initialize: LazyRuntimeInitializer<T>,
  onRollbackError: (error: unknown) => void,
): LazyRuntimeOwner<T> {
  let value: T
  let initialized = false
  let disposed = false
  let attempt: Promise<T> | undefined
  let attemptAbort: AbortController | undefined
  let disposal: Promise<void> | undefined

  const start = (): Promise<T> => {
    const child = createRuntimeOwnership(onRollbackError)
    const abort = new AbortController()
    attemptAbort = abort
    const running = (async () => {
      try {
        const initializedValue = await initialize(abort.signal, child)
        outerOwnership.adopt(child)
        value = initializedValue
        initialized = true
        return initializedValue
      } catch (error) {
        await child.releaseAcquired()
        throw error
      } finally {
        attempt = undefined
        attemptAbort = undefined
      }
    })()
    attempt = running
    return running
  }

  return {
    get(): Promise<T> {
      if (disposed) throw new Error("Lazy runtime owner is disposed")
      if (initialized) return Promise.resolve(value)
      return attempt ?? start()
    },
    dispose(): Promise<void> {
      disposed = true
      disposal ??= (async () => {
        attemptAbort?.abort()
        await attempt?.catch(() => {})
      })()
      return disposal
    },
  }
}
