import { canonicalDirectory } from "../../infra/directory-authorities.js"
import { errorDetail, errorMessage } from "../../infra/error-message.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter, EventStoreAppend, GuardedEventStoreAppend, InFlightSwap } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { RuntimeWorkflowInvocationPayload } from "../../infra/runtime-fact-types.js"
import { startupTrace } from "../../infra/startup-trace.js"
import { workflowAggregateId, type WorkflowSessionFact } from "../../workflows/vm/session-facts.js"
import { workflowRunOwner } from "../module-catalog.js"
import type { ConversationMessage } from "../agent-runtime/llm/types.js"
import { tryOpenConversationTree } from "./conversation/conversation-tree-handle.js"
import { createConversationMessageEntries } from "./conversation/conversation-tree.js"
import { ConversationTreeStorage } from "./conversation/conversation-tree-storage.js"
import { prepareChildExecutionOwner } from "./child-execution-resources.js"
import type { SessionLaunchedFrom } from "./session-catalog-types.js"
import { sessionDisplayName, type ReplayedSession, type RoleSettings as RoleAssignments, type Session } from "./schemas.js"
import { buildSessionAuthProfileSelectedFact, buildSessionChildLinkedFact, buildSessionCreatedFact, buildSessionRolesSnapshottedFact } from "./session-metadata-facts.js"
import { buildSessionMetadataAppend, type createSessionMetadataStore } from "./session-metadata-store.js"
import { readInheritedCheckpointIntent, readRecordedInheritedIntent } from "./conversation-checkpoint.js"
import { parseSessionIntentInheritedFact } from "./conversation-checkpoint-facts.js"

const MAX_SUBAGENT_DEPTH = 3
const log = Log.create({ service: "child-session-publication" })

export class SubagentDepthLimitError extends Error {}

/** A workflow publication whose binding names no chat conversation: the
 *  parent is missing, is not a chat, or holds another conversation. The
 *  message is the refusal a launch reports. */
export class WorkflowParentRefusal extends Error {
  override readonly name = "WorkflowParentRefusal"
}

/** The parent chat call that owns a published workflow (ARCH-WORKFLOWS-015): every
 *  workflow publishes under one chat conversation and one tool call of it,
 *  a model's call or a runtime invocation. */
export interface WorkflowLaunchBinding extends SessionLaunchedFrom {
  readonly conversationId: string
  readonly toolUseId: string
}

/** Complete workflow creation material passed through the state-worker boundary. */
export interface WorkflowPublication {
  readonly id: string
  readonly description: string
  /** The short title the launch gave. Registration stores it as the run's
   *  name, so Flywheel generates no name for this run. */
  readonly summary?: string
  readonly workflowDefinitionId: string
  readonly executionCwd?: string
  readonly launchedFrom: WorkflowLaunchBinding
  readonly initialRoles: RoleAssignments
  readonly authProfileId?: string
  readonly facts: readonly WorkflowSessionFact[]
  /** Non-model launch evidence committed in the parent aggregate with the
   *  child metadata and live link. Model launches already own agent input. */
  readonly runtimeInvocation?: RuntimeWorkflowInvocation
  /** Exact retained operation retired by this publication's parent entry. */
  readonly retainedOperation?: InFlightSwap
}

/** One runtime-origin workflow call's evidence in its parent chat: the
 *  invocation fact, and the message its card anchors to, which the
 *  publication appends under the fact's `parentEntryId`. The workflow host
 *  writes the message and chooses that id, a turn-end record's id when the
 *  message settles the exchange. The kernel only validates and appends them,
 *  so no workflow wording lives in the conversation tree. */
export interface RuntimeWorkflowInvocation {
  readonly payload: RuntimeWorkflowInvocationPayload
  readonly anchor: RuntimeInvocationAnchor
}

/** A user-role message: a person's command reads as the person's own words,
 *  and a headless or migration record as produced input. */
interface RuntimeInvocationAnchor {
  readonly kind: "user"
  readonly content: string
  readonly origin: "human" | "system"
}

/** Builds the parent-owned timeline evidence that joins one guarded child
 *  publication. The publication caller supplies the trusted origin and anchor. */
export function buildRuntimeWorkflowInvocationAppend(
  parentSessionId: string,
  payload: RuntimeWorkflowInvocationPayload,
  timestamp: number,
): EventStoreAppend {
  return {
    aggregateId: `session:${parentSessionId}`,
    type: "tool.runtime_invocation.recorded",
    version: 3,
    timestamp,
    actor: "flywheel",
    sessionId: parentSessionId,
    payload,
  }
}

/** Expected next sequence for one session aggregate in an atomic publication. */
interface SessionSequenceGuard {
  readonly sessionId: string
  readonly expectedSeq: number
}

/** Child-owned events plus every session aggregate that must remain unchanged. */
export interface ChildSessionPublicationInput {
  readonly childSessionId: string
  readonly events: readonly GuardedEventStoreAppend[]
  readonly sessionGuards: readonly SessionSequenceGuard[]
}

/**
 * Validates one atomic child publication and applies each session aggregate
 * sequence fence. Child-owned sibling aggregates retain their own guards.
 */
export function prepareChildSessionPublication(input: ChildSessionPublicationInput): readonly GuardedEventStoreAppend[] {
  if (input.childSessionId.length === 0) throw new Error("Child session publication requires a child session id")
  const guards = new Map<string, number>()
  for (const guard of input.sessionGuards) {
    if (guard.sessionId.length === 0 || !Number.isSafeInteger(guard.expectedSeq) || guard.expectedSeq < 0) {
      throw new Error("Child session publication received an invalid session sequence guard")
    }
    if (guards.has(guard.sessionId)) throw new Error(`Child session publication has duplicate guard for ${guard.sessionId}`)
    guards.set(guard.sessionId, guard.expectedSeq)
  }
  if (!guards.has(input.childSessionId)) {
    throw new Error(`Child session publication is missing its child guard for ${input.childSessionId}`)
  }

  const guardedIndexes = new Map<number, number>()
  for (const [sessionId, expectedSeq] of guards) {
    const aggregateId = `session:${sessionId}`
    const index = input.events.findIndex((event) => event.sessionId === sessionId && event.aggregateId === aggregateId)
    if (index < 0) throw new Error(`Child session publication has no metadata event for ${sessionId}`)
    const existing = input.events[index]?.expectedSeq
    if (existing !== undefined && existing !== expectedSeq) {
      throw new Error(`Child session publication guard for ${sessionId} conflicts with the prepared event`)
    }
    guardedIndexes.set(index, expectedSeq)
  }

  return input.events.map((event, index) => {
    if (event.sessionId === input.childSessionId) {
      if (event.aggregateId.startsWith("session:") && event.aggregateId !== `session:${input.childSessionId}`) {
        throw new Error(`Child session publication event ${event.type} targets another session aggregate`)
      }
    } else {
      const expectedAggregate = `session:${event.sessionId}`
      const guardedCompanion = event.aggregateId.startsWith("conversation:") && event.expectedSeq !== undefined
      if (!guards.has(event.sessionId) || (!guardedCompanion && event.aggregateId !== expectedAggregate)) {
        throw new Error(`Child session publication event ${event.type} has unrelated identity ${event.sessionId}`)
      }
    }
    const expectedSeq = guardedIndexes.get(index)
    return expectedSeq === undefined ? event : { ...event, expectedSeq }
  })
}

/** Complete subagent creation material. The subagents module builds and
 *  validates the child-owned facts. They target `session:<id>`; the guarded
 *  creation fact proves that aggregate was empty before the atomic
 *  publication. */
export interface SubagentSessionPublication {
  id: string
  conversationId: string
  description: string
  executionCwd?: string
  launchedFrom: SessionLaunchedFrom & { toolUseId: string }
  initialRoles: RoleAssignments
  authProfileId?: string
  runBinding: GuardedEventStoreAppend
  promptFact: GuardedEventStoreAppend
  /** The parent conversation that a fork starts from. */
  forkHistory?: readonly ConversationMessage[]
  /** The words of the launching call that the child works on. The child's
   *  conversation starts with them as a message from the parent. */
  assignment: string
}

interface ChildSessionPublicationPorts {
  readonly projectRoot: string
  readonly executionCwd: string
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly metadata: Pick<ReturnType<typeof createSessionMetadataStore>, "read" | "readOrThrow" | "allocateId">
  readonly blocksLaunch: (sessionId: string) => Promise<boolean>
  /** The manager's guarded append, which fences every parent aggregate. */
  readonly append: (
    childSessionId: string,
    parentSessionIds: readonly string[],
    prepareEvents: () => Promise<readonly EventStoreAppend[]>,
    operation: string,
    childConflictMessage: string,
  ) => Promise<void>
  readonly notifyChanged: (sessionIds: readonly string[]) => void
  readonly appendWorkflow: (workflowId: string, parentSessionId: string, prepare: () => Promise<readonly GuardedEventStoreAppend[]>) => Promise<void>
}

export interface ChildSessionPublisher {
  workflow(input: WorkflowPublication): Promise<string>
  subagent(input: SubagentSessionPublication): Promise<string>
}

/** Prepares and publishes each child kind under SessionManager's structural
 *  mutation fence. The manager keeps that fence, the guarded append, and
 *  notification; this module owns what a child's publication contains and
 *  which parent admits it. */
export function createChildSessionPublication(ports: ChildSessionPublicationPorts): ChildSessionPublisher {
  const { metadata, projectRoot } = ports

  /** Prepares the child's owner directory before the atomic append. An abort
   *  removes the directory only when this publication created it for an id
   *  that it alone holds. A retained launch reserves its id, so another
   *  process can commit the same child at any moment; its directory stays. */
  async function publish(
    child: { readonly id: string; readonly parentId: string; readonly now: string; readonly reserved: boolean },
    operation: string,
    childConflictMessage: string,
    events: () => Promise<readonly EventStoreAppend[]>,
  ): Promise<string> {
    const { id, parentId, now, reserved } = child
    const owner = prepareChildExecutionOwner(id, projectRoot, reserved)
    try {
      await ports.append(id, [parentId], async () => [
        ...await events(),
        buildSessionMetadataAppend(parentId, buildSessionChildLinkedFact(id, now), Date.parse(now)),
      ], operation, childConflictMessage)
    } catch (error) {
      owner.rollback()
      throw error
    }
    try {
      ports.notifyChanged([id, parentId])
    } catch (error) {
      // The append is committed. A subscriber failure cannot turn it into an abort.
      log.warn("committed child publication notification failed", { sessionId: id, parentSessionId: parentId, error: errorMessage(error), errorDetail: errorDetail(error) })
    }
    return id
  }

  async function prepareRuntimeInvocationEntry(
    parentSessionId: string,
    parent: ReplayedSession,
    { payload, anchor }: RuntimeWorkflowInvocation,
    retainedOperation?: InFlightSwap,
  ): Promise<readonly EventStoreAppend[]> {
    if (parent.kind !== "chat" || parent.conversationId !== payload.parentConversationId) {
      throw new Error("Runtime workflow invocation must target its parent chat conversation")
    }
    const tree = await tryOpenConversationTree({
      conversationId: parent.conversationId,
      sessionId: parentSessionId,
      store: ports.reader,
      writer: ports.writer,
    })
    if (!tree) throw new Error(`Runtime workflow invocation parent conversation is missing: ${parent.conversationId}`)
    try {
      const [append, ...rest] = await tree.prepareMessagesAppend([{ id: payload.parentEntryId, message: anchor }])
      if (!append) throw new Error(`Runtime workflow invocation entry already exists: ${payload.parentEntryId}`)
      return [retainedOperation ? { ...append, inFlight: [retainedOperation] } : append, ...rest]
    } finally {
      tree.getStorage().dispose()
    }
  }

  async function workflow(input: WorkflowPublication): Promise<string> {
    if (await ports.reader.aggregateSeq(workflowAggregateId(input.id)) >= 0) throw new Error(`Workflow already exists: ${input.id}`)
    const parentId = input.launchedFrom.parentSessionId
    if (await ports.blocksLaunch(parentId)) {
      throw new Error(`Cannot publish a workflow below session ${parentId} while deletion is in progress`)
    }
    // ARCH-WORKFLOWS-015, PI-INTERACTION-022: a workflow's owner is a chat. This boundary owns the rule, so
    // no publisher can create an orphan or a workflow below a workflow. A
    // session's kind and conversation never change, so this read needs no guard.
    const parent = await metadata.read(parentId)
    if (parent?.kind !== "chat" || parent.conversationId !== input.launchedFrom.conversationId) {
      throw new WorkflowParentRefusal(`Workflow parent ${parentId} is not the host-attested chat conversation`)
    }
    const invocation = input.runtimeInvocation
    if (invocation) {
      if (input.launchedFrom.toolUseId !== invocation.payload.toolUseId) {
        throw new Error("Runtime workflow invocation must match the parent launch binding")
      }
      const { operation } = invocation.payload
      if (operation.kind !== "launch"
        || operation.input.workflowDefinitionId !== input.workflowDefinitionId
        || operation.input.description !== input.description) {
        throw new Error("Runtime workflow invocation does not match the workflow launch")
      }
    }
    if (input.retainedOperation && !invocation) {
      throw new Error("Retained workflow publication requires a runtime invocation")
    }
    const now = new Date().toISOString()
    const timestamp = Date.parse(now)
    const facts = workflowRunOwner().registration(input,
      canonicalDirectory(input.executionCwd ?? parent.executionCwd ?? ports.executionCwd, "workflow execution directory"), now)
    const childEvents: EventStoreAppend[] = facts.map((fact, index) => ({
        aggregateId: workflowAggregateId(input.id),
        type: fact.type,
        version: fact.version,
        timestamp,
        actor: fact.actor,
        sessionId: input.id,
        payload: fact.payload,
        ...(index === 0 ? { expectedSeq: 0 } : {}),
      }))
    await ports.appendWorkflow(input.id, parentId, async () => [
        ...childEvents,
        ...(invocation ? [
          ...await prepareRuntimeInvocationEntry(parentId, parent, invocation, input.retainedOperation),
          buildRuntimeWorkflowInvocationAppend(parentId, invocation.payload, timestamp),
        ] : []),
    ])
    try { ports.notifyChanged([parentId]) } catch (error) {
      log.warn("committed workflow publication notification failed", { workflowId: input.id, parentSessionId: parentId, error: errorMessage(error) })
    }
    startupTrace("workflow aggregate publication persisted")
    return input.id
  }

  /** Counts the subagents above a new child, refusing past the depth limit. */
  async function subagentDepth(parentSessionId: string): Promise<number> {
    let depth = 1
    let ancestor = await metadata.readOrThrow(parentSessionId)
    while (ancestor.kind === "subagent") {
      depth += 1
      if (depth > MAX_SUBAGENT_DEPTH) throw new SubagentDepthLimitError(`Subagent depth ${depth} exceeds the maximum depth ${MAX_SUBAGENT_DEPTH}`)
      ancestor = await metadata.readOrThrow(ancestor.launchedFrom.parentSessionId)
    }
    return depth
  }

  async function subagent(input: SubagentSessionPublication): Promise<string> {
    if (input.runBinding.sessionId !== input.id) {
      throw new Error(`Subagent run binding session ${input.runBinding.sessionId} does not match child session ${input.id}`)
    }
    if (input.runBinding.aggregateId !== `session:${input.id}`) {
      throw new Error(`Subagent run binding aggregate ${input.runBinding.aggregateId} does not belong to child session ${input.id}`)
    }
    if (input.promptFact.sessionId !== input.id || input.promptFact.aggregateId !== `session:${input.id}`) {
      throw new Error(`Subagent prompt fact does not belong to child session ${input.id}`)
    }
    if (await metadata.read(input.id)) throw new Error(`Session already exists: ${input.id}`)
    const parentId = input.launchedFrom.parentSessionId
    if (await ports.blocksLaunch(parentId)) throw new Error(`Cannot launch a subagent below session ${parentId} while deletion is in progress`)
    const parent = await metadata.readOrThrow(parentId)
    await subagentDepth(parentId)

    const now = new Date().toISOString()
    const timestamp = Date.parse(now)
    const sessionData: Session = {
      name: input.description,
      label: input.description,
      lastUpdated: now,
      createdAt: now,
      activatedAt: now,
      lifecycleState: "active",
      executionCwd: canonicalDirectory(input.executionCwd ?? parent.executionCwd ?? ports.executionCwd, "session execution directory"),
      launchedFrom: {
        parentSessionId: input.launchedFrom.parentSessionId,
        toolUseId: input.launchedFrom.toolUseId,
        ...(input.launchedFrom.conversationId !== undefined ? { conversationId: input.launchedFrom.conversationId } : {}),
        ...(input.launchedFrom.description !== undefined ? { description: input.launchedFrom.description } : {}),
      },
      kind: "subagent",
      command: "subagent",
      conversationId: input.conversationId,
      ...(input.authProfileId !== undefined ? { authProfileId: input.authProfileId } : {}),
    }
    const assignment: ConversationMessage = {
      kind: "user",
      content: input.assignment,
      producer: { kind: "launch", sessionId: parentId, toolUseId: input.launchedFrom.toolUseId, name: sessionDisplayName({ id: parentId, session: parent }) },
    }
    // A parent subagent whose own checkpoint holds no approved intent passes
    // on the intent that it inherited, which no history of its carries.
    const inheritedIntent = (input.launchedFrom.conversationId === undefined ? undefined
      : await readInheritedCheckpointIntent(ports.reader, parentId, input.launchedFrom.conversationId))
      ?? await readRecordedInheritedIntent(ports.reader, parentId)
    const initialEntries = await createConversationMessageEntries([...input.forkHistory ?? [], assignment], null, () => metadata.allocateId(), () => now)
    const conversationEvents = ConversationTreeStorage.prepareCreateWithEntries({ conversationId: input.conversationId, sessionId: input.id, createdAt: now, entries: initialEntries })
    return publish({ id: input.id, parentId, now, reserved: false }, "subagent publication", "subagent publication destination changed before publication", async () => [
      ...conversationEvents,
      { ...buildSessionMetadataAppend(input.id, buildSessionCreatedFact(sessionData), timestamp), expectedSeq: 0 },
      ...(input.authProfileId !== undefined
        ? [buildSessionMetadataAppend(input.id, buildSessionAuthProfileSelectedFact(input.authProfileId), timestamp)]
        : []),
      buildSessionMetadataAppend(input.id, buildSessionRolesSnapshottedFact({}, now, input.initialRoles), timestamp),
      ...(inheritedIntent === undefined ? [] : [{
        aggregateId: `session:${input.id}`, sessionId: input.id, timestamp,
        ...parseSessionIntentInheritedFact({ type: "session.intent.inherited", version: 1, actor: "flywheel", payload: { intent: inheritedIntent } }),
      }]),
      input.runBinding,
      input.promptFact,
    ])
  }

  return { workflow, subagent }
}
