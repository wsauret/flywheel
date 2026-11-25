import type { AsyncEventStateReadSurface, GuardedAppendResult, GuardedEventStoreAppend } from "../../../infra/substrate/store/event-store-types.js"
import { parseWorkflowSessionFact } from "../../../workflows/vm/facts/session-facts.js"
import { workflowRunOwner } from "../../module-contract/module-catalog.js"
import { workflowMembershipReader, type WorkflowMember } from "../metadata/workflow-membership.js"
import type { ReplayedSession, RoleSettings, Session } from "../metadata/schemas.js"
import { prepareChildExecutionOwner } from "../control/children/child-execution-owner.js"
import { buildSessionChildLinkedFact, buildSessionChildUnlinkedFact, buildSessionCreatedFact, buildSessionOwnershipAdoptedFact, buildSessionRolesSnapshottedFact } from "../metadata/session-metadata-facts.js"
import { buildSessionMetadataAppend } from "../metadata/catalog/session-metadata-store.js"
import { ConversationTreeStorage } from "../conversation/tree/conversation-tree-storage.js"

export interface WorkflowCommitPublication {
  readonly workflowId: string
  readonly events: readonly GuardedEventStoreAppend[]
  /** A recovery successor may seed an explicit local choice once. Inherited run settings are never copied. */
  readonly localRoles?: RoleSettings
}
export interface WorkflowAdoption {
  readonly workflowId: string
  readonly launchedFrom: { readonly parentSessionId: string; readonly conversationId: string; readonly toolUseId: string }
}
interface WorkflowPublicationPorts {
  readonly projectRoot: string
  readonly reader: AsyncEventStateReadSurface
  readonly allocateId: () => string
  readonly read: (sessionId: string) => Promise<ReplayedSession | null>
  readonly blocksLaunch: (ownerId: string) => Promise<boolean>
  readonly append: (events: readonly GuardedEventStoreAppend[]) => Promise<GuardedAppendResult>
  readonly notifyChanged: (ids: readonly string[]) => void
}

/** Runs inside SessionManager's structural mutation authority. A winning attempt
 * commit creates its actual session, chat edge, and conversation in the same SQLite transaction. */
export function createWorkflowPublication(ports: WorkflowPublicationPorts) {
  const runOwner = workflowRunOwner()
  const runs = runOwner.create(ports.reader)
  const members = workflowMembershipReader(ports.reader)
  /** The member of an attempt: its own session, or for a reopened attempt
   *  that continues in its failed attempt's session, that session. */
  async function agentMember(workflowId: string, attemptId: string): Promise<WorkflowMember | null> {
    for (let id: string | null = attemptId; id !== null;) {
      const member = await members.attempt(workflowId, id)
      if (member) return member
      const attempt = await runs.readAttempt(workflowId, id)
      id = attempt?.provenance._tag === "continuation" && attempt.provenance.reason === "reopen" ? attempt.parentAttemptId : null
    }
    return null
  }
  async function commit(input: WorkflowCommitPublication): Promise<GuardedAppendResult> {
    const aggregateId = `workflow:${input.workflowId}`
    const facts = input.events.map((event) => {
      if (event.aggregateId !== aggregateId || event.sessionId !== input.workflowId) throw new Error("Workflow publication contains another owner's fact")
      return parseWorkflowSessionFact({ type: event.type, version: event.version, actor: event.actor, payload: event.payload })
    })
    const final = input.events.at(-1)
    const start = runOwner.startedAttempt(facts)
    const run = await runs.read(input.workflowId)
    if (!run) throw new Error(`Workflow not found: ${input.workflowId}`)
    const parentId = run.launchedFrom.parentSessionId
    const parentSeq = await ports.reader.aggregateSeq(`session:${parentId}`) + 1
    if ((await ports.blocksLaunch(input.workflowId) || await ports.blocksLaunch(parentId)) && !runOwner.settles(facts)) {
      throw new Error("Cannot start a workflow attempt while deletion is in progress")
    }
    const parent = await ports.read(parentId)
    if (parent?.kind !== "chat" || parent.conversationId !== run.launchedFrom.conversationId) {
      throw new Error("Workflow attempt requires its current launching chat conversation")
    }
    if (!start) return ports.append(input.events)
    // A restarted attempt, and a reopened agent, which continues in its
    // failed attempt's conversation, run in the session that holds it.
    if (await members.conversation(input.workflowId, start.conversationId)) return ports.append(input.events)
    if (await members.attempt(input.workflowId, start.attemptId)) throw new Error("A started attempt cannot change its member conversation")
    const attempt = await runs.readAttempt(input.workflowId, start.attemptId)
    const predecessor = attempt?.provenance._tag === "continuation" && attempt.parentAttemptId !== null ? await agentMember(input.workflowId, attempt.parentAttemptId) : null
    const previous = predecessor ? await ports.read(predecessor.sessionId) : null
    const localRoles = previous?.roleAssignments?.overrides ?? input.localRoles
    const sessionId = ports.allocateId()
    const now = new Date(final?.timestamp ?? Date.now()).toISOString()
    const session: Session = {
      kind: "workflow-agent", command: "workflow-agent",
      label: await runOwner.agentTitle(ports.reader, input.workflowId, start.attemptId) ?? start.attemptId, lastUpdated: now, createdAt: now, activatedAt: now, lifecycleState: "active",
      conversationId: start.conversationId,
      launchedFrom: run.launchedFrom,
      workflowMembership: { kind: "attempt", workflowId: input.workflowId, attemptId: start.attemptId },
    }
    const conversation = ConversationTreeStorage.prepareCreate({ conversationId: start.conversationId, sessionId, createdAt: now })
    const companions: GuardedEventStoreAppend[] = [
      { ...buildSessionMetadataAppend(sessionId, buildSessionCreatedFact(session), Date.parse(now)), expectedSeq: 0 },
      ...conversation,
      { ...buildSessionMetadataAppend(parentId, buildSessionChildLinkedFact(sessionId, now), Date.parse(now)), expectedSeq: parentSeq },
      ...(localRoles ? [buildSessionMetadataAppend(sessionId, buildSessionRolesSnapshottedFact({}, now, localRoles), Date.parse(now))] : []),
    ]
    const owner = prepareChildExecutionOwner(sessionId, ports.projectRoot, false)
    let result: GuardedAppendResult
    try {
      result = await ports.append([...input.events, ...companions])
    } catch (error) {
      owner.rollback()
      throw error
    }
    if (result.kind === "conflict") {
      owner.rollback()
      return result
    }
    ports.notifyChanged([sessionId, parentId])
    return { kind: "stored", events: result.events.filter((event) => event.aggregateId === aggregateId) }
  }

  async function adopt(input: WorkflowAdoption): Promise<boolean> {
    const aggregateId = `workflow:${input.workflowId}`
    const expectedSeq = await ports.reader.aggregateSeq(aggregateId) + 1
    const run = await runs.read(input.workflowId)
    if (!run) return false
    const previousParentId = run.launchedFrom.parentSessionId
    const nextParentId = input.launchedFrom.parentSessionId
    for (const id of [input.workflowId, previousParentId, nextParentId]) {
      if (await ports.blocksLaunch(id)) throw new Error("Cannot adopt a workflow while deletion is in progress")
    }
    const parentGuards = await Promise.all([...new Set([previousParentId, nextParentId])].map(async (id) =>
      ({ aggregateId: `session:${id}`, expectedSeq: await ports.reader.aggregateSeq(`session:${id}`) + 1 })))
    const parent = await ports.read(nextParentId)
    if (parent?.kind !== "chat" || parent.conversationId !== input.launchedFrom.conversationId) throw new Error("Workflow adoption requires a chat conversation")
    const now = new Date().toISOString()
    const appends: GuardedEventStoreAppend[] = [{
      aggregateId, sessionId: input.workflowId, timestamp: Date.parse(now), expectedSeq, aggregateGuards: parentGuards,
      ...runOwner.adoption(input.launchedFrom, now),
    }]
    const linked = await members.list(input.workflowId)
    for (const member of linked) {
      const memberSeq = await ports.reader.aggregateSeq(`session:${member.sessionId}`) + 1
      appends.push({ ...buildSessionMetadataAppend(member.sessionId, buildSessionOwnershipAdoptedFact(nextParentId, parent.conversationId, input.launchedFrom.toolUseId, now)), expectedSeq: memberSeq })
      if (previousParentId !== nextParentId) {
        appends.push(buildSessionMetadataAppend(previousParentId, buildSessionChildUnlinkedFact(member.sessionId, now)), buildSessionMetadataAppend(nextParentId, buildSessionChildLinkedFact(member.sessionId, now)))
      }
    }
    const result = await ports.append(appends)
    if (result.kind === "stored") ports.notifyChanged([previousParentId, nextParentId, ...linked.map(({ sessionId }) => sessionId)])
    return result.kind === "stored"
  }
  return { commit, adopt }
}
