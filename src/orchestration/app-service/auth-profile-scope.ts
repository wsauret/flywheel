import { authDir } from "../../infra/paths.js"
import type { RuntimeAuthStatusScope } from "../../protocol/auth-status-protocol-types.js"
import type { AuthProfileResolution } from "../auth/auth-profile-manager.js"
import type { SessionManager } from "../session/manager.js"
import type { DurableSessionCatalogRow } from "../session/session-catalog-types.js"
import type { SessionLifecycleState } from "../session/types.js"
import type { WorkflowRunRecord } from "../workflow-host/run-record.js"

type AuthScopeSessionManager = Pick<SessionManager, "read">
type AuthScopeCatalogManager = Pick<SessionManager, "listActive" | "listForIds">

/** The session facts one auth scope resolution depends on: a full session
 *  read and a catalog row both satisfy it. */
export interface SessionAuthFacts {
  readonly authProfileId?: string
}

/** A session as an auth reader holds it: a full session read and a catalog
 *  row both satisfy it. */
export type SessionAuthSubject = SessionAuthFacts & (
  | { readonly kind: "workflow-agent"; readonly workflowMembership: { readonly workflowId: string } }
  | { readonly kind: "chat" | "subagent" | "workflow" }
)

/** Session facts needed while reconciling one resident auth scope. */
export type ResidentSessionAuthFacts = SessionAuthSubject & {
  readonly lifecycleState: SessionLifecycleState
}

/** The workflow runs that own the profile of their agents. */
export interface WorkflowAuthRuns {
  read(workflowId: string): Promise<Pick<WorkflowRunRecord, "authProfileId"> | null>
}

/** The selection a session runs on. An agent of a workflow has no selection
 *  of its own: it runs on its workflow's, which the run owns, so a profile
 *  that an earlier build copied onto the agent's metadata is never read.
 *  Rejects when the agent's workflow does not exist. */
export async function sessionAuthFacts(session: SessionAuthSubject, runs: WorkflowAuthRuns): Promise<SessionAuthFacts> {
  if (session.kind !== "workflow-agent") return session
  const { workflowId } = session.workflowMembership
  const run = await runs.read(workflowId)
  if (!run) throw new Error(`Workflow not found: ${workflowId}`)
  return run.authProfileId === undefined ? {} : { authProfileId: run.authProfileId }
}

/** Resolves one session's profile against the current defaults profile. An
 *  environment-selected default overrides every persisted choice. */
export function resolveSessionAuthProfile(
  session: SessionAuthFacts,
  defaults: AuthProfileResolution,
  userDataRoot: string,
): AuthProfileResolution {
  const selectedId = session.authProfileId ?? defaults.persistedId
  const persistedId = defaults.retirements[selectedId] ?? selectedId
  const profileId = defaults.source === "environment" ? defaults.id : persistedId
  const descriptor = defaults.availableProfiles.find((profile) => profile.id === profileId)
  return {
    ...defaults,
    id: profileId,
    persistedId,
    displayName: descriptor?.displayName ?? profileId,
    directory: authDir(userDataRoot, profileId),
  }
}

/** Resolves one runtime scope against the current defaults profile. */
export async function resolveAuthProfileScope(
  scope: RuntimeAuthStatusScope,
  defaults: AuthProfileResolution,
  manager: AuthScopeSessionManager,
  runs: WorkflowAuthRuns,
  userDataRoot: string,
): Promise<AuthProfileResolution> {
  if (scope.kind === "defaults") return defaults
  const session = await manager.read(scope.sessionId)
  if (!session) throw new Error(`Session not found: ${scope.sessionId}`)
  return resolveSessionAuthProfile(await sessionAuthFacts(session, runs), defaults, userDataRoot)
}

/** Resolves one persisted profile available to the current account. */
export function resolveOwnedAuthProfile(
  profileId: string,
  defaults: AuthProfileResolution,
  userDataRoot: string,
): AuthProfileResolution | undefined {
  if (defaults.id === profileId) return defaults
  const descriptor = defaults.availableProfiles.find((candidate) => candidate.id === profileId)
  if (!descriptor) return undefined
  return { ...defaults, id: profileId, persistedId: profileId, displayName: descriptor.displayName, directory: authDir(userDataRoot, profileId) }
}

/** Lists active sessions plus inactive sessions whose scopes a client observed. */
export async function listActiveAndObservedAuthSessions(
  manager: AuthScopeCatalogManager,
  observedSessionIds: ReadonlySet<string>,
): Promise<readonly DurableSessionCatalogRow[]> {
  const active = await manager.listActive()
  const rows = new Map(active.sessions.map((row) => [row.id, row]))
  if (observedSessionIds.size === 0) return [...rows.values()]
  const observed = await manager.listForIds([...observedSessionIds])
  for (const row of observed.sessions) rows.set(row.id, row)
  return [...rows.values()]
}

/** Lists active and observed session scopes backed by one profile. Inactive
 * children can have open views without an active runner. Unobserved history
 * receives no patches. */
export async function authScopesForProfile(
  profile: AuthProfileResolution,
  defaults: AuthProfileResolution,
  manager: AuthScopeCatalogManager,
  runs: WorkflowAuthRuns,
  userDataRoot: string,
  observedSessionIds: ReadonlySet<string> = new Set(),
): Promise<readonly RuntimeAuthStatusScope[]> {
  const backedBy = (resolved: AuthProfileResolution) => resolved.id === profile.id && resolved.directory === profile.directory
  const sessions = await listActiveAndObservedAuthSessions(manager, observedSessionIds)
  const backed = await Promise.all(sessions.map(async (row) => backedBy(resolveSessionAuthProfile(await sessionAuthFacts(row, runs), defaults, userDataRoot))))
  return [
    ...(backedBy(defaults) ? [{ kind: "defaults" as const }] : []),
    ...sessions.filter((_row, index) => backed[index]).map((row) => ({ kind: "session" as const, sessionId: row.id })),
  ]
}
