import { Schema } from "effect"
import { RuntimeWorkflowInvocationPayloadSchema } from "../../infra/runtime-fact-types.js"
import type { SessionManager, SessionMetadataChange } from "../session/manager.js"
import { ReplayedSessionSchema } from "../session/schemas.js"
import { WorkflowMembershipSchema } from "../../infra/session-workflow-membership.js"
import { RoleSettingEntrySchema as RoleAssignmentEntrySchema, RoleSettingsSchema as RoleAssignmentsSchema } from "../../infra/role-settings.js"
import { SessionLifecycleStateSchema } from "../session/types.js"
import { PersistedAgentMessageSchema } from "../session/conversation/conversation-entry-schemas.js"
import { persistedToConversationMessage } from "../session/conversation/conversation-tree-context.js"
import { WorkflowSessionFactSchema } from "../../workflows/vm/session-facts.js"
import type { ChildSessionDeletionTarget } from "../session/child-session-deletion.js"
import { generateSessionId } from "../../infra/session-id.js"
import { fromStateError, StateErrorSchema, toStateError } from "./project-state-errors.js"
import { createMicrotaskBatch } from "../../infra/microtask-batch.js"

const Id = Schema.NonEmptyString
const Natural = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const OptionalString = Schema.optional(Schema.String)
const LaunchedFromSchema = Schema.Struct({
  parentSessionId: Id,
  conversationId: Schema.optionalKey(Id),
  workflowDefinitionId: Schema.optionalKey(Id),
  toolUseId: Schema.optionalKey(Id),
  description: OptionalString,
})
const ForkSelectionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("active_branch") }),
  Schema.Struct({ kind: Schema.Literal("entry"), entryId: Id, position: Schema.Literals(["at", "before"]) }),
])
const ForkRecordSchema = Schema.Struct({
  eventId: Schema.String,
  eventPosition: Natural,
  timestamp: Schema.Number,
  sourceSessionId: Schema.String,
  targetSessionId: Schema.String,
  selection: ForkSelectionSchema,
  sourceEventPrefixPosition: Natural,
  copiedEntryCount: Natural,
  copiedRootEntryId: OptionalString,
  copiedLeafEntryId: OptionalString,
  publishedAt: Schema.String,
})
const DiffStatsSchema = Schema.Struct({ added: Schema.Number, modified: Schema.Number, removed: Schema.Number })
const catalogFields = {
  id: Schema.String,
  name: OptionalString,
  label: Schema.String,
  shortLabel: OptionalString,
  workflowDefinitionId: OptionalString,
  lifecycleState: SessionLifecycleStateSchema,
  authProfileId: OptionalString,
  command: Schema.String,
  totalCost: Schema.optionalKey(Schema.Number),
  totalBilledCost: Schema.optionalKey(Schema.Number),
  priceUnavailable: Schema.optionalKey(Schema.Boolean),
  totalTokens: Schema.optionalKey(Schema.Number),
  contextPercent: Schema.optionalKey(Schema.Number),
  contextPromptTokens: Schema.optionalKey(Schema.Number),
  durationMs: Schema.optionalKey(Schema.Number),
  diffStats: Schema.optionalKey(DiffStatsSchema),
  lastUpdated: Schema.String,
  createdAt: OptionalString,
  executionCwd: Schema.String,
  activatedAt: OptionalString,
  repo: OptionalString,
  branch: OptionalString,
  conversationId: OptionalString,
  providerConversationId: OptionalString,
  workflowState: Schema.optionalKey(Schema.Literals(["idle", "running", "paused", "completed", "failed"])),
  parentSessionId: OptionalString,
  childSessionIds: Schema.optionalKey(Schema.Array(Schema.String)),
  launchedFrom: Schema.optionalKey(LaunchedFromSchema),
  fork: Schema.optionalKey(ForkRecordSchema),
  degraded: Schema.optionalKey(Schema.Literal(true)),
  unavailableFields: Schema.optionalKey(Schema.Array(Schema.String)),
}
const CatalogRowSchema = Schema.Union([
  Schema.Struct({ ...catalogFields, kind: Schema.Literals(["chat", "subagent"]) }),
  Schema.Struct({ ...catalogFields, kind: Schema.Literal("workflow-agent"), workflowMembership: WorkflowMembershipSchema }),
])
const CatalogSchema = Schema.Struct({
  sessions: Schema.Array(CatalogRowSchema),
  errors: Schema.Array(Schema.Struct({
    sessionId: Schema.String,
    scope: Schema.Literals(["metadata", "budget", "duration", "diffStats", "fork", "output"]),
    reason: Schema.String,
  })),
})

export const InFlightSwapSchema = Schema.Struct({ op: Schema.Literal("swap"), kind: Schema.String, key: Schema.String, expectedRaw: Schema.NullOr(Schema.String), payload: Schema.Unknown, payloadJson: Schema.optionalKey(Schema.NullOr(Schema.String)), sessionId: Schema.optionalKey(Schema.String) })
const RuntimeWorkflowInvocationSchema = Schema.Struct({
  payload: RuntimeWorkflowInvocationPayloadSchema,
  anchor: Schema.Struct({ kind: Schema.Literal("user"), content: Schema.String, origin: Schema.Literals(["human", "system"]) }),
})
/** Every workflow publishes under one chat call (ARCH-WORKFLOWS-015). */
const WorkflowLaunchBindingSchema = Schema.Struct({
  parentSessionId: Id,
  conversationId: Id,
  workflowDefinitionId: Schema.optionalKey(Id),
  toolUseId: Id,
  description: OptionalString,
})
export const PublishWorkflowInputSchema = Schema.Struct({
  id: Id,
  description: Schema.String,
  summary: Schema.optionalKey(Schema.String),
  workflowDefinitionId: Schema.String,
  executionCwd: Schema.optionalKey(Schema.String),
  launchedFrom: WorkflowLaunchBindingSchema,
  initialRoles: RoleAssignmentsSchema,
  authProfileId: Schema.optionalKey(Schema.String),
  facts: Schema.Array(WorkflowSessionFactSchema),
  runtimeInvocation: Schema.optionalKey(RuntimeWorkflowInvocationSchema),
  retainedOperation: Schema.optionalKey(InFlightSwapSchema),
})
const InFlightWriteSchema = Schema.Union([
  Schema.Struct({ op: Schema.Literal("put"), kind: Schema.String, key: Schema.String, payload: Schema.Unknown, payloadJson: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ op: Schema.Literal("drop"), kind: Schema.String, key: Schema.String, sessionId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ op: Schema.Literal("clear"), kind: Schema.String }),
  Schema.Struct({ op: Schema.Literal("clear_session") }),
  InFlightSwapSchema,
])
export const EventStoreAppendSchema = Schema.Struct({
  aggregateId: Schema.String,
  type: Schema.String,
  version: Natural,
  timestamp: Schema.Number,
  actor: Schema.String,
  sessionId: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
  runId: Schema.optionalKey(Schema.String),
  parentEventId: Schema.optionalKey(Schema.String),
  causedByEventId: Schema.optionalKey(Schema.String),
  expectedSeq: Schema.optionalKey(Natural),
  aggregateGuards: Schema.optionalKey(Schema.Array(Schema.Struct({ aggregateId: Id, expectedSeq: Natural }))),
  payloadJson: Schema.optionalKey(Schema.String),
  contentRows: Schema.optionalKey(Schema.Array(Schema.Struct({
    sha256: Schema.String,
    content: Schema.String,
    bytes: Natural,
  }))),
  inFlight: Schema.optionalKey(Schema.Array(InFlightWriteSchema)),
})
export const PublishSubagentInputSchema = Schema.Struct({
  id: Id,
  conversationId: Id,
  description: Schema.String,
  executionCwd: Schema.optionalKey(Schema.String),
  launchedFrom: Schema.Struct({
    parentSessionId: Id,
    conversationId: Id,
    toolUseId: Id,
    description: OptionalString,
  }),
  initialRoles: RoleAssignmentsSchema,
  authProfileId: Schema.optionalKey(Schema.String),
  runBinding: EventStoreAppendSchema,
  promptFact: EventStoreAppendSchema,
  forkHistory: Schema.optionalKey(Schema.Array(PersistedAgentMessageSchema)),
  assignment: Schema.String,
})
const CreateChatInputSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  conversationId: Schema.optionalKey(Schema.String),
  name: OptionalString,
  executionCwd: Schema.optionalKey(Schema.String),
  initialState: Schema.optionalKey(SessionLifecycleStateSchema),
  initialRoles: Schema.optionalKey(RoleAssignmentsSchema),
  authProfileId: Schema.optionalKey(Schema.String),
})
const ChildSessionDeletionTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("workflow"), rootSessionId: Id, workflowId: Id, parentSessionId: Id }),
  Schema.Struct({
    kind: Schema.Literal("child"),
    rootSessionId: Id,
    parentSessionId: Id,
    sessionId: Id,
  }),
  Schema.Struct({
    kind: Schema.Literal("root"),
    rootSessionId: Id,
    sessionId: Id,
  }),
])
const ChildSessionDeletionPlanSchema = Schema.Struct({
  rootSessionId: Id,
  targets: Schema.Array(ChildSessionDeletionTargetSchema),
})
const ReturnedNoticeSchema = Schema.Struct({
  senderSessionId: Id,
  notification: Schema.Struct({ key: Id, text: Schema.String }),
})
/** The read-only session commands. They reach the state Worker only inside a
 *  `session.read-batch`, which carries the reads issued in one tick. */
const SessionReadSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session.list-metadata") }),
  Schema.Struct({ kind: Schema.Literal("session.list-active") }),
  Schema.Struct({ kind: Schema.Literal("session.list-for-ids"), ids: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("session.read"), id: Schema.String }),
])
type SessionRead = typeof SessionReadSchema.Type
export function projectStateSessionCommandSchema<W extends Schema.Top, S extends Schema.Top, A extends Schema.Top>(workflow: W, subagent: S, append: A) {
  return Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session.publish-workflow"), input: workflow }),
  Schema.Struct({ kind: Schema.Literal("session.adopt-workflow"), input: Schema.Struct({ workflowId: Id, launchedFrom: WorkflowLaunchBindingSchema }) }),
  Schema.Struct({ kind: Schema.Literal("session.commit-workflow"), input: Schema.Struct({
    workflowId: Id,
    events: Schema.Array(append),
    localRoles: Schema.optionalKey(RoleAssignmentsSchema),
  }) }),
  Schema.Struct({ kind: Schema.Literal("session.publish-subagent"), input: subagent }),
  Schema.Struct({ kind: Schema.Literal("session.create-chat"), input: CreateChatInputSchema }),
  Schema.Struct({ kind: Schema.Literal("session.fork-chat"), sourceSessionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("session.create-chat-from-context"), sourceSessionId: Schema.String, messages: Schema.Array(PersistedAgentMessageSchema) }),
  Schema.Struct({ kind: Schema.Literal("session.read-batch"), reads: Schema.Array(SessionReadSchema) }),
  Schema.Struct({ kind: Schema.Literal("session.update-lifecycle"), id: Schema.String, lifecycleState: SessionLifecycleStateSchema }),
  Schema.Struct({ kind: Schema.Literal("session.publish-activation"), id: Schema.String, facts: Schema.Array(append) }),
  Schema.Struct({ kind: Schema.Literal("session.update-label"), id: Schema.String, labels: Schema.Struct({ label: Schema.optionalKey(Schema.String), shortLabel: Schema.optionalKey(Schema.String) }), source: Schema.Literals(["user", "generated"]) }),
  Schema.Struct({ kind: Schema.Literal("session.update-chat-metadata"), id: Schema.String, patch: Schema.Struct({ providerConversationId: OptionalString, seedContext: OptionalString }) }),
  Schema.Struct({ kind: Schema.Literal("session.capture-roles"), id: Schema.String, roles: RoleAssignmentsSchema }),
  Schema.Struct({ kind: Schema.Literal("session.capture-profile"), id: Schema.String, authProfileId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("session.select-profile"), id: Schema.String, authProfileId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("session.select-profile-roles"), id: Schema.String, authProfileId: Schema.String, roles: RoleAssignmentsSchema, expected: Schema.optionalKey(Schema.Struct({ authProfileId: OptionalString })) }),
  Schema.Struct({ kind: Schema.Literal("session.replace-roles"), id: Schema.String, roles: RoleAssignmentsSchema, overrides: Schema.optionalKey(RoleAssignmentsSchema) }),
  Schema.Struct({ kind: Schema.Literal("session.update-role"), id: Schema.String, roleId: Schema.String, assignment: RoleAssignmentEntrySchema }),
  Schema.Struct({ kind: Schema.Literal("session.remove-role"), id: Schema.String, roleId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("session.unlink-child"), parentId: Schema.String, childId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("session.admit-child-deletion"), id: Schema.String, inactiveBefore: Schema.optionalKey(Schema.Number) }),
  Schema.Struct({ kind: Schema.Literal("session.finalize-child-deletion-target"), target: ChildSessionDeletionTargetSchema }),
  Schema.Struct({ kind: Schema.Literal("session.recover-stale") }),
  Schema.Struct({ kind: Schema.Literal("session.interrupt-owed"), id: Id }),
  ])
}
const ProjectStateSessionCommandSchema = projectStateSessionCommandSchema(PublishWorkflowInputSchema, PublishSubagentInputSchema, EventStoreAppendSchema)
export type ProjectStateSessionCommand = typeof ProjectStateSessionCommandSchema.Type

/** The existing sessions a command writes or copies. A session that owes
 *  recovery recovers before such a command reads it, so a guard the command
 *  computes from that read stays current. Reads name none: list, detail, and
 *  render append nothing (ARCH-SESSIONS-038). A fork names its source, because it
 *  copies the source's history. */
export function sessionsWrittenBy(command: ProjectStateSessionCommand): readonly string[] {
  switch (command.kind) {
    case "session.update-lifecycle":
    case "session.publish-activation":
    case "session.update-label":
    case "session.update-chat-metadata":
    case "session.capture-roles":
    case "session.capture-profile":
    case "session.select-profile":
    case "session.select-profile-roles":
    case "session.replace-roles":
    case "session.update-role":
    case "session.remove-role":
    case "session.admit-child-deletion":
    case "session.interrupt-owed":
      return [command.id]
    case "session.fork-chat":
    case "session.create-chat-from-context":
      return [command.sourceSessionId]
    case "session.unlink-child":
      return [command.parentId, command.childId]
    case "session.adopt-workflow":
      return [command.input.launchedFrom.parentSessionId]
    case "session.publish-workflow":
    case "session.commit-workflow":
    case "session.publish-subagent":
    case "session.create-chat":
    case "session.read-batch":
    case "session.finalize-child-deletion-target":
    case "session.recover-stale":
      return []
  }
}

const SessionReadResultSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session.list-metadata.result"), value: CatalogSchema }),
  Schema.Struct({ kind: Schema.Literal("session.list-active.result"), value: CatalogSchema }),
  Schema.Struct({ kind: Schema.Literal("session.list-for-ids.result"), value: CatalogSchema }),
  Schema.Struct({ kind: Schema.Literal("session.read.result"), value: Schema.NullOr(ReplayedSessionSchema) }),
])
type SessionReadResult = typeof SessionReadResultSchema.Type
/** One read of a batch: its result, or the failure that fails only its own callers. */
const SessionReadOutcomeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("read"), result: SessionReadResultSchema }),
  Schema.Struct({ kind: Schema.Literal("failed"), error: StateErrorSchema }),
])
type SessionReadOutcome = typeof SessionReadOutcomeSchema.Type

export const ProjectStateSessionResultSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session.adopt-workflow.result"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("session.commit-workflow.result"), value: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("stored"), events: Schema.Array(Schema.Struct({
      ...EventStoreAppendSchema.fields, position: Natural, id: Id, seq: Natural,
    })) }),
    Schema.Struct({ kind: Schema.Literal("conflict"), conflict: Schema.Struct({ aggregateId: Id, expectedSeq: Natural, actualSeq: Natural }) }),
  ]) }),
  Schema.Struct({ kind: Schema.Literal("session.publish-workflow.result"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("session.publish-subagent.result"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("session.create-chat.result"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("session.fork-chat.result"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("session.create-chat-from-context.result"), value: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("session.read-batch.result"), outcomes: Schema.Array(SessionReadOutcomeSchema) }),
  Schema.Struct({ kind: Schema.Literal("session.update-lifecycle.result") }),
  Schema.Struct({ kind: Schema.Literal("session.publish-activation.result") }),
  Schema.Struct({ kind: Schema.Literal("session.update-chat-metadata.result") }),
  Schema.Struct({ kind: Schema.Literal("session.unlink-child.result") }),
  Schema.Struct({ kind: Schema.Literal("session.admit-child-deletion.result"), value: ChildSessionDeletionPlanSchema }),
  Schema.Struct({ kind: Schema.Literal("session.finalize-child-deletion-target.result"), value: Schema.Array(ReturnedNoticeSchema) }),
  Schema.Struct({ kind: Schema.Literal("session.update-label.result"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("session.capture-roles.result"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("session.capture-profile.result"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("session.select-profile.result"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("session.select-profile-roles.result"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("session.replace-roles.result"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("session.update-role.result"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("session.remove-role.result"), value: Schema.Boolean }),
  Schema.Struct({ kind: Schema.Literal("session.recover-stale.result"), value: Natural }),
  Schema.Struct({ kind: Schema.Literal("session.interrupt-owed.result"), value: Schema.Boolean }),
])
export type ProjectStateSessionResult = typeof ProjectStateSessionResultSchema.Type

export const SessionMetadataChangeSchema: Schema.Codec<SessionMetadataChange> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("changed"), sessionIds: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("deleted"), sessionId: Schema.String }),
])

const decodeCommand = Schema.decodeUnknownSync(ProjectStateSessionCommandSchema, { onExcessProperty: "error" })
const decodeResult = Schema.decodeUnknownSync(ProjectStateSessionResultSchema, { onExcessProperty: "error" })
const decodeChange = Schema.decodeUnknownSync(SessionMetadataChangeSchema, { onExcessProperty: "error" })

export interface ProjectStateSessionsTransport {
  request(command: ProjectStateSessionCommand): Promise<ProjectStateSessionResult>
  subscribe(listener: (change: unknown) => void): () => void
}

export interface ProjectStateSessionsService {
  request(value: unknown): Promise<ProjectStateSessionResult>
  subscribe(listener: (change: SessionMetadataChange) => void): () => void
}

/** The session work the state Worker runs beside its session manager. */
interface ProjectStateSessionWork {
  /** Joins the deferred stale-session pass: it settles child runs an
   *  earlier process left open, after the manager has settled the sessions
   *  themselves. */
  readonly recoverOrphanedRuns?: () => Promise<number>
  /** A person's interrupt of a session that no executor holds, which a
   *  successor may owe its continuation (`recordOwedPersonInterrupt`):
   *  whether it recorded the person's turn end over the planned cut. */
  readonly interruptOwed?: (sessionId: string) => Promise<boolean>
}

/** A session manager as the state Worker's port serves it, with the one
 *  session command that is no manager method. */
export interface ProjectStateSessionManager extends SessionManager {
  /** Records, through the state Worker's conversation writer, a person's
   *  interrupt of a session that no executor holds and a successor owes its
   *  continuation, and retires the session's row. Whether it recorded one. */
  interruptOwed(sessionId: string): Promise<boolean>
}

/** Validates state-worker commands before invoking the sole durable session
 *  manager and the session work the state Worker runs beside it. */
export function createProjectStateSessionsService(manager: SessionManager, work: ProjectStateSessionWork = {}): ProjectStateSessionsService {
  const { recoverOrphanedRuns } = work
  async function read(command: SessionRead): Promise<SessionReadResult> {
    switch (command.kind) {
      case "session.list-metadata": return { kind: "session.list-metadata.result", value: await manager.listMetadata() }
      case "session.list-active": return { kind: "session.list-active.result", value: await manager.listActive() }
      case "session.list-for-ids": return { kind: "session.list-for-ids.result", value: await manager.listForIds(command.ids) }
      case "session.read": return { kind: "session.read.result", value: await manager.read(command.id) }
    }
  }
  return {
    async request(value: unknown): Promise<ProjectStateSessionResult> {
      const command = decodeCommand(value)
      switch (command.kind) {
        case "session.adopt-workflow": return { kind: "session.adopt-workflow.result", value: await manager.adoptWorkflow(command.input) }
        case "session.commit-workflow": return { kind: "session.commit-workflow.result", value: await manager.commitWorkflow(command.input) }
        case "session.publish-workflow": {
          return {
            kind: "session.publish-workflow.result",
            value: await manager.publishWorkflow(command.input),
          }
        }
        case "session.publish-subagent": {
          const { forkHistory, ...input } = command.input
          return {
            kind: "session.publish-subagent.result",
            value: await manager.publishSubagent({ ...input, ...(forkHistory ? { forkHistory: forkHistory.map(persistedToConversationMessage) } : {}) }),
          }
        }
        case "session.create-chat": return { kind: "session.create-chat.result", value: await manager.createChat(command.input) }
        case "session.fork-chat": return { kind: "session.fork-chat.result", value: await manager.forkChat(command.sourceSessionId) }
        case "session.create-chat-from-context": return {
          kind: "session.create-chat-from-context.result",
          value: await manager.createChatFromContext(command.sourceSessionId, command.messages.map(persistedToConversationMessage)),
        }
        case "session.read-batch": {
          // One after another, as separate requests were served: concurrent
          // catalog reads can order sessions of one timestamp differently.
          const outcomes: SessionReadOutcome[] = []
          for (const each of command.reads) {
            outcomes.push(await read(each).then(
              (result): SessionReadOutcome => ({ kind: "read", result }),
              (error: unknown): SessionReadOutcome => ({ kind: "failed", error: toStateError(error) }),
            ))
          }
          return { kind: "session.read-batch.result", outcomes }
        }
        case "session.update-lifecycle": await manager.updateLifecycleState(command.id, command.lifecycleState); return { kind: "session.update-lifecycle.result" }
        case "session.publish-activation": await manager.publishActivation(command.id, command.facts); return { kind: "session.publish-activation.result" }
        case "session.update-label": return { kind: "session.update-label.result", value: await manager.updateLabel(command.id, command.labels, command.source) }
        case "session.update-chat-metadata": await manager.updateChatMetadata(command.id, command.patch); return { kind: "session.update-chat-metadata.result" }
        case "session.capture-roles": return { kind: "session.capture-roles.result", value: await manager.captureRolesIfAbsent(command.id, command.roles) }
        case "session.capture-profile": return { kind: "session.capture-profile.result", value: await manager.captureAuthProfileIfAbsent(command.id, command.authProfileId) }
        case "session.select-profile": return { kind: "session.select-profile.result", value: await manager.selectAuthProfile(command.id, command.authProfileId) }
        case "session.select-profile-roles": return { kind: "session.select-profile-roles.result", value: await manager.selectAuthProfileWithRoleSnapshot(command.id, command.authProfileId, command.roles, command.expected === undefined ? undefined : { authProfileId: command.expected.authProfileId }) }
        case "session.replace-roles": return { kind: "session.replace-roles.result", value: await manager.replaceRoleSnapshot(command.id, command.roles, command.overrides) }
        case "session.update-role": return { kind: "session.update-role.result", value: await manager.updateRoleAssignment(command.id, command.roleId, command.assignment) }
        case "session.remove-role": return { kind: "session.remove-role.result", value: await manager.removeRoleAssignment(command.id, command.roleId) }
        case "session.unlink-child": await manager.unlinkChild(command.parentId, command.childId); return { kind: "session.unlink-child.result" }
        case "session.admit-child-deletion": {
          return {
            kind: "session.admit-child-deletion.result",
            value: await manager.admitDeletion(command.id, command.inactiveBefore),
          }
        }
        case "session.finalize-child-deletion-target": {
          return { kind: "session.finalize-child-deletion-target.result", value: await manager.finalizeDeletionTarget(command.target) }
        }
        case "session.recover-stale": {
          const sessions = await manager.recoverStaleSessions()
          return { kind: "session.recover-stale.result", value: sessions + (await recoverOrphanedRuns?.() ?? 0) }
        }
        case "session.interrupt-owed": {
          if (!work.interruptOwed) throw new Error("This state Worker records no person's interrupt of an owed session")
          return { kind: "session.interrupt-owed.result", value: await work.interruptOwed(command.id) }
        }
      }
    },
    subscribe(listener: (change: SessionMetadataChange) => void): () => void {
      return manager.subscribe((change) => listener(decodeChange(change)))
    },
  }
}

/** Equal reads ask one question, so a batch asks it once. A `session.list-for-ids`
 *  keeps its own id list: the manager orders sessions of one timestamp by the
 *  order of the ids it receives. */
function readKey(read: SessionRead): string {
  return JSON.stringify(read)
}

/** Creates a stateless SessionManager proxy over the state worker session port.
 *  The reads issued in one tick travel as one request, sent at the next
 *  microtask or before the next write, whichever comes first, so a write
 *  never overtakes a read issued before it and a read issued after a write
 *  sees it. */
export function createProjectStateSessionManager(transport: ProjectStateSessionsTransport): ProjectStateSessionManager {
  const readBatch = createMicrotaskBatch(async (reads: readonly SessionRead[]) => {
    const distinct = new Map(reads.map((read) => [readKey(read), read]))
    const result = await send({ kind: "session.read-batch", reads: [...distinct.values()] })
    if (result.kind !== "session.read-batch.result") throw new Error(`Unexpected session result: ${result.kind}`)
    const { outcomes } = result
    const outcomeOf = new Map([...distinct.keys()].map((key, index) => [key, outcomes[index]]))
    return new Map(reads.flatMap((read) => {
      const outcome = outcomeOf.get(readKey(read))
      return outcome ? [[read, outcome] as const] : []
    }))
  })

  async function send(command: ProjectStateSessionCommand): Promise<ProjectStateSessionResult> {
    return decodeResult(await transport.request(command))
  }
  function request(command: ProjectStateSessionCommand): Promise<ProjectStateSessionResult> {
    readBatch.flush()
    return send(command)
  }
  async function readSession(read: SessionRead): Promise<SessionReadResult> {
    const outcome = await readBatch(read)
    if (outcome.kind === "failed") throw fromStateError(outcome.error)
    return outcome.result
  }
  async function stringValue(command: ProjectStateSessionCommand, kind: "session.publish-workflow.result" | "session.publish-subagent.result" | "session.create-chat.result" | "session.fork-chat.result" | "session.create-chat-from-context.result"): Promise<string> {
    const result = await request(command)
    if (result.kind !== kind || !("value" in result)) throw new Error(`Unexpected session result: ${result.kind}`)
    return result.value
  }
  async function booleanValue(command: ProjectStateSessionCommand, kind:
    | "session.adopt-workflow.result"
    | "session.update-label.result" | "session.capture-roles.result" | "session.capture-profile.result"
    | "session.select-profile.result" | "session.select-profile-roles.result" | "session.replace-roles.result"
    | "session.update-role.result" | "session.remove-role.result" | "session.interrupt-owed.result"): Promise<boolean> {
    const result = await request(command)
    if (result.kind !== kind || !("value" in result)) throw new Error(`Unexpected session result: ${result.kind}`)
    return result.value
  }
  async function catalogValue(command: SessionRead, kind: "session.list-metadata.result" | "session.list-active.result" | "session.list-for-ids.result") {
    const result = await readSession(command)
    if (result.kind !== kind) throw new Error(`Unexpected session result: ${result.kind}`)
    return result.value
  }
  async function done(command: ProjectStateSessionCommand, kind: ProjectStateSessionResult["kind"]): Promise<void> {
    const result = await request(command)
    if (result.kind !== kind) throw new Error(`Unexpected session result: ${result.kind}`)
  }
  async function publishSubagent(input: Parameters<SessionManager["publishSubagent"]>[0]): Promise<string> {
    const conversationId = input.launchedFrom.conversationId
    if (!conversationId) throw new Error("Subagent publication requires the dispatching conversation id")
    return stringValue({
      kind: "session.publish-subagent",
      input: { ...input, launchedFrom: { ...input.launchedFrom, conversationId } },
    }, "session.publish-subagent.result")
  }
  return {
    allocateId: generateSessionId,
    publishWorkflow: (input) => stringValue({ kind: "session.publish-workflow", input }, "session.publish-workflow.result"),
    adoptWorkflow: (input) => booleanValue({ kind: "session.adopt-workflow", input }, "session.adopt-workflow.result"),
    async commitWorkflow(input) {
      const result = await request({ kind: "session.commit-workflow", input })
      if (result.kind !== "session.commit-workflow.result") throw new Error(`Unexpected session result: ${result.kind}`)
      return result.value
    },
    publishSubagent,
    createChat: (input) => stringValue({ kind: "session.create-chat", input }, "session.create-chat.result"),
    forkChat: (sourceSessionId) => stringValue({ kind: "session.fork-chat", sourceSessionId }, "session.fork-chat.result"),
    createChatFromContext: (sourceSessionId, messages) => stringValue({
      kind: "session.create-chat-from-context", sourceSessionId, messages: [...messages],
    }, "session.create-chat-from-context.result"),
    listMetadata: () => catalogValue({ kind: "session.list-metadata" }, "session.list-metadata.result"),
    listActive: () => catalogValue({ kind: "session.list-active" }, "session.list-active.result"),
    listForIds: (ids) => catalogValue({ kind: "session.list-for-ids", ids }, "session.list-for-ids.result"),
    async read(id) {
      const result = await readSession({ kind: "session.read", id })
      if (result.kind !== "session.read.result") throw new Error(`Unexpected session result: ${result.kind}`)
      return result.value
    },
    updateLifecycleState: (id, lifecycleState) => done({ kind: "session.update-lifecycle", id, lifecycleState }, "session.update-lifecycle.result"),
    publishActivation: (id, facts) => done({ kind: "session.publish-activation", id, facts }, "session.publish-activation.result"),
    updateLabel: (id, labels, source) => booleanValue({ kind: "session.update-label", id, labels, source }, "session.update-label.result"),
    updateChatMetadata: (id, patch) => done({ kind: "session.update-chat-metadata", id, patch }, "session.update-chat-metadata.result"),
    captureRolesIfAbsent: (id, roles) => booleanValue({ kind: "session.capture-roles", id, roles }, "session.capture-roles.result"),
    captureAuthProfileIfAbsent: (id, authProfileId) => booleanValue({ kind: "session.capture-profile", id, authProfileId }, "session.capture-profile.result"),
    selectAuthProfile: (id, authProfileId) => booleanValue({ kind: "session.select-profile", id, authProfileId }, "session.select-profile.result"),
    selectAuthProfileWithRoleSnapshot: (id, authProfileId, roles, expected) => booleanValue({ kind: "session.select-profile-roles", id, authProfileId, roles, ...(expected === undefined ? {} : { expected }) }, "session.select-profile-roles.result"),
    replaceRoleSnapshot: (id, roles, overrides) => booleanValue({ kind: "session.replace-roles", id, roles, ...(overrides ? { overrides } : {}) }, "session.replace-roles.result"),
    updateRoleAssignment: (id, roleId, assignment) => booleanValue({ kind: "session.update-role", id, roleId, assignment }, "session.update-role.result"),
    removeRoleAssignment: (id, roleId) => booleanValue({ kind: "session.remove-role", id, roleId }, "session.remove-role.result"),
    unlinkChild: (parentId, childId) => done({ kind: "session.unlink-child", parentId, childId }, "session.unlink-child.result"),
    async admitDeletion(id, inactiveBefore) {
      const result = await request({ kind: "session.admit-child-deletion", id, ...(inactiveBefore === undefined ? {} : { inactiveBefore }) })
      if (result.kind !== "session.admit-child-deletion.result") throw new Error(`Unexpected session result: ${result.kind}`)
      return result.value
    },
    async finalizeDeletionTarget(target: ChildSessionDeletionTarget) {
      const result = await request({ kind: "session.finalize-child-deletion-target", target })
      if (result.kind !== "session.finalize-child-deletion-target.result") throw new Error(`Unexpected session result: ${result.kind}`)
      return result.value
    },
    async recoverStaleSessions() {
      const result = await request({ kind: "session.recover-stale" })
      if (result.kind !== "session.recover-stale.result") throw new Error(`Unexpected session result: ${result.kind}`)
      return result.value
    },
    interruptOwed: (id) => booleanValue({ kind: "session.interrupt-owed", id }, "session.interrupt-owed.result"),
    subscribe(listener) {
      return transport.subscribe((change) => listener(decodeChange(change)))
    },
  }
}
