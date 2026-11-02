import type { RuntimeAuthStatusScope } from "../../protocol/auth-status-protocol-types.js"
import type { SessionManager } from "../session/manager.js"
import type { WatchedCatalogSession } from "./auth-profile-watcher-owner.js"

/** Observes durable owner changes without inventing session scopes for aggregate IDs. */
export function subscribeAuthOwners(input: {
  readonly manager: Pick<SessionManager, "subscribe"> & {
    listForIds(ids: readonly string[]): Promise<{ readonly sessions: readonly WatchedCatalogSession[] }>
  }
  readonly reconcileWorkflows: () => Promise<void>
  /** Lists every active session: a deletion is rare, and only a full list
   *  can tell that no other session needs the deleted session's profile. */
  readonly reconcileWatchers: () => Promise<void>
  /** Watches the profiles of changed sessions from their rows alone. */
  readonly watchSessions: (sessions: readonly WatchedCatalogSession[]) => Promise<void>
  readonly publish: (scopes: readonly RuntimeAuthStatusScope[]) => void
  readonly reconcileSessions: (scopes: readonly RuntimeAuthStatusScope[]) => void
  readonly onError: (error: unknown) => void
}): () => void {
  const changed = async (sessionIds: readonly string[]): Promise<void> => {
    const { sessions } = await input.manager.listForIds(sessionIds)
    void input.watchSessions(sessions).catch(input.onError)
    const scopes = sessions.map(({ id }) => ({ kind: "session" as const, sessionId: id }))
    input.publish(scopes)
    input.reconcileSessions(scopes)
  }
  return input.manager.subscribe((change) => {
    void input.reconcileWorkflows().catch(input.onError)
    if (change.kind === "changed") {
      void changed(change.sessionIds).catch(input.onError)
    } else {
      void input.reconcileWatchers().catch(input.onError)
      input.reconcileSessions([{ kind: "session", sessionId: change.sessionId }])
    }
  })
}
