import { authStatusCursor, type AuthOperationNotice, type RuntimeAuthStatusScope, type RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import type { AuthProfileResolution } from "../auth/auth-profile-manager.js"
import type { SessionManager } from "../session/manager.js"
import { listActiveAndObservedAuthSessions, resolveSessionAuthProfile, sessionAuthFacts, type WorkflowAuthRuns } from "./auth-profile-scope.js"
import type { AuthStatusProjection } from "./auth-status-projection.js"
import type { AuthAttentionPublisher } from "./auth-attention-publisher.js"
import type { RuntimeUiBus } from "./runtime-ui-bus.js"

/** What one projection reading changes relative to the client's copy.
 *
 *  `view` decides publication: it covers everything the client renders.
 *  `providers` decides session-admission invalidation, which is a credential
 *  question - a renamed profile or a new warning must not throw away prepared
 *  admissions. */
interface AuthPublicationDelta {
  readonly view: boolean
  readonly providers: boolean
}

/** The auth view the client last received, and the only baseline a fresh
 *  projection reading may be compared against.
 *
 *  The projection reads the auth store on every call, so two of its readings
 *  are never a change record: a credential written since the last publication
 *  is already present in both, and comparing them reports "unchanged" for
 *  exactly the change that has to be published. Holding what was published is
 *  what makes the comparison answer the question the publisher is asking. */
export interface AuthPublicationBaseline {
  /** What a publication of `view` would newly tell the client. */
  delta(view: RuntimeAuthView, admissionRevision?: string): AuthPublicationDelta
  /** Records what a publication delivered. */
  record(view: RuntimeAuthView, admissionRevision?: string): void
}

export function createAuthPublicationBaseline(): AuthPublicationBaseline {
  // Serialized rather than held by reference: the projection builds a new view
  // on every reading, so nothing but its contents can be compared. Field order
  // is fixed by the projection, which is what makes the encoding comparable.
  let publishedView: string | undefined
  let publishedProviders: string | undefined
  let publishedAdmissionRevision: string | undefined

  return {
    delta: (view, admissionRevision) => ({
      view: JSON.stringify(view) !== publishedView,
      providers: JSON.stringify(view.providers) !== publishedProviders
        || (admissionRevision !== undefined && admissionRevision !== publishedAdmissionRevision),
    }),
    record(view, admissionRevision) {
      publishedView = JSON.stringify(view)
      publishedProviders = JSON.stringify(view.providers)
      publishedAdmissionRevision = admissionRevision
    },
  }
}

interface ProviderModelAuthPublisherDeps<Profile> {
  readonly resolveProfile: (profileId: string) => Profile | undefined
  readonly scopesForProfile: (profile: Profile) => Promise<readonly RuntimeAuthStatusScope[]>
  readonly publish: (scopes: readonly RuntimeAuthStatusScope[]) => Promise<void>
  readonly onError: (profileId: string, error: unknown) => void
}

/** Adapts synchronous provider-model publications to profile-scoped auth protocol updates.
 *
 * Unknown profiles are not owned by this runtime. Publication failures are
 * contained and reported through `onError` because model state is already
 * committed when this callback runs.
 */
export function createProviderModelAuthPublisher<Profile>(deps: ProviderModelAuthPublisherDeps<Profile>): (state: { readonly profileId: string }) => void {
  return ({ profileId }) => {
    const profile = deps.resolveProfile(profileId)
    if (profile === undefined) return
    void deps.scopesForProfile(profile)
      .then((scopes) => deps.publish(scopes))
      .catch((error: unknown) => { deps.onError(profileId, error) })
  }
}

/** Publishes one auth view per profile to active or previously observed scopes,
 * and offers each profile's view to the attention publisher, which sends only
 * what changed since its last settled delivery.
 * Snapshot observation lasts as long as the projection because the event stream
 * has no per-cursor unsubscribe. Deleted sessions are excluded by the catalog. */
export function createAuthStatusPublisher(deps: {
  readonly manager: Pick<SessionManager, "listActive" | "listForIds">
  readonly runs: WorkflowAuthRuns
  readonly defaults: () => AuthProfileResolution
  readonly userDataRoot: string
  readonly projection: AuthStatusProjection
  readonly attention: Pick<AuthAttentionPublisher, "state">
  readonly baseline: AuthPublicationBaseline
  readonly bus: Pick<RuntimeUiBus, "publish">
  readonly disposed: () => boolean
  readonly refreshChatDefault: () => void
}): (scopes?: readonly RuntimeAuthStatusScope[], notice?: AuthOperationNotice) => Promise<void> {
  return async (scopes, notice) => {
    const requestedSessionIds = scopes === undefined
      ? undefined
      : [...new Set(scopes.flatMap((scope) => scope.kind === "session" ? [scope.sessionId] : []))]
    const selectedRows = requestedSessionIds === undefined
      ? await listActiveAndObservedAuthSessions(deps.manager, deps.projection.observedSessionIds)
      : requestedSessionIds.length === 0 ? [] : (await deps.manager.listForIds(requestedSessionIds)).sessions
    const rows = new Map(selectedRows.map((row) => [row.id, row]))
    const defaults = deps.defaults()
    deps.projection.replace(defaults)
    const allScopes: readonly RuntimeAuthStatusScope[] = [
      { kind: "defaults" },
      ...[...rows.values()].map((row) => ({ kind: "session" as const, sessionId: row.id })),
    ]
    const views = new Map<string, RuntimeAuthView>()
    let publishedDefaults = false
    for (const scope of scopes ?? allScopes) {
      if (deps.disposed()) return
      const row = scope.kind === "session" ? rows.get(scope.sessionId) : undefined
      if (scope.kind === "session" && row === undefined) throw new Error(`Session not found: ${scope.sessionId}`)
      const profile = row === undefined ? defaults : resolveSessionAuthProfile(await sessionAuthFacts(row, deps.runs), defaults, deps.userDataRoot)
      const key = `${profile.id}\0${profile.directory}`
      let auth = views.get(key)
      if (auth === undefined) {
        auth = deps.projection.view(profile, notice)
        views.set(key, auth)
        deps.attention.state(auth)
      }
      if (scope.kind === "defaults") { deps.baseline.record(auth); publishedDefaults = true }
      deps.bus.publish({ cursor: authStatusCursor(scope), payload: { kind: "auth.changed", auth } })
    }
    if (publishedDefaults) deps.refreshChatDefault()
  }
}
