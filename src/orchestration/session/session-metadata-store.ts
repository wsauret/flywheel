import type { AsyncEventReadSurface, AsyncEventStateReadSurface, AsyncEventWriter, EventStoreAppend, GuardedAppendResult, GuardedEventStoreAppend, StoredFact } from "../../infra/event-store-types.js"
import { requireGuardedEventAppender } from "../../infra/event-store-types.js"
import type { EventProjection } from "../../infra/event-projection.js"
import { Log } from "../../infra/log.js"
import { generateSessionId } from "../../infra/session-id.js"
import { loggedOperation } from "../../infra/operation-log.js"
import type { ReplayedSession, RoleSettingEntry as RoleAssignmentEntry, RoleSettings as RoleAssignments, RoleAssignmentSnapshot, Session } from "./schemas.js"
import type { SessionMetadataCatalog } from "./session-catalog-types.js"
import { sessionMetadataCatalogFromState } from "./session-catalog-read.js"
import {
  buildSessionAuthProfileSelectedFact,
  buildSessionCreatedFact,
  buildSessionRolesSnapshottedFact,
  buildSessionRolesUpdatedFact,
  parseSessionMetadataFact,
  type SessionMetadataFact,
} from "./session-metadata-facts.js"
import { createSessionMetadataProjection, createSessionPlacementProjection, createSingleSessionMetadataProjection, recoverSessionMetadata, sessionMetadataStateOf, type SessionMetadataProjectionState } from "./session-metadata-projection.js"
import { createPushFedView } from "../../infra/push-fed-view.js"
import { isValidTransition, type SessionLifecycleState } from "./types.js"
import { effectiveSessionShortTitle } from "../../protocol/app-service-types.js"

interface SessionMetadataStoreDeps {
  reader: AsyncEventStateReadSurface
  writer: AsyncEventWriter
}

const log = Log.create({ service: "session-metadata-store" })

/** Outcome of a lifecycle transition validated against a sequence-guarded read. */
export type LifecycleTransitionResult =
  | { kind: "transitioned"; from: SessionLifecycleState; to: SessionLifecycleState }
  | { kind: "noop" }
  | { kind: "missing" }
  | { kind: "invalid"; from: SessionLifecycleState; to: SessionLifecycleState }

/** Who is writing the label: an explicit user rename wins over generated titles. */
export type SessionLabelSource = "user" | "generated"


interface SessionMetadataStore {
  allocateId(): string
  create(session: Session, id?: string, initialRoles?: RoleAssignments): Promise<string>
  read(id: string): Promise<ReplayedSession | null>
  readOrThrow(id: string): Promise<ReplayedSession>
  list(): Promise<SessionMetadataCatalog>
  /** Catalog scoped to specific ids. Separate from list() because a scoped
   *  lookup must not build and sort every session in the workspace: the TUI
   *  resolves one session per change on this path. */
  listForIds(ids: readonly string[]): Promise<SessionMetadataCatalog>
  /** Validates against the transition table and guards publication with the
   *  aggregate sequence captured before reading. A conflict is re-read to
   *  report missing/noop/invalid; otherwise the conflict is thrown for the caller. */
  transitionLifecycle(id: string, to: SessionLifecycleState): Promise<LifecycleTransitionResult>
  /** Merge supplied fields with the latest sequence-guarded metadata and publish the combined label fact.
   *  Idempotent for missing aggregates: returns false when the row does not exist.
   *  A `user` write marks the session user-named; once it is, `generated`
   *  writes are refused - user naming wins. */
  updateLabel(id: string, labels: { label?: string; shortLabel?: string }, source: SessionLabelSource): Promise<boolean>
  /** Idempotent for missing aggregates: returns false when the row does not exist.
   *  Still throws when the row exists but is not a chat. */
  updateChatMetadata(id: string, patch: { providerConversationId?: string; seedContext?: string }): Promise<boolean>
  captureRolesIfAbsent(id: string, roles: RoleAssignments): Promise<boolean>
  captureAuthProfileIfAbsent(id: string, authProfileId: string): Promise<boolean>
  selectAuthProfile(id: string, authProfileId: string): Promise<boolean>
  /** Writes profile and roles together; an expected selection prevents replacing a concurrent choice. */
  selectAuthProfileWithRoleSnapshot(id: string, authProfileId: string, roles: RoleAssignments, expected?: { readonly authProfileId: string | undefined }): Promise<boolean>
  /** Replaces role assignments. When `expectedSnapshot` is present, returns
   * false if the session is missing or any concurrent metadata write wins. */
  replaceRoleSnapshot(id: string, roles: RoleAssignments, overrides?: RoleAssignments, expectedSnapshot?: RoleAssignmentSnapshot): Promise<boolean>
  updateRoleAssignment(id: string, roleId: string, assignment: RoleAssignmentEntry): Promise<boolean>
  removeRoleAssignment(id: string, roleId: string): Promise<boolean>
  unlinkChild(parentId: string, childId: string): Promise<void>
  /** Atomic multi-fact append that keeps the long-lived projection fresh:
   *  the batch commits in one transaction and every stored metadata-typed fact
   *  is applied to the projection before the promise resolves, so a subsequent
   *  `list()` can never miss it. Sibling-domain facts batched for atomicity
   *  (e.g. the queue tombstone accompanying a session delete) pass through the
   *  store untouched and are ignored by the projection's type filter. */
  appendFacts(events: readonly EventStoreAppend[]): Promise<StoredFact[]>
  appendGuardedFacts(events: readonly GuardedEventStoreAppend[]): Promise<GuardedAppendResult>
}

/** A session's kind and the parent that launched it. */
export type SessionPlacement = Pick<ReplayedSession, "kind" | "launchedFrom">

/** Where sessions sit in the tree, for an owner that walks ancestors on every commit. */
export interface SessionPlacements {
  /** The place of session `id`, or null for a session the store does not
   *  hold. The first read folds the placement facts of the workspace; later
   *  reads make no durable request until `observe` meets a placement fact or
   *  a batch after facts it never met, such as another process's commits. */
  placement(id: string): Promise<SessionPlacement | null>
  /** Advances the placements by a committed batch. A caller passes every
   *  batch it observes, before it reads. */
  observe(events: readonly StoredFact[]): void
}

/** The session placements of `reader`, from the metadata reducer's fold of
 *  the placement facts alone. A session whose placement facts cannot be read
 *  falls back to the metadata recovery fold, as `read` does. */
export function createSessionPlacements(reader: AsyncEventReadSurface): SessionPlacements {
  const placements = createPushFedView(() => createSessionPlacementProjection(reader))
  return {
    async placement(id) {
      const session = await sessionFromMetadataState(reader, id, sessionMetadataStateOf(await placements.read(), id))
      return session && { kind: session.kind, ...(session.launchedFrom ? { launchedFrom: session.launchedFrom } : {}) }
    },
    observe: placements.observe,
  }
}

/** Reads one session through its held strict projection. If strict replay
 * quarantines the aggregate, the reviewed metadata recovery fold returns the
 * independently recoverable fields. Missing and unrecoverable sessions return
 * null. The read sees cross-process writes and never folds the workspace. */
export async function readSessionMetadata(reader: AsyncEventStateReadSurface, id: string): Promise<ReplayedSession | null> {
  return sessionFromMetadataState(reader, id, await createSingleSessionMetadataProjection(reader, id).replay())
}

async function sessionFromMetadataState(reader: AsyncEventReadSurface, id: string, state: SessionMetadataProjectionState): Promise<ReplayedSession | null> {
  return state.sessions[id] ?? (state.errors[id] ? await recoverSessionMetadata(reader, id) : null)
}

export function buildSessionMetadataAppend(
  sessionId: string,
  fact: SessionMetadataFact,
  timestamp = Date.now(),
): EventStoreAppend {
  const parsed = parseSessionMetadataFact(fact)
  return {
    aggregateId: `session:${sessionId}`,
    type: parsed.type,
    version: parsed.version,
    timestamp,
    actor: parsed.actor,
    sessionId,
    payload: parsed.payload,
  }
}

export function createSessionMetadataStore(deps: SessionMetadataStoreDeps): SessionMetadataStore {
  // The workspace projection is created only by list(). Until then, targeted
  // operations borrow held aggregate projections, whose replay catches up
  // cross-process commits without folding unrelated sessions, so opening a
  // chat never pays the workspace fold. Once list() built it, targeted reads
  // use it too: the registry holds sixty-four aggregate projections, so a
  // reader that cycles through more sessions, such as the agents of one large
  // workflow, would rebuild each session on every read. The two folds agree,
  // because every metadata fact commits to its own session's aggregate.
  let projection: EventProjection<SessionMetadataProjectionState> | null = null
  const writer = deps.writer
  const guardedWriter = () => requireGuardedEventAppender(writer, "Session metadata guarded writes require guarded append authority")
  const metadataProjection = (): EventProjection<SessionMetadataProjectionState> => {
    projection ??= createSessionMetadataProjection(deps.reader)
    return projection
  }
  const targetedProjection = (id: string): EventProjection<SessionMetadataProjectionState> =>
    projection ?? createSingleSessionMetadataProjection(deps.reader, id)

  async function appendFact(sessionId: string, fact: SessionMetadataFact): Promise<StoredFact> {
    return loggedOperation(
      { log, operation: "append fact", level: "debug", fields: { sessionId, eventType: fact.type }, summarize: (stored) => ({ position: stored.position, seq: stored.seq }) },
      async () => {
        const stored = await writer.append(buildSessionMetadataAppend(sessionId, fact))
        await projection?.apply(stored)
        return stored
      },
    )
  }

  async function appendFacts(events: readonly EventStoreAppend[]): Promise<StoredFact[]> {
    return loggedOperation(
      { log, operation: "append facts", level: "debug", fields: { events: events.length, factTypes: [...new Set(events.map((event) => event.type))].slice(0, 12), sessions: [...new Set(events.map((event) => event.sessionId))].slice(0, 12) }, summarize: (stored) => ({ stored: stored.length, firstPosition: stored[0]?.position, lastPosition: stored.at(-1)?.position }) },
      async () => {
        const stored = await writer.appendBatch(events)
        await projection?.apply(stored)
        return stored
      },
    )
  }

  async function appendGuardedFacts(events: readonly GuardedEventStoreAppend[]): Promise<GuardedAppendResult> {
    const result = await guardedWriter().appendBatchGuarded(events)
    if (result.kind === "stored") await projection?.apply(result.events)
    return result
  }

  async function read(id: string): Promise<ReplayedSession | null> {
    return sessionFromMetadataState(deps.reader, id, await targetedProjection(id).replay())
  }

  async function readOrThrow(id: string): Promise<ReplayedSession> {
    const session = await read(id)
    if (!session) throw new Error(`Session not found: ${id}`)
    return session
  }

  async function create(session: Session, id = generateSessionId(), initialRoles?: RoleAssignments): Promise<string> {
    const events: GuardedEventStoreAppend[] = [{
      ...buildSessionMetadataAppend(id, buildSessionCreatedFact(session)),
      expectedSeq: 0,
    }]
    if (session.authProfileId !== undefined) {
      events.push({
        ...buildSessionMetadataAppend(id, buildSessionAuthProfileSelectedFact(session.authProfileId)),
        expectedSeq: events.length,
      })
    }
    if (initialRoles !== undefined) {
      events.push({
        ...buildSessionMetadataAppend(id, buildSessionRolesSnapshottedFact({}, session.lastUpdated, initialRoles)),
        expectedSeq: events.length,
      })
    }
    const result = await appendGuardedFacts(events)
    if (result.kind === "conflict") throw new Error(`Session already exists: ${id}`, { cause: result.conflict })
    return id
  }

  async function list(): Promise<SessionMetadataCatalog> {
    return loggedOperation(
      // Read path: the TUI lists per store change, so a completion record here
      // lands per call and tells a diagnostician nothing a failure would not.
      { log, operation: "list catalog", level: "debug", summarize: (catalog) => ({ entries: catalog.entries.length, errors: catalog.errors.length }) },
      async () => {
        const state = await metadataProjection().replay()
        return await sessionMetadataCatalogFromState(state, deps.reader)
      },
    )
  }

  async function listForIds(ids: readonly string[]): Promise<SessionMetadataCatalog> {
    const state: SessionMetadataProjectionState = { sessions: {}, deleted: {}, errors: {} }
    await Promise.all([...new Set(ids)].map(async (id) => {
      const aggregate = await targetedProjection(id).replay()
      if (aggregate.sessions[id]) state.sessions[id] = aggregate.sessions[id]
      if (aggregate.deleted[id]) state.deleted[id] = true
      if (aggregate.errors[id]) state.errors[id] = aggregate.errors[id]
    }))
    return sessionMetadataCatalogFromState(state, deps.reader)
  }

  /** The guard keeps two transitions from both reading one state as their
   *  own. A conflict whose facts left the lifecycle as it was, such as the
   *  session's duration landing while a stop closes it, is read again and
   *  retried; one that moved the lifecycle is answered from the new state. */
  async function transitionLifecycle(id: string, to: SessionLifecycleState): Promise<LifecycleTransitionResult> {
    for (;;) {
      const expectedSeq = await deps.reader.aggregateSeq(`session:${id}`) + 1
      const existing = await read(id)
      if (!existing) return { kind: "missing" }
      const from = existing.lifecycleState
      if (from === to) return { kind: "noop" }
      if (!isValidTransition(from, to)) return { kind: "invalid", from, to }
      const now = new Date().toISOString()
      const result = await guardedWriter().appendGuarded({ ...buildSessionMetadataAppend(id, {
          type: "session.lifecycle.changed",
          version: 1,
          actor: "flywheel",
          payload: {
            lifecycleState: to,
            lastUpdated: now,
            ...(to === "active" ? { activatedAt: now } : {}),
          },
      }), expectedSeq })
      if (result.kind === "conflict") continue
      await projection?.apply(result.events)
      return { kind: "transitioned", from, to }
    }
  }

  async function updateLabel(id: string, patch: { label?: string; shortLabel?: string }, source: SessionLabelSource): Promise<boolean> {
    for (;;) {
      const expectedSeq = await deps.reader.aggregateSeq(`session:${id}`) + 1
      const existing = await read(id)
      if (!existing) return false
      if (source === "generated" && existing.userNamed) return false
      const labels = {
        label: patch.label ?? existing.label,
        shortLabel: patch.shortLabel ?? effectiveSessionShortTitle(existing.label || existing.name || id, existing.shortLabel),
      }
      const unchanged = existing.label === labels.label && existing.shortLabel === labels.shortLabel && existing.name === labels.label
      // A user rename to the already-current labels must mark the session user-named.
      if (unchanged && (source === "generated" || existing.userNamed)) return false
      const result = await guardedWriter().appendGuarded({ ...buildSessionMetadataAppend(id, {
        type: "session.label.updated",
        version: 1,
        actor: "flywheel",
        payload: {
          label: labels.label,
          shortLabel: labels.shortLabel,
          name: labels.label,
          lastUpdated: new Date().toISOString(),
          ...(source === "user" ? { userNamed: true as const } : {}),
        },
      }), expectedSeq })
      if (result.kind === "conflict") continue
      await projection?.apply(result.events)
      if (source === "generated") return (await read(id))?.label === labels.label
      return true
    }
  }

  async function updateChatMetadata(id: string, patch: { providerConversationId?: string; seedContext?: string }): Promise<boolean> {
    const existing = await read(id)
    if (!existing) return false
    if (existing.kind === "workflow") throw new Error(`Session is not a chat: ${id}`)
    const hasProviderConversationId = Object.hasOwn(patch, "providerConversationId") && patch.providerConversationId
    const hasSeedContext = Object.hasOwn(patch, "seedContext") && patch.seedContext
    const providerChanged = hasProviderConversationId && existing.providerConversationId !== patch.providerConversationId
    const seedChanged = hasSeedContext && existing.seedContext !== patch.seedContext
    if (!providerChanged && !seedChanged) return false
    await appendFact(id, {
      type: "session.chat_metadata.updated",
      version: 1,
      actor: "flywheel",
      payload: {
        ...(hasProviderConversationId ? { providerConversationId: patch.providerConversationId } : {}),
        ...(hasSeedContext ? { seedContext: patch.seedContext } : {}),
        lastUpdated: new Date().toISOString(),
      },
    })
    return true
  }


  async function captureRolesIfAbsent(id: string, roles: RoleAssignments): Promise<boolean> {
    const expectedSeq = await deps.reader.aggregateSeq(`session:${id}`) + 1
    const existing = await read(id)
    if (!existing || existing.roleAssignments !== undefined) return false
    const result = await guardedWriter().appendGuarded({
        ...buildSessionMetadataAppend(id, buildSessionRolesSnapshottedFact({}, new Date().toISOString(), roles)),
        expectedSeq,
      })
    if (result.kind === "stored") {
      await projection?.apply(result.events)
      return true
    }
    const current = await read(id)
    if (!current || current.roleAssignments !== undefined) return false
    throw new Error(`Session ${id} changed while capturing roles`, { cause: result.conflict })
  }

  async function captureAuthProfileIfAbsent(id: string, authProfileId: string): Promise<boolean> {
    const aggregateId = `session:${id}`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expectedSeq = await deps.reader.aggregateSeq(aggregateId) + 1
      const existing = await read(id)
      if (!existing || existing.authProfileId !== undefined) return false
      const result = await guardedWriter().appendGuarded({
          ...buildSessionMetadataAppend(id, buildSessionAuthProfileSelectedFact(authProfileId)),
          expectedSeq,
        })
      if (result.kind === "stored") {
        await projection?.apply(result.events)
        return true
      }
      const reread = await read(id)
      if (!reread || reread.authProfileId !== undefined) return false
      if (attempt === 1) throw new Error(`Session ${id} stayed contended while capturing auth`, { cause: result.conflict })
    }
    return false
  }

  async function selectAuthProfile(id: string, authProfileId: string): Promise<boolean> {
    const existing = await read(id)
    if (!existing) return false
    if (existing.authProfileId === authProfileId) return true
    await appendFact(id, buildSessionAuthProfileSelectedFact(authProfileId))
    return true
  }

  async function selectAuthProfileWithRoleSnapshot(id: string, authProfileId: string, roles: RoleAssignments, expected?: { readonly authProfileId: string | undefined }): Promise<boolean> {
    const aggregateId = `session:${id}`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const expectedSeq = await deps.reader.aggregateSeq(aggregateId) + 1
      const existing = await read(id)
      if (!existing || (expected !== undefined && existing.authProfileId !== expected.authProfileId)) return false
      const now = new Date()
      const result = await appendGuardedFacts([
          { ...buildSessionMetadataAppend(id, buildSessionAuthProfileSelectedFact(authProfileId), now.getTime()), expectedSeq },
          { ...buildSessionMetadataAppend(id, buildSessionRolesSnapshottedFact(existing.roleAssignments?.defaults ?? {}, now.toISOString(), roles), now.getTime()), expectedSeq: expectedSeq + 1 },
      ])
      if (result.kind === "stored") {
        return true
      }
      if (!await read(id)) return false
      if (attempt === 1) throw new Error(`Session ${id} stayed contended while selecting auth`, { cause: result.conflict })
    }
    return false
  }

  async function replaceRoleSnapshot(
    id: string,
    roles: RoleAssignments,
    overrides: RoleAssignments = {},
    expectedSnapshot?: RoleAssignmentSnapshot,
  ): Promise<boolean> {
    if (expectedSnapshot === undefined) {
      if (!await read(id)) return false
      await appendFact(id, buildSessionRolesSnapshottedFact(roles, new Date().toISOString(), overrides))
      return true
    }

    const aggregateId = `session:${id}`
    const expectedSeq = await deps.reader.aggregateSeq(aggregateId) + 1
    const existing = await read(id)
    if (!existing || !sameRoleSnapshot(existing.roleAssignments, expectedSnapshot)) return false
    const result = await guardedWriter().appendGuarded({
        ...buildSessionMetadataAppend(id, buildSessionRolesSnapshottedFact(roles, new Date().toISOString(), overrides)),
        expectedSeq,
      })
    if (result.kind === "stored") {
      await projection?.apply(result.events)
      return true
    }
    return false
  }

  async function updateRoleAssignment(id: string, roleId: string, assignment: RoleAssignmentEntry): Promise<boolean> {
    if (!await read(id)) return false
    await appendFact(id, buildSessionRolesUpdatedFact(roleId, assignment, new Date().toISOString()))
    return true
  }

  async function removeRoleAssignment(id: string, roleId: string): Promise<boolean> {
    if (!await read(id)) return false
    await appendFact(id, {
      type: "session.roles.removed",
      version: 1,
      actor: "flywheel",
      payload: { roleId, lastUpdated: new Date().toISOString() },
    })
    return true
  }

  async function unlinkChild(parentId: string, childId: string): Promise<void> {
    const existing = await read(parentId)
    if (!existing || !(existing.childSessionIds ?? []).includes(childId)) return
    await appendFact(parentId, {
      type: "session.child.unlinked",
      version: 1,
      actor: "flywheel",
      payload: { childSessionId: childId, lastUpdated: new Date().toISOString() },
    })
  }

  return {
    allocateId: generateSessionId,
    appendFacts,
    appendGuardedFacts,
    create,
    read,
    readOrThrow,
    list,
    listForIds,
    transitionLifecycle,
    updateLabel,
    updateChatMetadata,
    captureRolesIfAbsent,
    captureAuthProfileIfAbsent,
    selectAuthProfile,
    selectAuthProfileWithRoleSnapshot,
    replaceRoleSnapshot,
    updateRoleAssignment,
    removeRoleAssignment,
    unlinkChild,
  }
}

function sameRoleSnapshot(actual: RoleAssignmentSnapshot | undefined, expected: RoleAssignmentSnapshot): boolean {
  return actual !== undefined && JSON.stringify(actual) === JSON.stringify(expected)
}
