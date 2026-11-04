import { isDeepStrictEqual } from "node:util"

import type { AsyncEventStateReadSurface, GuardedAppendResult, GuardedEventStoreAppend } from "../../infra/event-store-types.js"
import { parseWorkflowSessionFact } from "../../workflows/vm/session-facts.js"
import { workflowRunOwner } from "../module-catalog.js"
import { workflowMembershipReader } from "./workflow-membership.js"
import type { ReplayedSession, RoleSettings, Session } from "./schemas.js"
import { prepareChildExecutionOwner } from "./child-execution-resources.js"
import { buildSessionChildLinkedFact, buildSessionChildUnlinkedFact, buildSessionCreatedFact, buildSessionOwnershipAdoptedFact, buildSessionRolesSnapshottedFact } from "./session-metadata-facts.js"
import { buildSessionMetadataAppend } from "./session-metadata-store.js"
import { ConversationTreeStorage } from "./conversation/conversation-tree-storage.js"
import { tryOpenConversationTree } from "./conversation/conversation-tree-handle.js"
import { createConversationMessageEntries } from "./conversation/conversation-tree.js"
import { persistedToConversationMessage } from "./conversation/conversation-tree-context.js"
import { briefEntryId } from "./conversation/brief-entry.js"

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
    const currentMember = await members.attempt(input.workflowId, start.attemptId)
    if (currentMember) {
      if (currentMember.conversationId !== start.conversationId) throw new Error("A started attempt cannot change its member conversation")
      return ports.append(input.events)
    }
    const attempt = await runs.readAttempt(input.workflowId, start.attemptId)
    const predecessorAttemptId = attempt?.provenance._tag === "continuation" ? attempt.parentAttemptId : null
    const predecessor = predecessorAttemptId === null ? null : await members.attempt(input.workflowId, predecessorAttemptId)
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
    const source = attempt?.provenance._tag === "continuation" ? attempt.provenance.sourceConversationId : null
    const tree = source && predecessor ? await tryOpenConversationTree({
      conversationId: source, sessionId: predecessor.sessionId, store: ports.reader,
    }) : null
    let entries: Awaited<ReturnType<typeof createConversationMessageEntries>> = []
    if (tree && predecessorAttemptId !== null) {
      try {
        const context = await tree.buildContext({ allowAssistantTail: true })
        // The copy keeps the brief under the successor's brief entry id, so
        // the successor holds its brief once and the agent view shows it.
        // Context messages carry no entry id: the brief is the message equal
        // to the predecessor's brief entry. A predecessor whose compaction
        // dropped its brief copies none, and the successor restates it.
        const brief = await tree.getEntry(briefEntryId(predecessorAttemptId))
        const briefMessage = brief?.kind === "message" ? persistedToConversationMessage(brief.message) : undefined
        const briefIndex = briefMessage === undefined ? -1 : context.messages.findIndex((message) => isDeepStrictEqual(message, briefMessage))
        let index = 0
        entries = await createConversationMessageEntries(context.messages, null,
          () => index++ === briefIndex ? briefEntryId(start.attemptId) : crypto.randomUUID(), () => now)
      } finally { tree.getStorage().dispose() }
    }
    const conversation = entries.length > 0
      ? ConversationTreeStorage.prepareCreateWithEntries({ conversationId: start.conversationId, sessionId, createdAt: now, entries })
      : ConversationTreeStorage.prepareCreate({ conversationId: start.conversationId, sessionId, createdAt: now })
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
