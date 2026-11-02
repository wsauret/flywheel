import { HashMap, Option } from "effect"
import { errorMessage } from "../../infra/error-message.js"
import { createEventProjection, parseProjectionFact, type EventProjection, type PositionedEventProjection } from "../../infra/event-projection.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { CorruptEventRowError, type AsyncEventReadSurface, type EventReader, type StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { canonicalRoleId } from "../config/retired-config-names.js"
import { normalizeRoleAssignmentSnapshot, normalizeRoleAssignments, recoverRoleAssignmentSnapshot, type ReplayedSession, type RoleAssignmentSnapshot } from "./schemas.js"
import { decodeSessionMetadataFactForReplay, type ReplayedSessionMetadataFact } from "./session-metadata-facts.js"

export type SessionMetadataProjectionState = {
  sessions: StringMap<ReplayedSession>
  /** Tombstoned ids. Later facts for these sessions are superseded leftovers,
   *  not corruption, so the reducer drops them silently. */
  deleted: StringMap<true>
  /** Per-session corruption captured as state (reason by id) so one bad
   *  session cannot poison the workspace-wide projection. Errored sessions
   *  are removed from `sessions` until a created/deleted fact resets them. */
  errors: StringMap<string>
}

type ActiveSessionCandidateState = {
  candidates: StringMap<true>
}

const SESSION_METADATA_FACT_TYPES = [
  "session.created",
  "session.auth.profile.selected",
  "session.label.updated",
  "session.lifecycle.changed",
  "session.chat_metadata.updated",
  "session.execution_cwd.updated",
  "session.roles.snapshotted",
  "session.roles.updated",
  "session.roles.removed",
  "session.child.linked",
  "session.child.unlinked",
  "session.ownership.adopted",
  "session.deleted",
  "session.representation.retired",
] as const
const ACTIVE_SESSION_CANDIDATE_FACT_TYPES = [
  "session.created",
  "session.lifecycle.changed",
  "session.deleted",
  "session.representation.retired",
] as const

const log = Log.create({ service: "session-metadata-projection" })

/** The one workspace catalog: every session's metadata, for listing. */
export function createSessionMetadataProjection(reader: AsyncEventReadSurface): EventProjection<SessionMetadataProjectionState> {
  return heldProjection(reader, "session-metadata", () => createEventProjection(reader, {
    name: "session-metadata",
    factTypes: SESSION_METADATA_FACT_TYPES,
    initialState,
    draft: draftState,
    reduce: reduceSessionMetadataEvent,
    // Invalid-JSON payloads are the same corruption class as schema-invalid
    // ones, one layer lower; both land in the per-session `errors` state so
    // one damaged row cannot empty the workspace catalog.
    reduceCorruptRow: (state, corrupt) => withError(state, corrupt.sessionId, corrupt.message),
  }))
}

/** One session's metadata, folded from its own aggregate. Opening a chat and
 *  resolving its roles need one session, and on a workspace of hundreds the
 *  catalog fold is the largest cost on the path to a ready prompt, so a
 *  single-session read never folds the workspace. The key names its own
 *  registry family: sharing the catalog's family would evict the catalog after
 *  sixty-four distinct reads and refold the workspace on the next listing. The
 *  same reducer folds both, so the two can never disagree about a session. */
export function createSingleSessionMetadataProjection(
  reader: AsyncEventReadSurface,
  sessionId: string,
): EventProjection<SessionMetadataProjectionState> {
  return heldProjection(reader, `session-metadata-one:${sessionId}`, () => createEventProjection(reader, {
    name: `session-metadata:${sessionId}`,
    aggregateId: `session:${sessionId}`,
    factTypes: SESSION_METADATA_FACT_TYPES,
    initialState,
    draft: draftState,
    reduce: reduceSessionMetadataEvent,
    reduceCorruptRow: (state, corrupt) => withError(state, corrupt.sessionId, corrupt.message),
  }))
}

/** The facts that place a session in the tree: its creation names its kind and
 *  the parent that launched it, an adoption moves it under another parent, and
 *  a deletion or retirement ends it. */
const SESSION_PLACEMENT_FACT_TYPES = [
  "session.created",
  "session.ownership.adopted",
  "session.representation.retired",
  "session.deleted",
] as const

/** Every session's metadata, each session folded apart from the others. A
 *  fact reads and changes only its own session's entries, so a fold of one
 *  session's facts states that session as the workspace fold does, and a
 *  change copies one session's entries instead of the workspace's. */
type PerSessionMetadataState = { readonly bySession: HashMap.HashMap<string, SessionMetadataProjectionState> }

/** The metadata state of session `id` within `state`, empty for a session it does not hold. */
export function sessionMetadataStateOf(state: PerSessionMetadataState, id: string): SessionMetadataProjectionState {
  return Option.getOrUndefined(HashMap.get(state.bySession, id)) ?? initialState()
}

function foldSessionEntries(state: PerSessionMetadataState, id: string, fold: (draft: SessionMetadataProjectionState) => SessionMetadataProjectionState): PerSessionMetadataState {
  return { bySession: HashMap.set(state.bySession, id, fold(draftState(sessionMetadataStateOf(state, id)))) }
}

function initialPerSessionState(): PerSessionMetadataState {
  return { bySession: HashMap.empty() }
}

/** Every session's place in the tree, folded by the metadata reducer from the
 *  placement facts alone. Owners that walk ancestors on every commit read it
 *  instead of a session's whole metadata. The fields that other facts change,
 *  such as the label or the lifecycle state, are not current in this state. */
export function createSessionPlacementProjection(reader: AsyncEventReadSurface): PositionedEventProjection<PerSessionMetadataState> {
  return heldProjection(reader, "session-placement", () => createEventProjection(reader, {
    name: "session-placement",
    factTypes: SESSION_PLACEMENT_FACT_TYPES,
    initialState: initialPerSessionState,
    reduce: (state, event) => foldSessionEntries(state, event.sessionId, (draft) => reduceSessionMetadataEvent(draft, event)),
    reduceCorruptRow: (state, corrupt) => foldSessionEntries(state, corrupt.sessionId, (draft) => withError(draft, corrupt.sessionId, corrupt.message)),
  }))
}

/** Returns conservative active-session candidates without folding the workspace
 * catalog. The session reducer remains the lifecycle authority: callers must
 * confirm these ids through the targeted metadata reader. */
export async function listActiveSessionCandidateIds(reader: AsyncEventReadSurface): Promise<readonly string[]> {
  const projection = heldProjection(reader, "session-active-candidates", () => createEventProjection(reader, {
    name: "session-active-candidates",
    factTypes: ACTIVE_SESSION_CANDIDATE_FACT_TYPES,
    initialState: (): ActiveSessionCandidateState => ({ candidates: {} }),
    draft: (state): ActiveSessionCandidateState => ({ candidates: { ...state.candidates } }),
    reduce: reduceActiveSessionCandidateEvent,
    // A corrupt queried row cannot safely exclude a session. The targeted
    // reducer read decides whether the candidate is actually active.
    reduceCorruptRow: (state, corrupt) => {
      state.candidates[corrupt.sessionId] = true
      return state
    },
  }))
  return Object.keys((await projection.replay()).candidates)
}

export function sessionsFromProjection(state: Pick<SessionMetadataProjectionState, "sessions">): Array<{ id: string; data: ReplayedSession }> {
  return Object.entries(state.sessions)
    .map(([id, data]) => ({ id, data, updatedAt: Date.parse(data.lastUpdated) }))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(({ id, data }) => ({ id, data }))
}

/** Recovers only fields that survive the strict metadata boundary. Async live
 * reads share one advancing workspace fold; synchronous migration readers
 * replay the requested aggregate from its start. */
export function recoverSessionMetadata(reader: EventReader, sessionId: string): ReplayedSession | null
export function recoverSessionMetadata(reader: AsyncEventReadSurface, sessionId: string): Promise<ReplayedSession | null>
export function recoverSessionMetadata(reader: AsyncEventReadSurface | EventReader, sessionId: string): Promise<ReplayedSession | null> | ReplayedSession | null {
  const query = {
    aggregateId: `session:${sessionId}`,
    types: SESSION_METADATA_FACT_TYPES,
  }
  if ("readTolerant" in reader) return foldRecoverableSessionMetadata(reader.readTolerant(query)).sessions[sessionId] ?? null
  return recoverableMetadataProjection(reader).replay().then((state) => sessionMetadataStateOf(state, sessionId).sessions[sessionId] ?? null)
}

function recoverableMetadataProjection(reader: AsyncEventReadSurface) {
  return heldProjection(reader, "session-metadata-recovery", () => createEventProjection(reader, {
    name: "session-metadata-recovery",
    factTypes: SESSION_METADATA_FACT_TYPES,
    initialState: initialPerSessionState,
    reduce: (state, event) => foldSessionEntries(state, event.sessionId, (draft) => foldRecoverableSessionMetadata([event], draft)),
    reduceCorruptRow: (state) => state,
  }))
}

// Skips each fact that would error its session. A fact reads and changes only
// its own session's entries, so it folds into a draft of those entries alone,
// which replaces them only when the session stays readable.
function foldRecoverableSessionMetadata(
  events: readonly (StoredFact | CorruptEventRowError)[],
  state = initialState(),
): SessionMetadataProjectionState {
  for (const event of events) {
    if (event instanceof CorruptEventRowError) continue
    const id = event.sessionId
    const draft = reduceSessionMetadataEvent({
      sessions: entryOf(state.sessions, id),
      deleted: entryOf(state.deleted, id),
      errors: entryOf(state.errors, id),
    }, event)
    if (draft.errors[id] !== undefined) continue
    setEntry(state.sessions, id, draft.sessions[id])
    setEntry(state.deleted, id, draft.deleted[id])
  }
  return state
}

function entryOf<V>(record: StringMap<V>, id: string): StringMap<V> {
  const value = record[id]
  return value === undefined ? {} : { [id]: value }
}

function setEntry<V>(record: StringMap<V>, id: string, value: V | undefined): void {
  // oxlint-disable-next-line typescript/no-dynamic-delete -- the fold edits a catch-up's own draft in place; a copying omit would make it quadratic again.
  if (value === undefined) delete record[id]
  else record[id] = value
}

function initialState(): SessionMetadataProjectionState {
  return { sessions: {}, deleted: {}, errors: {} }
}

function draftState(state: SessionMetadataProjectionState): SessionMetadataProjectionState {
  return { sessions: { ...state.sessions }, deleted: { ...state.deleted }, errors: { ...state.errors } }
}

// Total over arbitrary stored events: anything malformed lands in
// `state.errors` instead of throwing, so one corrupt session cannot poison
// the workspace-wide projection or block listing the rest. A creation or
// profile row that no rule reads errors the session; an unreadable decoration
// is reported and skipped, because the session it decorates is still the one
// the preceding rows describe. It changes the state it is given, which is a
// draft the caller owns, and only the entries of the fact's own session.
export function reduceSessionMetadataEvent(
  state: SessionMetadataProjectionState,
  event: StoredFact,
): SessionMetadataProjectionState {
  const id = event.sessionId
  const identity = event.type === "session.created" || event.type === "session.auth.profile.selected"
  let fact: ReplayedSessionMetadataFact | undefined
  try {
    fact = decodeStoredSessionMetadataFactForReplay(event)
  } catch (err) {
    if (identity) return withError(state, id, errorMessage(err))
    log.warn("session metadata decoration skipped", { sessionId: id, eventType: event.type, eventId: event.id, reason: errorMessage(err) })
    return state
  }
  if (!fact) {
    if (identity) return withError(state, id, "unrecoverable session metadata")
    log.warn("session metadata decoration skipped", { sessionId: id, eventType: event.type, eventId: event.id, reason: "no registered version reads it" })
    return state
  }

  const existing = state.sessions[id]
  switch (fact.type) {
    case "session.created":
      state.sessions[id] = replayCreatedSession(fact.payload)
      setEntry(state.deleted, id, undefined)
      setEntry(state.errors, id, undefined)
      return state
    case "session.auth.profile.selected":
      if (!existing) return withoutProducer(state, event)
      return putSession(state, id, { ...existing, authProfileId: fact.payload.authProfileId })
    case "session.label.updated":
      if (!existing) return withoutProducer(state, event)
      // User naming wins at replay: a generated title fact that raced past the
      // writer's pre-append gate is refused here too, whatever the commit order.
      if (existing.userNamed && fact.payload.userNamed !== true) return state
      return putSession(state, id, { ...existing, ...fact.payload })
    case "session.lifecycle.changed":
      if (!existing) return withoutProducer(state, event)
      return putSession(state, id, { ...existing, ...fact.payload })
    case "session.chat_metadata.updated":
      if (!existing) return withoutProducer(state, event)
      if (existing.kind === "workflow") {
        return withError(state, id, `cannot apply chat metadata update to workflow session ${id}`)
      }
      return putSession(state, id, { ...existing, ...fact.payload })
    case "session.execution_cwd.updated":
      if (!existing) return withoutProducer(state, event)
      return putSession(state, id, { ...existing, ...fact.payload, executionCwd: fact.payload.executionCwd })
    case "session.roles.snapshotted": {
      if (!existing) return withoutProducer(state, event)
      const roles: RoleAssignmentSnapshot = fact.version === 4
        ? normalizeRoleAssignmentSnapshot(fact.payload.roles)
        : recoverRoleAssignmentSnapshot(fact.payload.roles)
      return putSession(state, id, { ...existing, roleAssignments: roles, lastUpdated: fact.payload.lastUpdated })
    }
    case "session.roles.updated":
      if (!existing) return withoutProducer(state, event)
      if (existing.roleAssignments === undefined) return withError(state, id, `role assignment update before snapshot for ${id}`)
      return putSession(state, id, {
        ...existing,
        roleAssignments: {
          ...existing.roleAssignments,
          overrides: {
            ...existing.roleAssignments.overrides,
            ...normalizeRoleAssignments({ [fact.payload.roleId]: fact.payload.assignment }),
          },
        },
        lastUpdated: fact.payload.lastUpdated,
      })
    case "session.roles.removed":
      if (!existing) return withoutProducer(state, event)
      if (existing.roleAssignments === undefined) return withError(state, id, `role assignment removal before snapshot for ${id}`)
      return putSession(state, id, {
        ...existing,
        roleAssignments: {
          defaults: omitKey(existing.roleAssignments.defaults, canonicalRoleId(fact.payload.roleId)),
          overrides: omitKey(existing.roleAssignments.overrides, canonicalRoleId(fact.payload.roleId)),
        },
        lastUpdated: fact.payload.lastUpdated,
      })
    case "session.child.linked":
      if (!existing) return withoutProducer(state, event)
      return putSession(state, id, linkChild(existing, fact.payload.childSessionId))
    case "session.child.unlinked":
      if (!existing) return withoutProducer(state, event)
      return putSession(state, id, unlinkChild(existing, fact.payload.childSessionId))
    case "session.ownership.adopted":
      if (!existing) return withoutProducer(state, event)
      if (existing.kind === "chat") {
        return withError(state, id, `cannot apply workflow ownership adoption to ${existing.kind} session ${id}`)
      }
      return putSession(state, id, {
        ...existing,
        launchedFrom: {
          parentSessionId: fact.payload.parentSessionId,
          conversationId: fact.payload.parentConversationId,
          toolUseId: fact.payload.toolUseId,
        },
        lastUpdated: fact.payload.lastUpdated,
      })
    case "session.representation.retired":
    case "session.deleted":
      setEntry(state.sessions, id, undefined)
      state.deleted[id] = true
      setEntry(state.errors, id, undefined)
      return state
  }
}

function reduceActiveSessionCandidateEvent(
  state: ActiveSessionCandidateState,
  event: StoredFact,
): ActiveSessionCandidateState {
  let fact: ReplayedSessionMetadataFact | undefined
  try {
    fact = decodeStoredSessionMetadataFactForReplay(event)
  } catch {
    if (event.type === "session.created") state.candidates[event.sessionId] = true
    return state
  }
  if (!fact) {
    if (event.type === "session.created") state.candidates[event.sessionId] = true
    return state
  }

  if (fact.type === "session.deleted" || fact.type === "session.representation.retired") {
    setEntry(state.candidates, event.sessionId, undefined)
  } else if (
    (fact.type === "session.created" || fact.type === "session.lifecycle.changed")
    && fact.payload.lifecycleState === "active"
  ) {
    state.candidates[event.sessionId] = true
  } else if (fact.type === "session.created" || fact.type === "session.lifecycle.changed") {
    setEntry(state.candidates, event.sessionId, undefined)
  }
  return state
}

function decodeStoredSessionMetadataFactForReplay(event: StoredFact): ReplayedSessionMetadataFact | undefined {
  return parseProjectionFact(event, (value) => decodeSessionMetadataFactForReplay(value, event.timestamp))
}

function putSession(state: SessionMetadataProjectionState, id: string, session: ReplayedSession): SessionMetadataProjectionState {
  state.sessions[id] = session
  return state
}

function withError(state: SessionMetadataProjectionState, id: string, reason: string): SessionMetadataProjectionState {
  log.warn("session metadata projection error", { sessionId: id, reason })
  setEntry(state.sessions, id, undefined)
  state.errors[id] = reason
  return state
}

function withoutProducer(state: SessionMetadataProjectionState, event: StoredFact): SessionMetadataProjectionState {
  if (state.deleted[event.sessionId]) return state
  return withError(state, event.sessionId, `session.created has not been observed for ${event.sessionId} (${event.id})`)
}

function omitKey<V>(record: StringMap<V>, id: string): StringMap<V> {
  if (!(id in record)) return record
  const { [id]: _removed, ...rest } = record
  return rest
}

// A child that joins or leaves a session is not that session's own activity,
// so its time stays: forking a chat must not show the source as just used.
function linkChild(session: ReplayedSession, childSessionId: string): ReplayedSession {
  const children = session.childSessionIds ?? []
  if (children.includes(childSessionId)) return session
  return { ...session, childSessionIds: [...children, childSessionId] }
}

function unlinkChild(session: ReplayedSession, childSessionId: string): ReplayedSession {
  const children = session.childSessionIds ?? []
  if (!children.includes(childSessionId)) return session
  const nextChildren = children.filter((child) => child !== childSessionId)
  const updated: ReplayedSession = { ...session, childSessionIds: nextChildren }
  if (nextChildren.length === 0) delete updated.childSessionIds
  return updated
}

function replayCreatedSession(session: ReplayedSession): ReplayedSession {
  return session.roleAssignments === undefined
    ? session
    : { ...session, roleAssignments: normalizeRoleAssignmentSnapshot(session.roleAssignments) }
}
interface StringMap<T> { [key: string]: T }
