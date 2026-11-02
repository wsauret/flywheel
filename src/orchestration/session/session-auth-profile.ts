import type { AuthProfileManager, AuthProfileResolution } from "../auth/auth-profile-manager.js"
import type { ReplayedSession } from "./schemas.js"
import type { WorkflowAuthOwner } from "../workflow-host/auth-owner.js"

export interface SessionAuthProfileSelection {
  readonly persistedId: string
  readonly effectiveId: string
}

interface SessionAuthRuntimeSnapshot<Prepared> {
  readonly profile: SessionAuthProfileSelection
  readonly workflowDeps: Prepared
}

/** The runtime admission path for default-scoped and session-scoped request execution. */
export interface SessionAuthAdmission<Prepared> {
  admitDefaults(): Promise<SessionAuthRuntimeSnapshot<Prepared>>
  admit(sessionId: string): Promise<SessionAuthRuntimeSnapshot<Prepared>>
  admitWorkflow(workflowId: string): Promise<SessionAuthRuntimeSnapshot<Prepared>>
  currentWorkflow(workflowId: string): SessionAuthRuntimeSnapshot<Prepared>
  /** The revision the session last admitted. Throws only for a session that never admitted. */
  current(sessionId: string): SessionAuthRuntimeSnapshot<Prepared>
  invalidate(profileId: string): readonly string[]
  dispose(): Promise<void>
}

export interface SessionAuthAdmissionDeps<Prepared> {
  readonly manager: SessionAuthProfileManager
  /** Current descriptor-contained selection read. Admission cannot acquire the profile mutation lock. */
  readonly authProfiles: Pick<AuthProfileManager, "inspect">
  readonly prepare: (profileId: string) => Promise<Prepared>
  /** Fresh storage identity, including refusal conditions as well as bytes. */
  readonly observe?: (profileId: string) => string
  readonly preparedObservation?: (prepared: Prepared) => string
  readonly materialize: SessionAuthProfileMaterializer
  readonly workflows?: Pick<WorkflowAuthOwner, "snapshot">
}

/** Captures destination roles and atomically selects them only if the durable selection still matches. */
export type SessionAuthProfileMaterializer = (sessionId: string, profileId: string, expectedAuthProfileId: string | undefined) => Promise<void>

/** Creates the one profile-bound runtime authority for a set of sessions.
 *  Complete profile revisions are shared, while each session retains the last
 *  revision it admitted until its next capture. */
export function createSessionAuthAdmission<Prepared>(deps: SessionAuthAdmissionDeps<Prepared>): SessionAuthAdmission<Prepared> {
  type ProfileState = { readonly effectiveId: string; readonly workflowDeps: Prepared; readonly observation: string | undefined; readonly epoch: number }
  const profiles = new Map<string, ProfileState>()
  const sessions = new Map<string, SessionAuthRuntimeSnapshot<Prepared>>()
  const workflows = new Map<string, SessionAuthRuntimeSnapshot<Prepared>>()
  const preparations = new Map<string, { readonly promise: Promise<ProfileState>; readonly observation: string | undefined; readonly epoch: number }>()
  const invalidations = new Map<string, number>()
  let disposed = false

  const ensureOpen = (): void => { if (disposed) throw new Error("session auth admission is disposed") }
  const epoch = (profileId: string): number => invalidations.get(profileId) ?? 0

  async function prepare(profileId: string): Promise<ProfileState> {
    ensureOpen()
    const observation = deps.observe?.(profileId)
    const cached = profiles.get(profileId)
    if (cached?.observation === observation && cached !== undefined) return cached
    profiles.delete(profileId)
    const pending = preparations.get(profileId)
    const expectedEpoch = pending?.epoch ?? epoch(profileId)
    const expectedObservation = pending?.observation ?? observation
    const operation = pending?.promise ?? (async () => {
      const workflowDeps = await deps.prepare(profileId)
      return Object.freeze({ effectiveId: profileId, workflowDeps, observation: deps.preparedObservation?.(workflowDeps) ?? observation, epoch: expectedEpoch })
    })()
    preparations.set(profileId, { promise: operation, observation: expectedObservation, epoch: expectedEpoch })
    try {
      const state = await operation
      if (preparations.get(profileId)?.promise === operation) preparations.delete(profileId)
      ensureOpen()
      if (epoch(profileId) !== state.epoch || deps.observe?.(profileId) !== state.observation) return prepare(profileId)
      profiles.set(profileId, state)
      return state
    } catch (error) {
      if (preparations.get(profileId)?.promise === operation) preparations.delete(profileId)
      if (!disposed && (epoch(profileId) !== expectedEpoch || deps.observe?.(profileId) !== expectedObservation)) return prepare(profileId)
      throw error
    }
  }

  async function workflowProfile(workflowId: string): Promise<SessionAuthProfileSelection> {
    if (!deps.workflows) throw new Error("Workflow auth admission is unavailable")
    const profile = await deps.workflows.snapshot(workflowId)
    return { persistedId: profile.persistedId, effectiveId: profile.id }
  }

  return {
    async admitDefaults() {
      ensureOpen()
      const auth = deps.authProfiles.inspect()
      const profile = resolveSessionAuthProfile({}, auth)
      const state = await prepare(profile.effectiveId)
      return Object.freeze({ profile, workflowDeps: state.workflowDeps })
    },
    async admit(sessionId) {
      ensureOpen()
      // An agent of a workflow runs on the profile its run owns. Its own
      // metadata holds no selection, and admission never writes one there.
      const session = await deps.manager.read(sessionId)
      const profile = session?.kind === "workflow-agent"
        ? await workflowProfile(session.workflowMembership.workflowId)
        : await ensureSessionAuthProfile({ ...deps, sessionId })
      const state = await prepare(profile.effectiveId)
      const snapshot = Object.freeze({ profile, workflowDeps: state.workflowDeps })
      sessions.set(sessionId, snapshot)
      return snapshot
    },
    async admitWorkflow(workflowId) {
      ensureOpen()
      const profile = await workflowProfile(workflowId)
      const state = await prepare(profile.effectiveId)
      const snapshot = Object.freeze({ profile, workflowDeps: state.workflowDeps })
      workflows.set(workflowId, snapshot)
      return snapshot
    },
    currentWorkflow(workflowId) {
      ensureOpen()
      const snapshot = workflows.get(workflowId)
      if (!snapshot) throw new Error(`Workflow auth profile has not been admitted: ${workflowId}`)
      return snapshot
    },
    current(sessionId) {
      ensureOpen()
      const state = sessions.get(sessionId)
      if (!state) throw new Error(`Session auth profile has not been admitted: ${sessionId}`)
      return state
    },
    // Invalidation retires the shared revision, so the next capture prepares a
    // new one, and names the sessions that hold it so the caller recaptures
    // them. It keeps each session's snapshot: a request that is already
    // running reads its session's revision synchronously, and a gap between
    // this call and the recapture would fail that request.
    invalidate(profileId) {
      ensureOpen()
      invalidations.set(profileId, epoch(profileId) + 1)
      profiles.delete(profileId)
      return [...sessions].flatMap(([sessionId, snapshot]) => snapshot.profile.effectiveId === profileId ? [sessionId] : [])
    },
    async dispose() {
      disposed = true
      sessions.clear()
      workflows.clear()
      profiles.clear()
      await Promise.allSettled([...preparations.values()].map(({ promise }) => promise))
      preparations.clear()
    },
  }
}

/** The session facts that decide where a session's profile comes from. */
type SessionAuthRead = Pick<ReplayedSession, "authProfileId"> & (
  | { readonly kind: "workflow-agent"; readonly workflowMembership: { readonly workflowId: string } }
  | { readonly kind: Exclude<ReplayedSession["kind"], "workflow-agent"> }
)

interface SessionAuthProfileManager {
  read(id: string): Promise<SessionAuthRead | null>
  captureAuthProfileIfAbsent(id: string, authProfileId: string): Promise<boolean>
}

interface EnsureSessionAuthProfileDeps {
  readonly manager: SessionAuthProfileManager
  readonly sessionId: string
  readonly authProfiles: Pick<AuthProfileManager, "inspect">
  readonly materialize: SessionAuthProfileMaterializer
}

/** A durable selection names a profile this account does not have, such as a
 *  run that another account's profile created in a shared project. */
export class MissingAuthProfileError extends Error {
  constructor(readonly profileId: string) {
    super(`auth profile does not exist: ${profileId}`)
  }
}

/** Resolves a session's durable profile, with an environment selector as the
 * only authority allowed to override the profile used for this process.
 * Throws `MissingAuthProfileError` when the effective profile does not exist. */
export function resolveSessionAuthProfile(
  session: Pick<ReplayedSession, "authProfileId">,
  auth: Pick<AuthProfileResolution, "id" | "persistedId" | "source" | "availableProfiles" | "retirements">,
): SessionAuthProfileSelection {
  const selectedId = session.authProfileId ?? auth.persistedId
  const persistedId = auth.retirements[selectedId] ?? selectedId
  const effectiveId = auth.source === "environment" ? auth.id : persistedId
  if (!auth.availableProfiles.some((profile) => profile.id === effectiveId)) {
    throw new MissingAuthProfileError(effectiveId)
  }
  return { persistedId, effectiveId }
}

/** Materializes retirement with destination roles, or captures a missing legacy selection.
 * Resolves again from durable state so a concurrent explicit selection wins. */
export async function ensureSessionAuthProfile(deps: EnsureSessionAuthProfileDeps): Promise<SessionAuthProfileSelection> {
  // A successor can retire while its role assignments are being prepared.
  for (;;) {
    const session = await deps.manager.read(deps.sessionId)
    if (!session) throw new Error(`Session not found: ${deps.sessionId}`)
    const auth = deps.authProfiles.inspect()
    const selection = resolveSessionAuthProfile(session, auth)
    if (selection.persistedId !== (session.authProfileId ?? auth.persistedId)) {
      await deps.materialize(deps.sessionId, selection.persistedId, session.authProfileId)
      continue
    }
    if (session.authProfileId === undefined && auth.availableProfiles.some((profile) => profile.id === selection.persistedId)) {
      await deps.manager.captureAuthProfileIfAbsent(deps.sessionId, selection.persistedId)
      continue
    }
    return selection
  }
}
