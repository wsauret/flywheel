import type { AuthProfileStore } from "../../infra/auth/auth-profile-store.js"
import type { AuthProfileRetirements } from "../../infra/auth/auth-profile-retirements.js"

interface WatchedDefaultProfile {
  readonly id: string
  readonly directory: string
  readonly source: "environment" | "project" | "sticky" | "default"
  readonly availableProfiles: readonly { readonly id: string }[]
  readonly retirements: AuthProfileRetirements
}

/** One catalog row's watcher-relevant facts. */
interface WatchedSession {
  readonly authProfileId?: string
}

/** A catalog row of a changed session, as `watchSessions` reads it. */
export interface WatchedCatalogSession extends WatchedSession {
  readonly id: string
  readonly lifecycleState: string
}

export interface AuthProfileWatcherOwner {
  /** Watches exactly the profiles that back the defaults, the workflows, and
   *  the active sessions, which it lists. */
  reconcile(): Promise<void>
  /** Adds a watcher for each profile that backs one of `sessions`, the
   *  catalog rows of sessions that changed, and lists nothing. A watcher that
   *  no session needs any more stays until the next `reconcile`: an extra
   *  watcher only refreshes a profile, and listing every active session on
   *  each session change made each start of many agents cost every row. */
  watchSessions(sessions: readonly WatchedCatalogSession[]): Promise<void>
  refreshCatalog(): Promise<void>
  dispose(): Promise<void>
}

function createAuthFileChangeHandler(input: {
  readonly profileId: string
  readonly isDisposed: () => boolean
  readonly refresh: (profileId: string) => Promise<void>
  readonly onError: (error: unknown, profileId: string) => void
}): () => void {
  return () => {
    if (input.isDisposed()) return
    void input.refresh(input.profileId).catch((error: unknown) => { input.onError(error, input.profileId) })
  }
}

/** Owns one contained auth-file watcher for each profile that backs a live runtime scope. */
export function createAuthProfileWatcherOwner(input: {
  readonly workflowProfiles?: () => Promise<readonly { readonly id: string; readonly directory: string }[]>
  readonly store: Pick<AuthProfileStore, "watchAuthFile" | "watchCatalog">
  readonly defaultProfile: () => WatchedDefaultProfile
  readonly sessions: {
    listActive(): Promise<{ readonly sessions: readonly WatchedSession[] }>
  }
  readonly profileDirectory: (profileId: string) => string
  readonly refresh: (profileId: string) => Promise<void>
  readonly refreshCatalog: () => Promise<void>
  readonly onError: (error: unknown, profileId: string) => void
}): AuthProfileWatcherOwner {
  const watchers = new Map<string, { readonly directory: string; readonly dispose: () => void }>()
  const lifecycle = { disposed: false }
  let pending = Promise.resolve()

  /** Adds the profile that backs each session to `desired`. */
  const addSessionProfiles = (desired: Map<string, string>, defaults: WatchedDefaultProfile, sessions: readonly WatchedSession[]): void => {
    const availableProfileIds = new Set(defaults.availableProfiles.map((profile) => profile.id))
    for (const session of sessions) {
      const selectedId = session.authProfileId ?? defaults.id
      const profileId = defaults.source === "environment" ? defaults.id : defaults.retirements[selectedId] ?? selectedId
      if (profileId !== defaults.id && !availableProfileIds.has(profileId)) continue
      desired.set(profileId, profileId === defaults.id ? defaults.directory : input.profileDirectory(profileId))
    }
  }

  const reconcileNow = async (): Promise<void> => {
    if (lifecycle.disposed) return
    const defaults = input.defaultProfile()
    const desired = new Map<string, string>([[defaults.id, defaults.directory]])
    for (const profile of await input.workflowProfiles?.() ?? []) desired.set(profile.id, profile.directory)
    addSessionProfiles(desired, defaults, (await input.sessions.listActive()).sessions)

    if (lifecycle.disposed) return
    for (const [profileId, watcher] of watchers) {
      if (desired.get(profileId) === watcher.directory) continue
      watcher.dispose()
      watchers.delete(profileId)
    }
    watchMissing(desired)
  }

  const watchMissing = (desired: ReadonlyMap<string, string>): void => {
    for (const [profileId, directory] of desired) {
      if (watchers.has(profileId)) continue
      const watcher = input.store.watchAuthFile(directory, createAuthFileChangeHandler({
        profileId,
        isDisposed: () => lifecycle.disposed,
        refresh: input.refresh,
        onError: input.onError,
      }))
      watchers.set(profileId, { directory, dispose: () => { watcher.dispose() } })
    }
  }

  const serialized = (run: () => Promise<void>): Promise<void> => {
    const operation = pending.then(run)
    pending = operation.catch((error: unknown) => { input.onError(error, input.defaultProfile().id) })
    return operation
  }
  const reconcile = (): Promise<void> => serialized(reconcileNow)
  const watchSessions = (sessions: readonly WatchedCatalogSession[]): Promise<void> => serialized(async () => {
    if (lifecycle.disposed) return
    const desired = new Map<string, string>()
    addSessionProfiles(desired, input.defaultProfile(), sessions.filter((session) => session.lifecycleState === "active"))
    // A profile watched at another directory moved with a catalog change, which reconciles in full.
    watchMissing(desired)
  })
  let catalogQueued: Promise<void> | undefined
  const refreshCatalog = (): Promise<void> => {
    if (lifecycle.disposed) return Promise.resolve()
    if (catalogQueued) return catalogQueued
    const operation = pending.then(async () => {
      catalogQueued = undefined
      if (lifecycle.disposed) return
      await input.refreshCatalog()
      await reconcileNow()
    })
    catalogQueued = operation
    pending = operation.catch((error: unknown) => { input.onError(error, input.defaultProfile().id) })
    return operation
  }
  const catalogWatcher = input.store.watchCatalog(
    () => { void refreshCatalog().catch(() => {}) },
    (error) => input.onError(error, input.defaultProfile().id),
  )
  void reconcile().catch(() => {})
  return {
    reconcile,
    watchSessions,
    refreshCatalog,
    dispose: async () => {
      lifecycle.disposed = true
      catalogWatcher.dispose()
      for (const watcher of watchers.values()) watcher.dispose()
      watchers.clear()
      await pending
    },
  }
}
