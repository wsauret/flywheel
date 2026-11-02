import { canonicalDirectory } from "../../infra/directory-authorities.js"
import { workflowRunOwner } from "../module-catalog.js"
import { asAsyncEventReadSurface, requireLocalAsyncWriter, type AsyncEventStateReadSurface, type AsyncEventWriter, type EventStoreAppend, type EventStoreReadSurface, type GuardedAppendResult, type GuardedEventStoreAppend } from "../../infra/event-store-types.js"
import { createWorkflowPublication, type WorkflowAdoption, type WorkflowCommitPublication } from "./workflow-publication.js"
import { Log } from "../../infra/log.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"
import { ensureSessionDir } from "../../infra/paths.js"
import { startupTrace } from "../../infra/startup-trace.js"
import { buildQueueDeletedFact } from "../../workflows/view/view-facts.js"
import { workflowAggregateId } from "../../workflows/vm/session-facts.js"
import { deleteSessionArtifacts, deleteWorkflowArtifacts } from "./session-artifacts.js"
import { settleUnreadMessages, type ReturnedNotice } from "./session-input-delivery.js"
import { buildSessionChildUnlinkedFact } from "./session-metadata-facts.js"
import { buildSessionMetadataAppend, createSessionMetadataStore, type SessionLabelSource } from "./session-metadata-store.js"
import type { DurableSessionCatalog } from "./session-catalog-types.js"
import { buildDurableSessionMetadataCatalog } from "./session-catalog-read.js"
import type { ReplayedSession, RoleSettingEntry as RoleAssignmentEntry, RoleSettings as RoleAssignments, RoleAssignmentSnapshot, Session } from "./schemas.js"
import { isSessionOwnerGone, writeOwnerPid } from "./pid-lock.js"
import { createConversationTree } from "./conversation/conversation-tree-handle.js"
import { ConversationTreeStorage } from "./conversation/conversation-tree-storage.js"
import { forkConversationTree } from "./conversation/conversation-tree-fork.js"
import { validateRawForkBranchWork } from "./conversation/conversation-tree-context.js"
import { runInTaskSlices } from "../../infra/task-scheduling.js"
import type { ConversationMessage } from "../agent-runtime/llm/types.js"
import { prepareChatBranchPublication } from "./session-chat-branch-publication.js"
import { readConversationCheckpoint } from "./conversation-checkpoint.js"
import { buildSessionForkedFact } from "./session-fork-facts.js"
import { contextUtilizationFromProjection, createBudgetProjection } from "./budget-projection.js"
import { createSessionLifecyclePublication } from "./session-lifecycle-publication.js"
import { listActiveSessionCandidateIds } from "./session-metadata-projection.js"
import type { SessionLifecycleState } from "./types.js"
import {
  createChildSessionDeletionState,
  type ChildSessionDeletionPlan,
  type ChildSessionDeletionTarget,
} from "./child-session-deletion.js"
import {
  createChildSessionPublication,
  prepareChildSessionPublication,
  type SubagentSessionPublication,
  type WorkflowPublication,
} from "./child-session-publication.js"

const log = Log.create({ service: "session.manager" })
const PARENT_PUBLICATION_ATTEMPTS = 3

export type SessionManagerDeps = {
  projectRoot: string
  /** Canonical directory sessions this process creates execute in (ARCH-DIRECTORIES-006).
   *  It is the default placement only: a launched child inherits its parent's
   *  directory, and an explicit placement overrides both. */
  executionCwd: string
} & ({
  /** Owned local store for offline commands, migrations, and focused tests. */
  store: EventStoreReadSurface
  /** Interactive roots supply the state Worker port. Local and offline roots
   * may omit it and use the direct adapter over their owned reader. */
  projectionReader?: AsyncEventStateReadSurface
  writer?: AsyncEventWriter
} | {
  projectionReader: AsyncEventStateReadSurface
  writer: AsyncEventWriter
})

/** What a metadata change signal carries. `deleted` names the erased session:
 *  deletion is the one catalog change a subscriber cannot reconstruct by
 *  re-reading metadata, because the read no longer contains the evidence. */
export type SessionMetadataChange =
  | { kind: "changed"; sessionIds: readonly string[] }
  | { kind: "deleted"; sessionId: string }

export class SessionForkRefusal extends Error {}

/** A child publication lost every attempt to concurrent changes of a parent.
 *  The parent still exists and nothing was written, so a caller that holds
 *  accepted work keeps it for a later safe point instead of failing it. */
export class ParentPublicationContendedError extends Error {
  override readonly name = "ParentPublicationContendedError"
}

export interface SessionManager {
  allocateId(): string
  /** Atomically publishes a non-session workflow aggregate and its invocation evidence under a chat. */
  publishWorkflow(input: WorkflowPublication): Promise<string>
  /** Commits VM control and any started member under the same structural fence as deletion admission. */
  commitWorkflow(input: WorkflowCommitPublication): Promise<GuardedAppendResult>
  /** Moves the run binding and all live member edges atomically under deletion admission's fence. */
  adoptWorkflow(input: WorkflowAdoption): Promise<boolean>
  /** Atomically publishes a conversation-backed subagent, its parent link,
   * selected profile and roles, and the module-owned recoverable first run. */
  publishSubagent(input: SubagentSessionPublication): Promise<string>
  createChat(opts: { id?: string; conversationId?: string; name?: string; executionCwd?: string; initialState?: SessionLifecycleState; initialRoles?: RoleAssignments; authProfileId?: string }): Promise<string>
  /** Copies the source chat's committed branch, then atomically publishes an inactive independent session and both lineage links. */
  forkChat(sourceSessionId: string): Promise<string>
  /** Publishes a validated copied context as an inactive independent chat.
   * The supplied messages, not the source's later branch, seed its history.
   * The source supplies profile, roles, execution directory, and ancestry. */
  createChatFromContext(sourceSessionId: string, messages: readonly ConversationMessage[]): Promise<string>
  listMetadata(): Promise<DurableSessionCatalog>
  /** Reducer-confirmed active sessions, found through the held conservative
   * candidate index without folding the full workspace catalog. */
  listActive(): Promise<DurableSessionCatalog>
  /** Targeted metadata and workflow state for the given sessions. Derived
   * totals come from the shared background summary index. */
  listForIds(ids: readonly string[]): Promise<DurableSessionCatalog>
  /** Single-session metadata read for existence checks and narrow field access. */
  read(id: string): Promise<ReplayedSession | null>
  updateLifecycleState(id: string, newState: SessionLifecycleState): Promise<void>
  /** Publishes run-start facts and active lifecycle as one sequence-guarded
   * commit, then installs the process-local active-owner marker. A first fact
   * that carries `expectedSeq` sets the guard: the sequence the caller read
   * before it decided to activate. */
  publishActivation(id: string, facts: readonly GuardedEventStoreAppend[]): Promise<void>
  /** Returns whether the label write was accepted (see SessionMetadataStore.updateLabel). */
  updateLabel(id: string, labels: { label?: string; shortLabel?: string }, source: SessionLabelSource): Promise<boolean>
  updateChatMetadata(id: string, patch: { providerConversationId?: string; seedContext?: string }): Promise<void>
  captureRolesIfAbsent(id: string, roles: RoleAssignments): Promise<boolean>
  captureAuthProfileIfAbsent(id: string, authProfileId: string): Promise<boolean>
  selectAuthProfile(id: string, authProfileId: string): Promise<boolean>
  /** Atomically selects a profile and replaces its matching role snapshot.
   * With expected selection, returns false if a different profile won during preparation. */
  selectAuthProfileWithRoleSnapshot(id: string, authProfileId: string, roles: RoleAssignments, expected?: { readonly authProfileId: string | undefined }): Promise<boolean>
  replaceRoleSnapshot(id: string, roles: RoleAssignments, overrides?: RoleAssignments, expectedSnapshot?: RoleAssignmentSnapshot): Promise<boolean>
  updateRoleAssignment(id: string, roleId: string, assignment: RoleAssignmentEntry): Promise<boolean>
  removeRoleAssignment(id: string, roleId: string): Promise<boolean>
  unlinkChild(parentId: string, childId: string): Promise<void>
  /** Persists recursive deletion authority. With an epoch-millisecond cutoff, admits
   * only chats whose complete owned tree is inactive and old enough; refusal
   * returns an empty plan without writing or deleting anything. */
  admitDeletion(id: string, inactiveBefore?: number): Promise<ChildSessionDeletionPlan>
  /** Rechecks one admitted target and its live binding before deleting its
   * artifacts, unlinking it, and tombstoning it. Resolves with the notices
   * that the delete held for the senders of the messages the target never
   * read. The manager can run in the process that owns the project state,
   * where no session runs, so the caller hands them to the live senders
   * (`wakeAfterSettlement`). */
  finalizeDeletionTarget(target: ChildSessionDeletionTarget): Promise<readonly ReturnedNotice[]>
  /** Finds active sessions without a live owner PID. Each such session, a blank chat and a workflow
   *  included, becomes inactive, so the user resumes it explicitly and a tab
   *  that still shows it attaches it again. Returns the number transitioned,
   *  leaves live/non-active sessions untouched, and rejects on
   *  the first failed recovery operation. */
  recoverStaleSessions(): Promise<number>
  subscribe(listener: (change: SessionMetadataChange) => void): () => void
}

/** Records a name that title generation produced, for a caller that does not
 *  await the write. Resolves whether the session took the name, which a
 *  user-named session refuses. A write that fails is recorded here and
 *  resolves false, so the session keeps its current name. */
export async function recordGeneratedSessionName(manager: Pick<SessionManager, "updateLabel">, sessionId: string, labels: { label: string; shortLabel: string }): Promise<boolean> {
  try {
    return await manager.updateLabel(sessionId, labels, "generated")
  } catch (error) {
    recordBackgroundFailure(log, "record generated session name", { sessionId }, error)
    return false
  }
}

export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { projectRoot } = deps
  const projectionReader = "store" in deps ? deps.projectionReader ?? asAsyncEventReadSurface(deps.store) : deps.projectionReader
  const writer = "store" in deps ? deps.writer ?? requireLocalAsyncWriter(deps.store, "createSessionManager requires writer when store is read-only") : deps.writer
  const metadata = createSessionMetadataStore({ reader: projectionReader, writer })
  const listeners = new Set<(change: SessionMetadataChange) => void>()
  const notifyChanged = (sessionIds: readonly string[]) => { for (const fn of listeners) fn({ kind: "changed", sessionIds }) }
  const notifyDeleted = (sessionId: string) => { for (const fn of listeners) fn({ kind: "deleted", sessionId }) }
  const notifyIfChanged = (sessionId: string, changed: boolean): boolean => { if (changed) notifyChanged([sessionId]); return changed }
  const lifecycle = createSessionLifecyclePublication({
    projectRoot,
    reader: projectionReader,
    writer,
    metadata,
    read: metadata.read,
    notifyChanged,
  })
  const childDeletion = createChildSessionDeletionState({
    projectionReader,
    writer,
    read: (sessionId) => metadata.read(sessionId),
    isKnown: async (sessionId) => {
      if (await metadata.read(sessionId)) return true
      return (await metadata.listForIds([sessionId])).errors.some((error) => error.sessionId === sessionId)
    },
    deleteOne: deleteOneSession,
    deleteWorkflow: async (workflowId) => {
      deleteWorkflowArtifacts(workflowId, projectRoot)
      const settled = await settleUnreadMessages({ reader: projectionReader, writer }, {
        recipientSessionId: workflowId, reason: "deleted",
        end: async () => { await writer.appendBatch(workflowRunOwner().deletion(workflowId, Date.now())); return true },
      })
      return settled.stored ? settled.returned : []
    },
    unlink: async (parentSessionId, childSessionId) => {
      await metadata.unlinkChild(parentSessionId, childSessionId)
      notifyChanged([parentSessionId])
    },
  })
  let structuralMutation = Promise.resolve()

  async function serializeStructuralMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = structuralMutation
    const release = Promise.withResolvers<void>()
    structuralMutation = release.promise
    await previous
    try {
      return await mutation()
    } finally {
      release.resolve()
    }
  }

  function sharedSessionFields(opts: { now: string; name: string | undefined; label: string; executionCwd: string; initialState: SessionLifecycleState }) {
    return {
      label: opts.label,
      lastUpdated: opts.now,
      lifecycleState: opts.initialState,
      executionCwd: canonicalDirectory(opts.executionCwd, "session execution directory"),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      createdAt: opts.now,
      ...(opts.initialState === "active" ? { activatedAt: opts.now } : {}),
    }
  }

  async function persistNewSession(opts: { id: string; sessionData: Session; initialRoles?: RoleAssignments; beforePersist?: () => Promise<void> }): Promise<string> {
    ensureSessionDir(opts.id, projectRoot)
    startupTrace("session manager create dir ensured")
    await opts.beforePersist?.()
    const persistedId = await metadata.create(opts.sessionData, opts.id, opts.initialRoles)
    startupTrace("session manager create metadata persisted")
    if (opts.sessionData.lifecycleState === "active") writeOwnerPid(persistedId, projectRoot)
    startupTrace("session manager create owner pid written")
    notifyChanged([opts.id])
    return persistedId
  }

  async function appendChildPublication(
    childSessionId: string,
    parentSessionIds: readonly string[],
    prepareEvents: readonly EventStoreAppend[] | (() => Promise<readonly EventStoreAppend[]>),
    operation: string,
    childConflictMessage = `${operation} destination changed before publication`,
  ): Promise<void> {
    for (let attempt = 1; attempt <= PARENT_PUBLICATION_ATTEMPTS; attempt += 1) {
      // The guards come before preparation, which reads the parents' state:
      // a change that lands while preparation runs then fails this batch.
      // Read after preparation, the guards would already include the change
      // and pass a batch prepared from the state before it.
      const sessionGuards = await Promise.all([childSessionId, ...parentSessionIds].map(async (sessionId) => ({
        sessionId,
        expectedSeq: await projectionReader.aggregateSeq(`session:${sessionId}`) + 1,
      })))
      const events = typeof prepareEvents === "function" ? await prepareEvents() : prepareEvents
      const result = await metadata.appendGuardedFacts(prepareChildSessionPublication({
        childSessionId,
        events,
        sessionGuards,
      }))
      if (result.kind === "stored") return
      if (result.conflict.aggregateId === `session:${childSessionId}`) {
        throw new Error(childConflictMessage, { cause: result.conflict })
      }
      const conflictedParentId = parentSessionIds.find((parentId) =>
        result.conflict.aggregateId === `session:${parentId}`
        || events.some((event) => event.sessionId === parentId && event.aggregateId === result.conflict.aggregateId))
      if (!conflictedParentId) {
        throw new Error(`${operation} destination changed before publication`, { cause: result.conflict })
      }
      if (await childDeletion.blocksLaunch(conflictedParentId)) {
        throw new Error(`Cannot complete ${operation} below session ${conflictedParentId} while deletion is in progress`)
      }
      await metadata.readOrThrow(conflictedParentId)
      if (attempt === PARENT_PUBLICATION_ATTEMPTS) {
        throw new ParentPublicationContendedError(`Parent session changed during ${operation} after ${attempt} attempts`, { cause: result.conflict })
      }
    }
  }

  const childPublication = createChildSessionPublication({
    projectRoot,
    executionCwd: deps.executionCwd,
    reader: projectionReader,
    writer,
    metadata,
    blocksLaunch: childDeletion.blocksLaunch,
    append: appendChildPublication,
    appendWorkflow: async (workflowId, parentSessionId, prepare) => {
      for (let attempt = 1; attempt <= PARENT_PUBLICATION_ATTEMPTS; attempt += 1) {
        const expectedSeq = await projectionReader.aggregateSeq(`session:${parentSessionId}`) + 1
        if (await childDeletion.blocksLaunch(parentSessionId)) throw new Error(`Cannot publish a workflow below session ${parentSessionId} while deletion is in progress`)
        await metadata.readOrThrow(parentSessionId)
        const events = await prepare()
        const [first, ...rest] = events
        if (!first) throw new Error("Workflow publication has no aggregate facts")
        const result = await metadata.appendGuardedFacts([
          { ...first, aggregateGuards: [{ aggregateId: `session:${parentSessionId}`, expectedSeq }] }, ...rest,
        ])
        if (result.kind === "stored") return
        if (result.conflict.aggregateId === `workflow:${workflowId}`) throw new Error("Workflow destination changed before publication", { cause: result.conflict })
        if (attempt === PARENT_PUBLICATION_ATTEMPTS) throw new ParentPublicationContendedError(`Parent session changed during workflow publication after ${attempt} attempts`, { cause: result.conflict })
      }
    },
    notifyChanged,
  })

  async function publishWorkflow(input: WorkflowPublication): Promise<string> {
    return serializeStructuralMutation(() => childPublication.workflow(input))
  }

  async function publishSubagent(input: SubagentSessionPublication): Promise<string> {
    return serializeStructuralMutation(() => childPublication.subagent(input))
  }

  const workflowPublication = createWorkflowPublication({
    projectRoot, reader: projectionReader, allocateId: metadata.allocateId, read: metadata.read,
    blocksLaunch: childDeletion.blocksLaunch, append: metadata.appendGuardedFacts,
    notifyChanged: (ids) => {
      try { notifyChanged(ids) } catch (error) {
        recordBackgroundFailure(log, "notify committed workflow publication", { sessionIds: ids }, error)
      }
    },
  })
  const commitWorkflow = (input: WorkflowCommitPublication) => serializeStructuralMutation(() => workflowPublication.commit(input))
  const adoptWorkflow = (input: WorkflowAdoption) => serializeStructuralMutation(() => workflowPublication.adopt(input))

  async function createChat(opts: { id?: string; conversationId?: string; name?: string; executionCwd?: string; initialState?: SessionLifecycleState; initialRoles?: RoleAssignments; authProfileId?: string }): Promise<string> {
    startupTrace("session manager create start")
    const now = new Date().toISOString()
    const id = opts.id ?? metadata.allocateId()
    const initialState = opts.initialState ?? "active"
    const conversationId = opts.conversationId ?? metadata.allocateId()
    const sessionData: Session = {
      ...sharedSessionFields({ now, name: opts.name, label: opts.name ?? "New Chat", executionCwd: opts.executionCwd ?? deps.executionCwd, initialState }),
      kind: "chat",
      command: "chat",
      conversationId,
      ...(opts.authProfileId !== undefined ? { authProfileId: opts.authProfileId } : {}),
    }
    return persistNewSession({
      id,
      sessionData,
      ...(opts.initialRoles ? { initialRoles: opts.initialRoles } : {}),
      beforePersist: async () => {
        const tree = await createConversationTree({ conversationId, sessionId: id, now: () => now, store: projectionReader, writer })
        tree.getStorage().dispose()
        startupTrace("session manager create tree created")
      },
    })
  }

  async function forkChat(sourceSessionId: string): Promise<string> {
    const source = await metadata.readOrThrow(sourceSessionId)
    if (source.kind !== "chat") throw new SessionForkRefusal("Only chat sessions can be forked")

    const targetSessionId = metadata.allocateId()
    const targetConversationId = metadata.allocateId()
    const now = new Date().toISOString()
    const timestamp = Date.parse(now)
    const sourceTree = await ConversationTreeStorage.open({
      conversationId: source.conversationId,
      sessionId: sourceSessionId,
      store: projectionReader,
      writer,
    })
    const capture = await sourceTree.captureCommittedActiveBranch()
    sourceTree.dispose()
    const checkpoint = await readConversationCheckpoint(projectionReader, { kind: "session", sessionId: sourceSessionId }, source.conversationId)
    // The fork sends the same prompt as its source, so the source's last
    // context measurement is also the fork's until the fork's own first turn.
    const context = contextUtilizationFromProjection(await createBudgetProjection(projectionReader, sourceSessionId).replay())
    if (capture.entries.length === 0) throw new SessionForkRefusal("There is no committed conversation to fork")
    if (capture.degraded) throw new SessionForkRefusal("A conversation with unreadable history cannot be forked")
    const copied = await forkConversationTree({
      source: capture,
      destinationConversationId: targetConversationId,
      destinationSessionId: targetSessionId,
      store: projectionReader,
      writer,
      now: () => now,
    })

    const forkFact = buildSessionForkedFact({
      sourceSessionId,
      targetSessionId,
      selection: { kind: "active_branch" },
      sourceEventPrefixPosition: copied.sourcePrefixPosition,
      copiedEntryCount: copied.entryCount,
      copiedRootEntryId: copied.rootEntryId,
      copiedLeafEntryId: copied.leafEntryId,
      publishedAt: now,
    })
    const destinationEvents: GuardedEventStoreAppend[] = [
      ...prepareChatBranchPublication({ sourceSessionId, source, checkpoint, targetSessionId, targetConversationId, projectRoot, now }),
      {
        aggregateId: `session:${targetSessionId}`,
        type: forkFact.type,
        version: forkFact.version,
        timestamp,
        actor: forkFact.actor,
        sessionId: targetSessionId,
        payload: forkFact.payload,
      },
      ...(context.promptTokens > 0
        ? [{
            aggregateId: `session:${targetSessionId}`,
            type: "model.context.measured",
            version: 1,
            timestamp,
            actor: "provider",
            sessionId: targetSessionId,
            payload: { promptTokens: context.promptTokens, contextWindow: context.contextWindow },
          }]
        : []),
    ]
    await appendChildPublication(
      targetSessionId,
      [sourceSessionId],
      destinationEvents,
      "fork publication",
    )
    notifyChanged([targetSessionId, sourceSessionId])
    return targetSessionId
  }

  async function createChatFromContext(sourceSessionId: string, messages: readonly ConversationMessage[]): Promise<string> {
    const source = await metadata.readOrThrow(sourceSessionId)
    if (source.kind !== "chat") throw new SessionForkRefusal("Only chat sessions can supply conversation context")
    const checkpoint = await readConversationCheckpoint(projectionReader, { kind: "session", sessionId: sourceSessionId }, source.conversationId)
    const targetSessionId = metadata.allocateId()
    const targetConversationId = metadata.allocateId()
    const now = new Date().toISOString()
    const tree = await createConversationTree({
      conversationId: targetConversationId,
      sessionId: targetSessionId,
      now: () => now,
      store: projectionReader,
      writer,
    })
    try {
      const appended = await tree.appendMessages(messages)
      if (appended.kind !== "committed") {
        throw new SessionForkRefusal("Cannot publish captured conversation context", { cause: appended.cause })
      }
      await runInTaskSlices("conversation:context-publication", validateRawForkBranchWork(await tree.getBranch()))
    } finally {
      tree.getStorage().dispose()
    }
    await appendChildPublication(
      targetSessionId,
      [sourceSessionId],
      prepareChatBranchPublication({ sourceSessionId, source, checkpoint, targetSessionId, targetConversationId, projectRoot, now }),
      "context publication",
    )
    notifyChanged([targetSessionId, sourceSessionId])
    return targetSessionId
  }

  async function listForIds(ids: readonly string[]): Promise<DurableSessionCatalog> {
    const metadataCatalog = await metadata.listForIds(ids)
    const catalog = buildDurableSessionMetadataCatalog(metadataCatalog, projectRoot)
    return catalog
  }

  async function listMetadata(): Promise<DurableSessionCatalog> {
    return buildDurableSessionMetadataCatalog(await metadata.list(), projectRoot)
  }

  async function listActive(): Promise<DurableSessionCatalog> {
    const candidates = await listActiveSessionCandidateIds(projectionReader)
    const catalog = await listForIds(candidates)
    return {
      ...catalog,
      sessions: catalog.sessions.filter((session) => session.lifecycleState === "active"),
    }
  }

  async function updateLabel(id: string, labels: { label?: string; shortLabel?: string }, source: SessionLabelSource): Promise<boolean> {
    return notifyIfChanged(id, await metadata.updateLabel(id, labels, source))
  }

  async function updateChatMetadata(id: string, patch: { providerConversationId?: string; seedContext?: string }): Promise<void> {
    if (await metadata.updateChatMetadata(id, patch)) notifyChanged([id])
  }

  async function captureRolesIfAbsent(id: string, roles: RoleAssignments): Promise<boolean> { return notifyIfChanged(id, await metadata.captureRolesIfAbsent(id, roles)) }
  async function captureAuthProfileIfAbsent(id: string, authProfileId: string): Promise<boolean> { return notifyIfChanged(id, await metadata.captureAuthProfileIfAbsent(id, authProfileId)) }
  async function selectAuthProfile(id: string, authProfileId: string): Promise<boolean> { return notifyIfChanged(id, await metadata.selectAuthProfile(id, authProfileId)) }
  async function selectAuthProfileWithRoleSnapshot(id: string, authProfileId: string, roles: RoleAssignments, expected?: { readonly authProfileId: string | undefined }): Promise<boolean> {
    return notifyIfChanged(id, await metadata.selectAuthProfileWithRoleSnapshot(id, authProfileId, roles, expected))
  }
  async function replaceRoleSnapshot(id: string, roles: RoleAssignments, overrides?: RoleAssignments, expectedSnapshot?: RoleAssignmentSnapshot): Promise<boolean> {
    return notifyIfChanged(id, await metadata.replaceRoleSnapshot(id, roles, overrides, expectedSnapshot))
  }
  async function updateRoleAssignment(id: string, roleId: string, assignment: RoleAssignmentEntry): Promise<boolean> { return notifyIfChanged(id, await metadata.updateRoleAssignment(id, roleId, assignment)) }
  async function removeRoleAssignment(id: string, roleId: string): Promise<boolean> { return notifyIfChanged(id, await metadata.removeRoleAssignment(id, roleId)) }
  async function unlinkChild(parentId: string, childId: string): Promise<void> {
    await metadata.unlinkChild(parentId, childId)
    notifyChanged([parentId])
  }

  async function deleteOneSession(id: string): Promise<readonly ReturnedNotice[]> {
    const session = await metadata.read(id)
    const now = Date.now()
    const parentSessionId = session?.kind !== "chat" ? session?.launchedFrom?.parentSessionId : undefined
    // The messages the session never read go back to their senders (ARCH-SESSIONS-031).
    // The parent's notice rides the unlink, in the same append as the
    // tombstone that clears the cells, so no notice is lost between the two
    // and none is given twice.
    const settled = await settleUnreadMessages({ reader: projectionReader, writer }, {
      recipientSessionId: id,
      reason: "deleted",
      ...(parentSessionId ? { parent: { sessionId: parentSessionId } } : {}),
      end: async (parentReturn) => {
        // The tombstone rides the write that empties the session's in-flight
        // state: a deleted session has no operation left to resume, and a cell
        // that survived it would make the workspace recovery sweep append fresh
        // facts to the dead aggregate forever.
        const facts: EventStoreAppend[] = [{
          ...buildSessionMetadataAppend(id, {
            type: "session.deleted",
            version: 1,
            actor: "flywheel",
            payload: { lastUpdated: new Date(now).toISOString() },
          }, now),
          inFlight: [{ op: "clear_session" }],
        }]
        if (session?.kind === "workflow") {
          const queueFact = buildQueueDeletedFact()
          facts.push({
            aggregateId: workflowAggregateId(id),
            type: queueFact.type,
            version: queueFact.version,
            timestamp: now,
            actor: queueFact.actor,
            sessionId: id,
            payload: queueFact.payload,
          })
        }
        if (parentSessionId) {
          facts.push({
            ...buildSessionMetadataAppend(parentSessionId, buildSessionChildUnlinkedFact(id, new Date(now).toISOString()), now),
            ...(parentReturn ? { inFlight: [parentReturn.notice] } : {}),
          })
        }
        // The disposable directories go first: a tombstone the artifact deletion
        // could not follow would strand a session tree and a breadcrumb tree that
        // no listed session names any more, and nothing else walks those trees.
        // The other order is recoverable, because a session whose directories are
        // gone is a session whose directories a later start creates again.
        deleteSessionArtifacts(id, projectRoot)
        // Through the metadata store, not the raw writer: the store applies the
        // tombstone to its long-lived projection inside the same await, so a
        // listMetadata() after this call can never list the session again (a raw
        // append could be skipped forever if a later metadata fact advanced the
        // projection past the unapplied tombstone).
        await metadata.appendFacts(facts)
        return true
      },
    })
    if (parentSessionId) notifyChanged([parentSessionId])
    notifyDeleted(id)
    return settled.stored ? settled.returned : []
  }

  async function updateLifecycleState(id: string, state: SessionLifecycleState): Promise<void> {
    return serializeStructuralMutation(async () => {
      if (state === "active" && await childDeletion.blocksLaunch(id)) throw new Error(`Session ${id} is pending deletion`)
      await lifecycle.updateLifecycleState(id, state)
    })
  }

  async function publishActivation(id: string, facts: readonly GuardedEventStoreAppend[]): Promise<void> {
    return serializeStructuralMutation(async () => {
      if (await childDeletion.blocksLaunch(id)) throw new Error(`Session ${id} is pending deletion`)
      await lifecycle.publishActivation(id, facts)
    })
  }

  async function admitDeletion(id: string, inactiveBefore?: number): Promise<ChildSessionDeletionPlan> {
    return serializeStructuralMutation(() => childDeletion.admit(id, inactiveBefore))
  }

  async function finalizeDeletionTarget(target: ChildSessionDeletionTarget): Promise<readonly ReturnedNotice[]> {
    return serializeStructuralMutation(() => childDeletion.finalize(target))
  }

  async function recoverStaleSessions(): Promise<number> {
    let recovered = 0
    for (const session of (await listActive()).sessions) {
      // The owner record names the service process that served the session,
      // not a client, so an owner that is gone says nothing about whether a
      // tab still shows the session: a client attaches again with its own
      // backoff, which can outlast this pass. An empty chat is therefore
      // paused like any other session and never removed here; the next stop
      // that finds no hold on its project removes it (PI-INTERACTION-075).
      if (!isSessionOwnerGone(session.id, projectRoot)) continue
      await updateLifecycleState(session.id, "inactive")
      log.info("recovered stale session", { sessionId: session.id, to: "inactive" })
      recovered++
    }
    return recovered
  }

  return {
    allocateId: metadata.allocateId,
    publishWorkflow,
    commitWorkflow,
    adoptWorkflow,
    publishSubagent,
    createChat,
    forkChat,
    createChatFromContext,
    listForIds,
    listMetadata,
    listActive,
    read: metadata.read,
    updateLifecycleState,
    publishActivation,
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
    admitDeletion,
    finalizeDeletionTarget,
    recoverStaleSessions,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
