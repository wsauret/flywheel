import { awaitWithAbortSignal } from "../../infra/abort.js"

/** Coordinates profile-keyed refresh work and owns its cancellation lifecycle. */
export interface ProfileRefreshCoordinator {
  refresh(profileId?: string, signal?: AbortSignal, mode?: "refresh" | "observe"): Promise<void>
  barrier(): Promise<void>
  dispose(): Promise<void>
}

interface ActiveRefresh {
  readonly mode: "refresh" | "observe"
  readonly controller: AbortController
  readonly promise: Promise<void>
}

/** Joins refreshes for one profile while allowing different profiles to proceed independently. */
export function createProfileRefreshCoordinator(
  run: (profileId: string | undefined, signal: AbortSignal, mode: "refresh" | "observe") => Promise<void>,
): ProfileRefreshCoordinator {
  const active = new Map<string | undefined, ActiveRefresh>()
  let barrier: Promise<void> = Promise.resolve()
  let closed = false
  let disposal: Promise<void> | undefined

  const start = (profileId: string | undefined, signal?: AbortSignal, mode: "refresh" | "observe" = "refresh"): Promise<void> => {
    if (closed) return Promise.reject(new Error("profile refresh coordinator is disposed"))
    let current = active.get(profileId)
    if (current?.mode === "observe" && mode === "refresh") {
      const queued = current.promise.then(() => start(profileId, undefined, mode), () => start(profileId, undefined, mode))
      barrier = Promise.all([barrier, queued]).then(() => {}, () => {})
      return awaitWithAbortSignal(queued, signal)
    }
    if (!current) {
      const controller = new AbortController()
      const operation = Promise.withResolvers<void>()
      const promise = operation.promise
      void (async () => {
        try {
          await run(profileId, controller.signal, mode)
          operation.resolve()
        } catch (error) {
          operation.reject(error)
        } finally {
          if (active.get(profileId)?.promise === promise) active.delete(profileId)
        }
      })()
      current = { controller, promise, mode }
      active.set(profileId, current)
    }
    barrier = Promise.all([barrier, current.promise]).then(() => {}, () => {})
    return awaitWithAbortSignal(current.promise, signal)
  }

  return {
    refresh: (profileId, signal, mode) => start(profileId, signal, mode),
    barrier: () => barrier,
    dispose(): Promise<void> {
      if (disposal) return disposal
      closed = true
      const operations = [...active.values()]
      for (const operation of operations) operation.controller.abort(new DOMException("Profile refresh coordinator disposed", "AbortError"))
      disposal = Promise.allSettled(operations.map((operation) => operation.promise)).then(() => {
        active.clear()
      })
      return disposal
    },
  }
}
