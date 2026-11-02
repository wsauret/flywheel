import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { Schema } from "effect"
import { ChatInputObjectSchema } from "../../../../infra/chat-input-schema.js"
import { CorruptEventRowError, type EventStoreReadSurface, type GuardedEventStoreAppend, type InFlightWrite, type StoredFact } from "../../../../infra/event-store-types.js"
import { errorMessage } from "../../../../infra/error-message.js"
import { Log } from "../../../../infra/log.js"
import { admitPrivateDatabaseFiles } from "../../../../infra/private-path.js"
import { applySqliteDurabilityPragmas } from "../../../../infra/sqlite-durability.js"
import { createSqliteEventInserter, type SqliteEventInserter } from "../../../../infra/sqlite-event-store-core.js"
import { createSqliteEventReadSurface } from "../../../../infra/sqlite-event-read-surface.js"
import { extractToolContentFact } from "../../../../infra/tool-content-extraction.js"
import { workflowCallLaunched } from "../../../../infra/tools/workflow-call-source.js"
import { checkedThrough, headPosition, recordChecked } from "../../../migrations/engine.js"
import { recoverSessionMetadata } from "../../../session/session-metadata-projection.js"
import { prepareSessionFactAppend } from "../../../session/session-fact-writer.js"
import { generateSessionId } from "../../../../infra/session-id.js"
import { buildSessionMetadataAppend } from "../../../session/session-metadata-store.js"
import { buildSessionCreatedFact, buildSessionChildLinkedFact, buildSessionChildUnlinkedFact, buildSessionOwnershipAdoptedFact, buildSessionRolesSnapshottedFact, decodeSessionMetadataFactForReplay } from "../../../session/session-metadata-facts.js"
import { buildRuntimeWorkflowInvocationAppend, prepareChildSessionPublication } from "../../../session/child-session-publication.js"
import type { RuntimeWorkflowInvocationPayload } from "../../../../infra/runtime-fact-types.js"
import { CHILD_SESSION_DELETION_IN_FLIGHT_KIND, decodeRetainedChildSessionDeletion } from "../../../session/child-session-deletion.js"
import { loadToolExecutionTimelineFromEvents, TOOL_EXECUTION_FACT_TYPES } from "../../../session/tool-execution-projection.js"
import { WORKFLOW_RUNTIME_INVOCATION_TOOL } from "../../../agent-runtime/tools/workflow.js"
import type { ToolExecutionEntry } from "../../../session/tool-execution-types.js"
import type { ReplayedSession, Session } from "../../../session/schemas.js"
import { recordedExecutionCwd } from "../../../session/session-execution-directory.js"
import { readConversationSnapshotSync, type ConversationTreeProjectionState } from "../../../session/conversation/conversation-projection.js"
import { sessionMessageSourcesSync, type SessionMessageSources } from "../../../session/session-message-sources.js"
import { salvageConversationTreeFact } from "../../../session/conversation/conversation-facts.js"
import { ConversationTreeStorage } from "../../../session/conversation/conversation-tree-storage.js"
import { createConversationMessageEntry } from "../../../session/conversation/conversation-tree.js"
import type { MessageEntry } from "../../../session/conversation/conversation-entry-types.js"
import { decodeQueuedUserInputCell, queuedInputMessage, QUEUED_USER_INPUT_IN_FLIGHT_KIND } from "../../../session/conversation/queued-user-inputs.js"
import { QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND } from "../../../session/conversation/queued-background-notifications.js"
import { interruptedTurnMessage, turnEndEntryId } from "../../../session/conversation/turn-end-record.js"
import { replayWorkflowControl, resumesFailedAgents, workflowInsertionRefusalReason } from "../../../../workflows/vm/fact-fold.js"
import { proposeFollowUpTransfer } from "../../../../workflows/vm/transition.js"
import type { CommittedWorkflowControl } from "../../../../workflows/vm/committed-control.js"
import { failedAgents, agentResults, terminalHandoff, workflowCompletionContent, workflowStopContent } from "../../../../workflows/output-contract/workflow-completion.js"
import { loadQueueFromEvents } from "../../../../workflows/view/view-projection.js"
import type { WorkflowView } from "../../../../workflows/view/types.js"
import { workflowFamilyBoundary } from "../../../../workflows/workflow-root.js"
import { childSessionResultFact, historicalCompletionEntryId, workflowNotificationLabel } from "../../../session/child-session-completion.js"

const log = Log.create({ service: "workflow-child-adoption" })

/** The watermark of this pass: the facts at or below it were examined, so a
 *  start looks only at the trigger facts written after it. */
const ADOPTION_MIGRATION_ID = "workflow-child-ownership"

/** The fact types above the watermark that can make a workflow need a
 *  conversion. A new workflow arrives as `session.created`. An older build,
 *  for example after a downgrade and a re-upgrade, can also change a
 *  workflow that an earlier pass examined: it deletes a parent chat but not
 *  its workflow children (`session.deleted`), drops a link
 *  (`session.child.unlinked`), or accepts a follow-up into a completed
 *  workflow, whose commit always carries `follow_up.requested`. These
 *  families are rare, so a start reads what changed since the last start,
 *  never the whole store. */
const ADOPTION_TRIGGER_TYPES = ["session.created", "session.deleted", "session.child.unlinked", "follow_up.requested"]

/** What a start tells a person about a follow-up it cannot move. The input
 *  stays in the workflow's bytes, which no later pass reads again. */
const UNPROVEN_TRANSFER = "workflow control unreadable during adoption; any pending follow-up stays in the workflow because its transfer could not be proven"

/** What a start tells a person about held input that a workflow with its
 *  card keeps. Only v0.0.12 writes this shape: a person's text held for a
 *  workflow that then completed. The workflow keeps the text by design. A
 *  conversion retires a held cell only in the batch of a fact that it
 *  writes anyway: the ownership fact of a workflow that it adopts, or the
 *  transfer of a pending follow-up. A backed workflow gets no ownership
 *  fact, and with no pending follow-up it gets no transfer. So no fact of
 *  the conversion can carry the retirement. A new fact family for this one
 *  rare shape costs more than it gives. So the bytes stay, and this one
 *  warning names the workflow. */
const HELD_INPUT_RETAINED = "workflow held input retained during adoption; the workflow has no pending follow-up whose transfer can move it to the parent chat"

/** What a start tells a person when a follow-up transfer cannot restate the
 *  workflow's queue, because this build cannot read the queue's history. */
const QUEUE_NOT_RESTATED = "workflow queue unreadable during adoption; follow-up transferred without restating the queue"

/** What a start tells a person about follow-up input that a degraded
 *  adoption leaves in the workflow, because it moves no input at all. */
const DEGRADED_INPUT_RETAINED = "workflow follow-up input not transferred by a degraded adoption; input retained in the workflow"

type WorkflowSession = Extract<ReplayedSession, { kind: "workflow" }>

/** How a conversion reads a workflow's evidence. `ordinary` keeps a live
 *  parent chat and its bindings. `degraded` is the conversion of a workflow
 *  whose parent evidence the ordinary one could not read: a new adopting
 *  chat holds a migration-origin card and binding, and nothing that needs
 *  the unreadable evidence, such as a follow-up transfer or a Stop mirror,
 *  is attempted (C3 degraded control). */
type AdoptionMode = "ordinary" | "degraded"

interface AdoptionOptions {
  readonly mode?: AdoptionMode
  readonly readInvocation?: InvocationReader
  /** One pass's sender sources, so adopting many workflows decodes each session creation once. */
  readonly readSources?: () => SessionMessageSources
}

/** What a person must hear about history that a conversion leaves in place.
 *  `key` names the held input cell when the warning is about one. */
interface AdoptionWarning {
  readonly message: string
  readonly key?: string
}

type Warn = (warning: AdoptionWarning) => void

/** One workflow's prepared conversion. The pass logs the warnings only of
 *  the conversion that commits, so a refused ordinary conversion that the
 *  degraded one replaces says nothing twice. */
interface PreparedAdoption {
  readonly events: readonly GuardedEventStoreAppend[]
  readonly warnings: readonly AdoptionWarning[]
}

/** The sessions an admitted deletion owns, which no adoption may rescue. A
 *  deletion cell that does not read names its root for certain but not its
 *  edges, so it owns its root and every child session linked below the
 *  root, never a chat: a fork outlives its origin's deletion. Its bytes stay
 *  for recovery to report, and `unreadable` hears its root. */
export function workflowConversionDeletionTargets(reader: EventStoreReadSurface, unreadable?: (rootSessionId: string, cause: unknown) => void): Set<string> {
  const targets = new Set<string>()
  const ownSubtree = (sessionId: string, root = sessionId): void => {
    if (targets.has(sessionId)) return
    const session = recoverSessionMetadata(reader, sessionId)
    if (sessionId !== root && session?.kind === "chat") return
    targets.add(sessionId)
    for (const child of session?.childSessionIds ?? []) ownSubtree(child, root)
  }
  for (const root of reader.sessionsWithInFlight(CHILD_SESSION_DELETION_IN_FLIGHT_KIND)) {
    for (const row of reader.readInFlight(root, CHILD_SESSION_DELETION_IN_FLIGHT_KIND)) {
      let operation: ReturnType<typeof decodeRetainedChildSessionDeletion>
      try {
        operation = decodeRetainedChildSessionDeletion(row.payload, root)
      } catch (cause) {
        unreadable?.(root, cause)
        ownSubtree(root)
        continue
      }
      targets.add(operation.rootSessionId)
      if (operation.version === 1) for (const edge of operation.edges) targets.add(edge.childSessionId)
      else for (const target of operation.targets) targets.add(target.kind === "workflow" ? target.workflowId : target.sessionId)
    }
  }
  return targets
}

function tool(reader: EventStoreReadSurface, parentId: string, toolUseId: string | undefined): ToolExecutionEntry | undefined {
  if (!toolUseId) return undefined
  return loadToolExecutionTimelineFromEvents(reader.read({
    aggregateId: `session:${parentId}`, types: TOOL_EXECUTION_FACT_TYPES, toolUseIds: [toolUseId],
  })).find((entry) => entry.toolUseId === toolUseId)
}

type InvocationReader = (parentId: string, toolUseId: string) => readonly StoredFact[]
interface InvocationEvidence {
  sequence: number
  facts: readonly StoredFact[]
}

function invocationFacts(reader: EventStoreReadSurface, parentId: string, toolUseIds: readonly string[]): readonly StoredFact[] {
  return reader.read({
    aggregateId: `session:${parentId}`,
    types: ["tool.input.completed", "tool.runtime_invocation.recorded"],
    toolUseIds,
  })
}

/** Reads each parent's invocation evidence once for every candidate that
 *  shares the parent. Discovery only selects the batching keys; the
 *  transaction recovers metadata again under the write lock. */
function passInvocationReader(reader: EventStoreReadSurface, workflows: readonly WorkflowSession[]): InvocationReader {
  const bindings = new Map<string, Set<string>>()
  for (const { launchedFrom: launch } of workflows) {
    if (!launch?.toolUseId) continue
    let tools = bindings.get(launch.parentSessionId)
    if (!tools) bindings.set(launch.parentSessionId, tools = new Set())
    tools.add(launch.toolUseId)
  }
  const cached = new Map<string, InvocationEvidence>()
  return (parentId, toolUseId) => {
    let tools = bindings.get(parentId)
    if (!tools) bindings.set(parentId, tools = new Set())
    if (!tools.has(toolUseId)) {
      tools.add(toolUseId)
      cached.delete(parentId)
    }
    // Called inside BEGIN IMMEDIATE: an earlier sibling can have appended to
    // this parent. Never reuse evidence from before that committed append.
    const sequence = reader.aggregateSeq(`session:${parentId}`)
    let evidence = cached.get(parentId)
    if (!evidence || evidence.sequence !== sequence) {
      evidence = { sequence, facts: invocationFacts(reader, parentId, [...tools]) }
      cached.set(parentId, evidence)
    }
    return evidence.facts.filter((fact) => fact.payload.toolUseId === toolUseId)
  }
}

function backed(reader: EventStoreReadSurface, id: string, workflow: WorkflowSession, excluded: ReadonlySet<string>, readInvocation: InvocationReader): boolean {
  const launch = workflow.launchedFrom
  if (!launch || excluded.has(launch.parentSessionId)) return false
  const parent = recoverSessionMetadata(reader, launch.parentSessionId)
  if (parent?.kind !== "chat" || !parent.childSessionIds?.includes(id)) return false
  if (!launch.toolUseId) return false
  const facts = readInvocation(launch.parentSessionId, launch.toolUseId)
  const invocation = loadToolExecutionTimelineFromEvents(facts)
    .find((entry) => entry.toolUseId === launch.toolUseId)
  if (!invocation || invocation.inputUnrecorded || invocation.toolName !== "workflow") return false
  if (invocation.runtimeOrigin) {
    const origin = invocation.runtimeOrigin
    const recorded = facts.find((fact) => fact.type === "tool.runtime_invocation.recorded")
    return recorded !== undefined && origin.parentConversationId === parent.conversationId
      && anchored(reader, origin.parentConversationId, origin.parentEntryId, recorded.position)
      && (origin.operation.kind === "adoption" ? origin.operation.workflowSessionId === id : origin.operation.input.workflowDefinitionId === workflow.workflowDefinitionId)
  }
  return launch.workflowDefinitionId === workflow.workflowDefinitionId && launch.description !== undefined
    && workflowCallLaunched(invocation.input, { workflowDefinitionId: workflow.workflowDefinitionId, description: launch.description })
}

/** Whether the conversation holds the entry that a runtime invocation's
 *  card anchors to. Each writer of an invocation commits the anchor in the
 *  same batch as the invocation, and no other entry batch of that
 *  conversation can come between them: the workflow publication appends the
 *  anchor just before the invocation, and this conversion just after it. So
 *  one indexed read of the entry batch before the invocation finds a
 *  launch's anchor, and only when that batch does not hold it does a second
 *  read take the batch after. No other turn of the chat is read. Each batch
 *  crosses the conversation's reviewed salvage, as in its own projection, so
 *  an unreadable batch is a batch without the anchor: it never disproves an
 *  anchor that the other batch holds. When neither batch holds a readable
 *  anchor, the card has no row to show at, and the workflow needs the card
 *  that this conversion writes. */
function anchored(reader: EventStoreReadSurface, conversationId: string, entryId: string, position: number): boolean {
  const query = { aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"], limit: 1 }
  return holdsEntry(reader.readTolerant({ ...query, beforePosition: position, order: "desc" })[0], entryId)
    || holdsEntry(reader.readTolerant({ ...query, afterPosition: position })[0], entryId)
}

/** Whether an entry batch holds a readable entry with this id. */
function holdsEntry(batch: StoredFact | CorruptEventRowError | undefined, entryId: string): boolean {
  if (batch === undefined || batch instanceof CorruptEventRowError) return false
  const decoded = salvageConversationTreeFact({ type: batch.type, version: batch.version, actor: batch.actor, payload: batch.payload })
  if (decoded.kind === "recovered") return decoded.fact.type === "chat.entries.appended" && decoded.fact.payload.entries.some((entry) => entry.id === entryId)
  return decoded.kind === "entries" && decoded.items.some((item) => item.kind === "entry" && item.entry.id === entryId)
}

/** Every session that a trigger fact above the watermark names: the session
 *  itself for a creation of a workflow or a follow-up, the child for an
 *  unlink, and each child a deleted parent ever linked. A creation fixes the
 *  session's kind, so a creation that states another kind names no candidate
 *  and its metadata is never replayed; on a first scan those are nearly every
 *  creation. An unreadable trigger row names only the session that holds it.
 *  Metadata recovery skips that row, so for an unreadable deletion or unlink
 *  the parent keeps the links it had, and each child it names keeps the
 *  binding an earlier pass examined. */
function adoptionCandidates(reader: EventStoreReadSurface, afterPosition: number): string[] {
  const ids = new Set<string>()
  const child = (fact: StoredFact | CorruptEventRowError) => {
    if (fact instanceof CorruptEventRowError) return
    if (typeof fact.payload.childSessionId === "string") ids.add(fact.payload.childSessionId)
  }
  for (const fact of reader.readTolerant({ types: ADOPTION_TRIGGER_TYPES, afterPosition })) {
    if (fact instanceof CorruptEventRowError || fact.type === "follow_up.requested") ids.add(fact.sessionId)
    else if (fact.type === "session.created") {
      const created = decodeSessionMetadataFactForReplay(fact)
      if (created?.type !== "session.created" || created.payload.kind !== "chat") ids.add(fact.sessionId)
    }
    else if (fact.type === "session.child.unlinked") child(fact)
    else for (const link of reader.readTolerant({ aggregateId: `session:${fact.sessionId}`, types: ["session.child.linked"] })) child(link)
  }
  return [...ids]
}

type Candidate =
  | { readonly kind: "workflow"; readonly session: WorkflowSession }
  | { readonly kind: "unreadable" }
  | { readonly kind: "other" }

/** What a candidate's metadata says. A session that this build cannot read,
 *  and that no tombstone deleted, has no kind, parent, or execution
 *  authority to adopt from (C3), so it stays as it is. A workflow that the
 *  agent-session conversion retired is no longer a session, and the unlink
 *  that the conversion records names it again after this pass's watermark,
 *  so its retirement counts as a tombstone. */
function candidate(reader: EventStoreReadSurface, id: string, excluded: ReadonlySet<string>): Candidate {
  const session = recoverSessionMetadata(reader, id)
  if (session) return session.kind === "workflow" && !excluded.has(id) ? { kind: "workflow", session } : { kind: "other" }
  const aggregateId = `session:${id}`
  const tombstoned = reader.readLatestPayloadByAggregateAndType(aggregateId, "session.deleted") !== null
    || reader.readLatestPayloadByAggregateAndType(aggregateId, "session.representation.retired") !== null
  return tombstoned ? { kind: "other" } : { kind: "unreadable" }
}

/** The workflow's committed control, or nothing when absent or unreadable.
 *  Existing unreadable history warns and stays unchanged. */
function readControl(reader: EventStoreReadSurface, id: string, warn?: Warn): CommittedWorkflowControl | undefined {
  try {
    const facts = reader.readTolerant({ aggregateId: `workflow:${id}` })
    return facts.length === 0 ? undefined : replayWorkflowControl(facts)
  } catch {
    warn?.({ message: UNPROVEN_TRANSFER })
    return undefined
  }
}

/** The workflow's queue view through the tolerant boundary its control
 *  replays through (`readControl`). A recovered root supersedes the rows
 *  before it, so an unreadable row there is outside the family the queue
 *  fold reads and cannot fail the adoption. An unreadable row that the fold
 *  would read, or a fold this build cannot complete, gives nothing and a
 *  warning: the transfer then commits its control without restating the
 *  queue. */
function readQueue(reader: EventStoreReadSurface, id: string, warn: Warn): WorkflowView | null {
  const facts = reader.readTolerant({ aggregateId: `workflow:${id}` })
  try {
    const boundary = workflowFamilyBoundary(facts)
    const unreadable = facts.some((fact) => fact instanceof CorruptEventRowError && (boundary === null || fact.position > boundary.position))
    if (!unreadable) return loadQueueFromEvents(facts.filter((fact): fact is StoredFact => !(fact instanceof CorruptEventRowError)))
  } catch { /* boundary: unreadable history degrades to the warning below. */ }
  warn({ message: QUEUE_NOT_RESTATED })
  return null
}

/** Whether a workflow ever recorded a follow-up. Every follow-up commit
 *  carries `follow_up.requested`, so one indexed read clears a workflow that
 *  never had one, without a replay of its control. */
function followUpRecorded(reader: EventStoreReadSurface, id: string): boolean {
  return reader.readLatestPayloadByAggregateAndType(`workflow:${id}`, "follow_up.requested") !== null
}

/** Whether held input addressed to the workflow belongs to its follow-up:
 *  the run has one or has finished. An unfinished step consumes such input
 *  when it resumes (`consumeWorkflowRecoveryInputs`), so it stays with the
 *  step. */
function inFollowUpPosition(control: CommittedWorkflowControl): boolean {
  return control.followUp !== null || control.status === "completed" || control.status === "failed"
}

/** Whether the workflow holds input addressed to it. */
function holdsWorkflowInput(reader: EventStoreReadSurface, id: string): boolean {
  return reader.readInFlight(id, QUEUED_USER_INPUT_IN_FLIGHT_KIND).some((row) => decodeQueuedUserInputCell(row, id)?.target === "workflow")
}

/** Whether a workflow needs a conversion. A workflow that its parent's call
 *  does not back needs one; so does one whose parent evidence cannot be
 *  read, which the conversion then adopts into a new chat. A backed
 *  workflow needs one only for a follow-up that waits in it. `warn` hears
 *  why a backed workflow keeps input that it cannot move. */
function needsAdoption(reader: EventStoreReadSurface, id: string, workflow: WorkflowSession, excluded: ReadonlySet<string>, readInvocation: InvocationReader, warn?: Warn): boolean {
  try {
    if (!backed(reader, id, workflow, excluded, readInvocation)) return true
  } catch { return true }
  const recorded = followUpRecorded(reader, id)
  const held = holdsWorkflowInput(reader, id)
  if (!recorded && !held) return false
  const control = readControl(reader, id, warn)
  if (control === undefined) return false
  if (control.followUp?.pendingInput) return true
  if (held && inFollowUpPosition(control)) warn?.({ message: HELD_INPUT_RETAINED })
  return false
}

/** Read-only admission check. A converted store can still join an existing
 *  owner. It never throws for a store's content: evidence that cannot be
 *  read counts as a conversion still due, so the caller reports the
 *  ownership conflict. */
export function workflowChildrenNeedAdoption(dbFile: string): boolean {
  if (!existsSync(dbFile)) return false
  const db = new Database(dbFile, { readonly: true })
  try {
    if (!db.query("select 1 from sqlite_master where type='table' and name='event'").get()) return false
    const reader = createSqliteEventReadSurface(db)
    let excluded: ReadonlySet<string>
    try { excluded = workflowConversionDeletionTargets(reader) } catch { return true }
    return adoptionCandidates(reader, checkedThrough(db, ADOPTION_MIGRATION_ID)).some((id) => {
      const found = candidate(reader, id, excluded)
      return found.kind === "workflow" && needsAdoption(reader, id, found.session, excluded, (parentId, toolUseId) => invocationFacts(reader, parentId, [toolUseId]))
    })
  } finally { db.close() }
}

interface WorkflowAdoptionResult {
  adopted: number
  failed: number
}

/** Adopts historical workflows before readers open. Each workflow commits
 * alone. A workflow whose parent evidence cannot be read is adopted into a
 * new chat; unreadable metadata and unprovable follow-ups retain their bytes
 * and warn once, because the watermark then passes them.
 * Remove this conversion after 2027-10-02. */
export function adoptWorkflowChildren(dbFile: string, projectRoot: string): WorkflowAdoptionResult {
  if (!existsSync(dbFile)) return { adopted: 0, failed: 0 }
  admitPrivateDatabaseFiles(dbFile)
  const db = new Database(dbFile)
  let adopted = 0
  let failed = 0
  try {
    applySqliteDurabilityPragmas(db, 5000)
    const inserter = createSqliteEventInserter(db)
    const reader = createSqliteEventReadSurface(db)
    const excluded = workflowConversionDeletionTargets(reader, (sessionId, cause) => {
      log.warn("retained session deletion unreadable during workflow adoption; its sessions stay unadopted", { sessionId, error: errorMessage(cause) })
    })
    // Every start before 2026-10-02 rescanned each workflow ever created,
    // which held the project's open for seconds on a large store.
    const checked = checkedThrough(db, ADOPTION_MIGRATION_ID)
    const through = headPosition(db)
    const workflows: { readonly id: string; readonly session: WorkflowSession }[] = []
    for (const id of adoptionCandidates(reader, checked)) {
      const found = candidate(reader, id, excluded)
      if (found.kind === "unreadable") log.warn("session metadata unreadable during workflow adoption; history retained unadopted", { sessionId: id })
      if (found.kind === "workflow") workflows.push({ id, session: found.session })
    }
    const readInvocation = passInvocationReader(reader, workflows.map(({ session }) => session))
    const readSources = sessionMessageSourcesSync(reader)
    for (const { id, session } of workflows) {
      const warn: Warn = ({ message, key }) => log.warn(message, { sessionId: id, ...(key === undefined ? {} : { key }) })
      if (!needsAdoption(reader, id, session, excluded, readInvocation, warn)) continue
      let committed: PreparedAdoption
      try {
        committed = commitAdoption(db, inserter, reader, id, projectRoot, { readInvocation, readSources })
      } catch (cause) {
        log.warn("workflow adoption refused; retrying as a degraded adoption into a new chat", { sessionId: id, failureKind: failureKind(cause) })
        try {
          committed = commitAdoption(db, inserter, reader, id, projectRoot, { mode: "degraded", readSources })
        } catch (refusal) {
          failed += 1
          log.warn("workflow adoption refused; original history retained", { sessionId: id, failureKind: failureKind(refusal) })
          continue
        }
      }
      if (committed.events.length > 0) adopted += 1
      for (const warning of committed.warnings) warn(warning)
    }
    if (adopted > 0) log.info("historical workflows adopted", { adopted, failed })
    // Every candidate has a disposition except one whose degraded conversion
    // also failed to commit, which only a storage refusal causes. That one
    // keeps the watermark where it was, so the next start tries it again. No
    // other owner writes during this pass, so nothing lands between the scan
    // and the watermark.
    if (failed === 0 && through > checked) {
      db.exec("BEGIN IMMEDIATE")
      try {
        recordChecked(db, ADOPTION_MIGRATION_ID)
        db.exec("COMMIT")
      } catch (cause) {
        db.exec("ROLLBACK")
        throw cause
      }
    }
    return { adopted, failed }
  } finally {
    db.close()
    admitPrivateDatabaseFiles(dbFile)
  }
}

/** Commits one workflow's conversion in its own write transaction, prepared
 *  from the state read under the write lock, and returns what it committed.
 *  A refusal rolls the transaction back and throws. */
function commitAdoption(db: Database, inserter: SqliteEventInserter, reader: EventStoreReadSurface, id: string, projectRoot: string, options: AdoptionOptions): PreparedAdoption {
  db.exec("BEGIN IMMEDIATE")
  try {
    const excluded = workflowConversionDeletionTargets(reader)
    const workflow = recoverSessionMetadata(reader, id)
    const prepared = workflow?.kind === "workflow" && !excluded.has(id) ? prepareWorkflowAdoption(reader, id, workflow, excluded, projectRoot, options) : { events: [], warnings: [] }
    if (prepared.events.length) inserter.insertEventRows(prepared.events.map((event) => ({ ...event, id: randomUUID() })))
    db.exec("COMMIT")
    return prepared
  } catch (cause) {
    db.exec("ROLLBACK")
    throw cause
  }
}

function failureKind(cause: unknown): string {
  return cause instanceof Error ? cause.name : typeof cause
}

function transferCells(reader: EventStoreReadSurface, id: string, pendingConversationId: string | undefined, warn: Warn): NonNullable<ReturnType<typeof decodeQueuedUserInputCell>>[] {
  return reader.readInFlight(id, QUEUED_USER_INPUT_IN_FLIGHT_KIND).flatMap((row) => {
    const unreadable = () => {
      warn({ message: "workflow held input unreadable during adoption; cell retained", key: row.key })
      return []
    }
    // The historical display decoder salvages partial fields. Transfer retires
    // bytes, so every content field must decode before that destructive step.
    try {
      Schema.decodeUnknownSync(ChatInputObjectSchema, { onExcessProperty: "error" })({
        text: row.payload.text,
        ...(row.payload.attachments !== undefined || row.payload.images !== undefined ? { attachments: row.payload.attachments ?? row.payload.images } : {}),
        ...(row.payload.invocation !== undefined ? { invocation: row.payload.invocation } : {}),
        ...(row.payload.submissionIds !== undefined ? { submissionIds: row.payload.submissionIds } : {}),
      })
    } catch { return unreadable() }
    const cell = decodeQueuedUserInputCell(row, id)
    if (!cell) return unreadable()
    return cell.target === "workflow" || (pendingConversationId !== undefined && cell.target === "conversation" && cell.conversationId === pendingConversationId) ? [cell] : []
  })
}

/** The words of the result a workflow's adopted card records: its Stop, or
 *  its terminal completion, as the live reconciler words them under the
 *  card's `label`. A terminal result is never invented, so a workflow whose
 *  history this build cannot read keeps its card without one. */
function adoptionCompletionContent(
  reader: EventStoreReadSurface,
  id: string,
  label: string,
  control: CommittedWorkflowControl | undefined,
  stoppedBy: "person" | "agent" | undefined,
  warn: Warn,
): string | undefined {
  if (!stoppedBy && control?.status !== "completed" && control?.status !== "failed") return undefined
  let facts: StoredFact[] | undefined
  try { facts = reader.read({ aggregateId: `workflow:${id}` }) } catch { facts = undefined }
  // A Stop is known from the parent's call, so it is recorded even when the
  // workflow's history is unreadable, only without the last handoff.
  if (stoppedBy) return workflowStopContent({ label, sessionId: id, stoppedBy, handoff: facts ? terminalHandoff(facts) : null })
  if (!facts) {
    warn({ message: "workflow result unreadable during adoption; card recorded without a result" })
    return undefined
  }
  if (control?.status !== "completed" && control?.status !== "failed") return undefined
  const queue = loadQueueFromEvents(facts)
  if (!queue) {
    warn({ message: "workflow result has no loaded queue during adoption; card recorded without a result" })
    return undefined
  }
  return workflowCompletionContent({
    status: control.status, label, sessionId: id,
    results: agentResults(facts, queue), handoff: terminalHandoff(facts), tree: queue.tree, failedAgents: failedAgents(facts, queue.attempts),
    resumable: resumesFailedAgents(facts, control),
    reason: control.status === "failed" ? workflowInsertionRefusalReason(facts) : undefined,
  })
}

/** The chat that owns an adopted workflow: its live parent chat, or the new
 *  adopting chat that this conversion creates. */
interface AdoptionParent {
  readonly id: string
  readonly conversationId: string
  readonly created?: Extract<Session, { kind: "chat" }>
}

function createAdoptingChat(workflow: WorkflowSession, projectRoot: string, now: string): AdoptionParent {
  const created: Extract<Session, { kind: "chat" }> = {
    kind: "chat", command: "chat", conversationId: randomUUID(),
    label: workflow.label || workflow.workflowDefinitionId, name: workflow.name || workflow.label || workflow.workflowDefinitionId,
    executionCwd: recordedExecutionCwd(workflow, projectRoot),
    lifecycleState: "inactive", createdAt: now, lastUpdated: now,
    ...(workflow.authProfileId ? { authProfileId: workflow.authProfileId } : {}),
  }
  return { id: generateSessionId(), conversationId: created.conversationId, created }
}

/** The workflow's recorded parent, and the chat that adopts the workflow:
 *  that recorded parent while it is a chat this conversion can write, or
 *  else a new adopting chat. A degraded adoption always creates a new chat. */
function resolveAdoptionParent(reader: EventStoreReadSurface, workflow: WorkflowSession, excluded: ReadonlySet<string>, projectRoot: string, now: string, degraded: boolean) {
  const previousId = workflow.launchedFrom?.parentSessionId
  const previous = previousId ? recoverSessionMetadata(reader, previousId) : null
  const parent: AdoptionParent = !degraded && previousId !== undefined && !excluded.has(previousId) && previous?.kind === "chat"
    ? { id: previousId, conversationId: previous.conversationId }
    : createAdoptingChat(workflow, projectRoot, now)
  return { previousId, previous, parent }
}

/** The writes that append the batch to the parent's conversation, after the
 *  write that creates the conversation when it does not exist yet. */
function conversationBatchWrites(reader: EventStoreReadSurface, parent: AdoptionParent, state: ConversationTreeProjectionState | undefined, entries: readonly MessageEntry[], now: string): GuardedEventStoreAppend[] {
  if (entries.length === 0) return []
  return [
    ...(state?.created ? [] : ConversationTreeStorage.prepareCreate({ conversationId: parent.conversationId, sessionId: parent.id, createdAt: now })),
    ...ConversationTreeStorage.prepareAppend({
      conversationId: parent.conversationId, sessionId: parent.id, entries, committed: state?.entriesById ?? {},
      expectedSeq: state?.created ? reader.aggregateSeq(`conversation:${parent.conversationId}`) + 1 : 1,
    }),
  ]
}

/** Who a Stop recorded on the call names, or nothing for any other result. */
function stopOf(outcome: ToolExecutionEntry["resultOutcome"]): "person" | "agent" | undefined {
  return outcome === "stopped" ? "person" : outcome === "cancelled" ? "agent" : undefined
}

/** The retirement of every completion notification that an owner holds for
 *  this workflow, under the base key or a re-completion key
 *  (`workflowCompletionEntryId`). */
function completionHoldRetirements(reader: EventStoreReadSurface, ownerId: string, id: string): InFlightWrite[] {
  const base = `workflow-completion:${id}`
  return reader.readInFlight(ownerId, QUEUED_BACKGROUND_NOTIFICATION_IN_FLIGHT_KIND)
    .filter((row) => row.key === base || row.key.startsWith(`${base}:`))
    .map((row) => ({ op: "swap", kind: row.kind, key: row.key, expectedRaw: row.raw, payload: null }))
}

/** The append with in-flight writes added, which land in its commit unit
 *  because the fact makes them true. */
function carrying(event: GuardedEventStoreAppend, writes: readonly InFlightWrite[]): GuardedEventStoreAppend {
  return writes.length === 0 ? event : { ...event, inFlight: [...(event.inFlight ?? []), ...writes] }
}

/** Prepares one guarded conversion from a transaction's captured state. No
 *  writes, execution, or logs: what a person must hear returns with the
 *  events. The parent's new entries form one batch, in the order the
 *  history happened: the adoption notice, the historical completion, then
 *  any transferred follow-up input in its original order and the runtime
 *  interrupt that ends the batch. */
export function prepareWorkflowAdoption(reader: EventStoreReadSurface, id: string, workflow: WorkflowSession, excluded: ReadonlySet<string>, projectRoot: string, options: AdoptionOptions = {}): PreparedAdoption {
  const warnings: AdoptionWarning[] = []
  const warn: Warn = (warning) => { warnings.push(warning) }
  const degraded = options.mode === "degraded"
  const readInvocation = options.readInvocation ?? ((parentId, toolUseId) => invocationFacts(reader, parentId, [toolUseId]))
  const alreadyBacked = !degraded && backed(reader, id, workflow, excluded, readInvocation)
  const control = readControl(reader, id, warn)
  const waiting = control?.followUp?.pendingInput ? control.followUp : null
  const followUpPosition = control !== undefined && inFollowUpPosition(control)
  if (degraded && (waiting || (followUpPosition && holdsWorkflowInput(reader, id)))) warn({ message: DEGRADED_INPUT_RETAINED })
  const pending = degraded ? null : waiting
  if (alreadyBacked && !pending) return { events: [], warnings }
  const timestamp = Date.now()
  const now = new Date(timestamp).toISOString()
  const { previousId, previous, parent } = resolveAdoptionParent(reader, workflow, excluded, projectRoot, now, degraded)
  const state = parent.created ? undefined : readConversationSnapshotSync(reader, parent.conversationId, options.readSources?.())
  const entries: MessageEntry[] = []
  let leaf = state?.leafId ?? null
  const addMessage = (message: Parameters<typeof createConversationMessageEntry>[0], entryId: string = randomUUID()) => {
    const entry = createConversationMessageEntry(message, entryId, leaf, now)
    entries.push(entry)
    leaf = entry.id
  }

  const cells = followUpPosition && !degraded ? transferCells(reader, id, pending?.conversationId, warn) : []
  const queued = cells.map((cell) => ({ cell, entryId: randomUUID() }))
  const cellRetirements: InFlightWrite[] = cells.map((cell) => ({ op: "swap", kind: QUEUED_USER_INPUT_IN_FLIGHT_KIND, key: cell.key, expectedRaw: cell.raw, payload: null }))
  const inputEntryId = randomUUID()
  const turnEndId = turnEndEntryId({ reason: "paused", pausedBy: "runtime" }, randomUUID())
  // Proposed before any entry: the completion that precedes the transferred
  // input reads the control the transfer returns to completed.
  const transfer = pending && control ? proposeFollowUpTransfer(control, readQueue(reader, id, warn), {
    source: { conversationId: pending.conversationId, requestSequence: pending.requestSequence, identity: pending.identity },
    destination: { parentSessionId: parent.id, parentConversationId: parent.conversationId, inputEntryId, turnEndEntryId: turnEndId },
    queuedMappings: queued.map(({ cell, entryId }) => ({ sourceKey: cell.key, destinationEntryId: entryId })),
  }) : undefined

  const events: GuardedEventStoreAppend[] = []
  const guards = new Set([id, parent.id])
  if (!alreadyBacked) {
    if (parent.created) {
      events.push(buildSessionMetadataAppend(parent.id, buildSessionCreatedFact(parent.created), timestamp))
      if (workflow.roleAssignments) events.push(buildSessionMetadataAppend(parent.id, buildSessionRolesSnapshottedFact(workflow.roleAssignments.defaults, now, workflow.roleAssignments.overrides), timestamp))
    }
    const toolUseId = randomUUID()
    const summary = workflow.shortLabel || workflow.label
    const invocation: RuntimeWorkflowInvocationPayload = {
      initiator: "migration", toolUseId, parentConversationId: parent.conversationId,
      // The notice settles its own exchange, so the parent owes no model
      // answer for it and offers no Resume. A transfer below ends the batch
      // at its own runtime interrupt, which Resume continues.
      parentEntryId: turnEndEntryId({ reason: "settled" }, randomUUID()),
      // The card's words, the same words a launch records as its input.
      operation: { kind: "adoption", workflowSessionId: id, workflowDefinitionId: workflow.workflowDefinitionId, ...(summary ? { summary } : {}) },
    }
    // Worded as a direct launch's acknowledgement, the row a person sees
    // above a launched workflow's card.
    addMessage({ kind: "user", content: `Adopted the ${workflow.workflowDefinitionId} workflow into this chat${workflow.label ? `: ${workflow.label}` : "."}`, origin: "system" }, invocation.parentEntryId)
    events.push(buildRuntimeWorkflowInvocationAppend(parent.id, invocation, timestamp))
    const stoppedBy = degraded || previousId === undefined ? undefined : stopOf(tool(reader, previousId, workflow.launchedFrom?.toolUseId)?.resultOutcome)
    const label = workflowNotificationLabel(WORKFLOW_RUNTIME_INVOCATION_TOOL.input(invocation.operation), workflow.workflowDefinitionId)
    const content = adoptionCompletionContent(reader, id, label, transfer?.proposedControl ?? control, stoppedBy, warn)
    // A held completion retires only in the batch that records the
    // completion under the workflow's new parent.
    const holds = (ownerId: string) => content === undefined ? [] : completionHoldRetirements(reader, ownerId, id)
    events.push(carrying(buildSessionMetadataAppend(id, buildSessionOwnershipAdoptedFact(parent.id, parent.conversationId, toolUseId, now), timestamp), transfer ? [] : cellRetirements))
    events.push(carrying(buildSessionMetadataAppend(parent.id, buildSessionChildLinkedFact(id, now), timestamp), holds(parent.id)))
    if (previousId !== undefined && previousId !== parent.id && previous?.childSessionIds?.includes(id)) {
      guards.add(previousId)
      events.push(carrying(buildSessionMetadataAppend(previousId, buildSessionChildUnlinkedFact(id, now), timestamp), holds(previousId)))
    }
    if (content !== undefined) {
      const extracted = extractToolContentFact(childSessionResultFact({ toolUseId }, content, stoppedBy === "person" ? "stopped" : stoppedBy === "agent" ? "cancelled" : "ok"))
      events.push(prepareSessionFactAppend(parent.id, extracted.fact, extracted.contentRows))
      const historical = historicalCompletionEntryId(id)
      if (!state?.entriesById[historical] && !state?.entriesById[`workflow-completion:${id}`]) addMessage({ kind: "user", origin: "system", content }, historical)
    }
  }
  if (transfer || cells.length > 0) {
    addMessage({ kind: "user", origin: "system", content: `Unfinished input from workflow ${id}${pending ? `, conversation ${pending.conversationId}` : ""}. Continue explicitly in this chat.` })
    if (pending?.pendingInput) addMessage(queuedInputMessage({ ...pending.pendingInput, key: randomUUID() }), inputEntryId)
    for (const { cell, entryId } of queued) addMessage(queuedInputMessage(cell), entryId)
    addMessage({ kind: "user", origin: "system", content: interruptedTurnMessage("runtime", false) }, turnEndId)
  }
  if (transfer) {
    events.push(...transfer.proposal.facts.map((fact, index) => carrying({
      ...fact, aggregateId: `workflow:${id}`, sessionId: id, timestamp, expectedSeq: transfer.proposal.expectedSeq + index,
    }, index === 0 ? cellRetirements : [])))
  }
  events.push(...conversationBatchWrites(reader, parent, state, entries, now))
  // A backed workflow's transfer writes no session fact: its workflow
  // control and the parent conversation carry their own sequence guards.
  if (alreadyBacked) return { events, warnings }
  return {
    events: prepareChildSessionPublication({ childSessionId: id, events, sessionGuards: [...guards].map((sessionId) => ({ sessionId, expectedSeq: reader.aggregateSeq(`session:${sessionId}`) + 1 })) }),
    warnings,
  }
}
