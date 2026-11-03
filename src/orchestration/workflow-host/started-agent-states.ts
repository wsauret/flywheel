import { CorruptEventRowError, type AsyncEventStateReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"
import type { WorkflowAgentLive } from "../../protocol/workflow-view-protocol-types.js"
import type { StartedAgent } from "../../workflows/vm/host-commit-controller.js"
import { readChatTurnEndEvidence, readStartedWorkflowAgents, workflowAgentTurnEnd, type WorkflowAgentTurnEnd } from "../session/chat-session-run-evidence.js"
import { entryLink } from "../session/conversation/conversation-entry-admission.js"
import { holdsForPerson } from "../session/conversation/turn-end-record.js"
import { admitTreeFact, CHAT_TREE_FACT_TYPES, newConversationTopology, type ConversationTopology, type ConversationTreeProjectionState } from "../session/conversation/conversation-projection.js"
import { onReplyWaitsChanged } from "../session/reply-waits.js"

/** The durable live state of one started workflow agent: when an interrupt
 *  parked it, and the operations its conversation holds. Both derive only
 *  from the facts of `conversation:<conversationId>`. Operations are absent
 *  when the read left them out because a running attempt counts them on its
 *  live entry. Its newest call and its tail exist only while it runs. */
export type ConversationLive = Pick<WorkflowAgentLive, "interruptedAt"> & { readonly operations?: number }

/** The started agents of a workflow, and the durable live state of the
 *  conversations of some of them. */
export interface StartedAgentsLive {
  readonly started: (workflowId: string) => Promise<readonly StartedAgent[]>
  /** The live state of each named conversation of a started agent.
   *  `countsOperations` names the conversations whose operations the read
   *  must count, because no live entry counts them. */
  readonly conversations: (workflowId: string, conversationIds: readonly string[], countsOperations: (conversationId: string) => boolean) => Promise<ReadonlyMap<string, ConversationLive>>
}

type TurnEndEvidence = Awaited<ReturnType<typeof readChatTurnEndEvidence>>

/** The tool calls that a conversation holds on every branch: the tool_use
 *  blocks of its accepted assistant messages. A running attempt seeds its
 *  live count with them, and a parked agent's count folds the same accepted
 *  entries through `admitTreeFact`, so both counts come from one rule. */
export function conversationToolUseIds(state: Pick<ConversationTreeProjectionState, "entriesById">): string[] {
  return Object.values(state.entriesById).flatMap((entry) => entryLink(entry).toolUseIds ?? [])
}

/** The distinct tool calls of the entries that a conversation accepted at or
 *  below `position`, with the topology that decides the admission of the
 *  entries after it. The size of `ids` is the conversation's operation
 *  count. */
interface ToolUseFold {
  readonly topology: ConversationTopology
  readonly ids: Set<string>
  position: number
  /** The advance in progress. The next advance starts after it, so each
   *  row applies once and in position order. */
  advancing: Promise<unknown>
}

const newToolUseFold = (): ToolUseFold => ({ topology: newConversationTopology(), ids: new Set(), position: 0, advancing: Promise.resolve() })

/** Advances `fold` by the rows after its position and returns the operation
 *  count. Each advance reads only the rows after the fold, so a held fold
 *  costs one page per change, never the whole history. A failed advance
 *  leaves the fold at the last row it applied, so the next advance resumes
 *  there. */
function advanceToolUses(reader: AsyncEventStateReadSurface, conversationId: string, fold: ToolUseFold): Promise<number> {
  const run = fold.advancing.catch(() => {}).then(() => readToolUses(reader, conversationId, fold))
  fold.advancing = run
  return run
}

async function readToolUses(reader: AsyncEventStateReadSurface, conversationId: string, fold: ToolUseFold): Promise<number> {
  const query = { aggregateId: `conversation:${conversationId}`, types: CHAT_TREE_FACT_TYPES }
  let upper: number | undefined
  while (true) {
    // Eager content: the tree accepts a batch only when its referenced tool
    // text verifies, so the page resolves the references of its new rows.
    // The text is dropped with the page; the fold keeps links and ids.
    const page = await reader.readPage(query, upper, fold.position, true)
    upper = page.upperPosition
    for (const row of page.facts) {
      for (const { toolUseIds } of admitTreeFact(fold.topology, row, page.toolContent)) for (const id of toolUseIds ?? []) fold.ids.add(id)
      fold.position = row instanceof CorruptEventRowError ? row.row.position : row.position
    }
    if (page.continuationPosition === null) break
    fold.position = page.continuationPosition
  }
  fold.position = upper
  return fold.ids.size
}

/** An agent reads as interrupted only while an interrupt holds it for a
 *  person, as its workflow card reads; an unexpected exit is not an
 *  interrupt. */
function liveOf(evidence: TurnEndEvidence, operations: number | undefined): ConversationLive {
  return {
    ...(operations === undefined ? {} : { operations }),
    ...(evidence?.turnEnd.end.reason === "paused" && holdsForPerson(evidence.turnEnd) && evidence.timestamp !== undefined ? { interruptedAt: evidence.timestamp } : {}),
  }
}

/** The live state of each conversation, from the evidence and the
 *  operations that `evidenceOf` and `operationsOf` give for it. */
async function conversationsLive(
  conversationIds: readonly string[],
  countsOperations: (conversationId: string) => boolean,
  evidenceOf: (conversationId: string) => Promise<TurnEndEvidence>,
  operationsOf: (conversationId: string) => Promise<number>,
): Promise<ReadonlyMap<string, ConversationLive>> {
  return new Map(await Promise.all(conversationIds.map(async (conversationId) => {
    const [evidence, operations] = await Promise.all([
      evidenceOf(conversationId),
      countsOperations(conversationId) ? operationsOf(conversationId) : undefined,
    ])
    return [conversationId, liveOf(evidence, operations)] as const
  })))
}

/** Reads the live state of started agents once, for a reader that holds
 *  nothing between reads: the tail of each conversation, which is bounded,
 *  and all its tool calls only when `countsOperations` asks. */
export function readStartedAgentsLive(reader: AsyncEventStateReadSurface): StartedAgentsLive {
  return {
    started: (workflowId) => readStartedWorkflowAgents(reader, workflowId),
    conversations: (_workflowId, conversationIds, countsOperations) => conversationsLive(conversationIds, countsOperations,
      (conversationId) => readChatTurnEndEvidence(reader, conversationId),
      (conversationId) => advanceToolUses(reader, conversationId, newToolUseFold())),
  }
}

/** What one started agent's conversation last read, or nothing while a
 *  change since that read can have moved it. A read in progress is held as
 *  its promise, so readers that meet it share it, and a change during it
 *  clears it so that the next reader reads again. */
interface HeldConversation {
  evidence?: Promise<TurnEndEvidence>
  /** The waiter whose open reply waits decided `evidence` (`waitsOf`). */
  waitsOf?: string
  operations?: Promise<number>
  /** The tool calls that `operations` counts. A change clears `operations`
   *  but keeps the fold, so the next count reads only the new entries. */
  readonly toolUses: ToolUseFold
}

/** One change of a workflow's started agents: the list before it and the
 *  list after it, as `started` returned them, with the agents that started
 *  and the agents that settled. An attempt that moved to a new
 *  conversation settles in the old one and starts in the new one. */
export interface StartedAgentsChange {
  readonly before: readonly StartedAgent[]
  readonly after: readonly StartedAgent[]
  readonly started: readonly StartedAgent[]
  readonly settled: readonly StartedAgent[]
}

interface HeldWorkflow {
  /** The newest read of the started set, absent while a workflow commit
   *  since it can have started or settled an agent. Reads take increasing
   *  order numbers. */
  started?: { readonly order: number; readonly agents: Promise<readonly StartedAgent[]> }
  /** The started set that `conversations` holds an entry for each agent
   *  of, the conversation of each of its attempts, and the order number of
   *  the read that gave it. */
  synced: readonly StartedAgent[]
  attempts: ReadonlyMap<string, string>
  syncedOrder: number
  readonly conversations: Map<string, HeldConversation>
}

/** The one owner of the durable state of each read workflow's unfinished
 *  started agents. The held workflow detail reads their turn ends and the
 *  live view reads their parks and operations from it.
 *
 *  A read costs only what changed since the last read: a commit of
 *  `workflow:<id>` reads the started set again from the held queue, which
 *  advances by the facts after its last read, and `onStarted` tells each
 *  consumer the agents that started and settled, so a consumer applies
 *  only those; an entry that one agent's conversation appended reads that
 *  conversation again; and a change of the
 *  reply waits that decided one agent's turn end reads that agent again.
 *  Nothing else is read, so one change costs the same whatever the number of
 *  agents (AGENTS.md section 7, hot-path rules 2 and 3). `onChange` names the
 *  workflows whose agents an entry or a wait moved, and the conversations of
 *  those agents, so a consumer reads only them again. A consumer that reads
 *  a workflow commit learns of it from its own fact listener; this owner
 *  subscribes before any consumer reads, so its marks are set before a
 *  consumer's read that a commit scheduled. */
export interface StartedAgentStates extends StartedAgentsLive {
  readonly turnEnds: (workflowId: string) => Promise<readonly WorkflowAgentTurnEnd[]>
  onChange(listener: (workflowIds: ReadonlySet<string>, conversationIds: ReadonlySet<string>) => void): () => void
  /** Tells `listener` each change of the started set of a read workflow,
   *  in order, once the read after a commit of `workflow:<id>` finds it.
   *  `started` returns the list after the newest change it told. */
  onStarted(listener: (workflowId: string, change: StartedAgentsChange) => void): () => void
  /** Settles once the reads that commits started have finished. */
  settled(): Promise<void>
  dispose(): void
}

const WORKFLOW_PREFIX = "workflow:"
const CONVERSATION_PREFIX = "conversation:"

export function createStartedAgentStates(deps: {
  readonly reader: AsyncEventStateReadSurface
  readonly onStored: (listener: (facts: readonly StoredFact[]) => void) => () => void
}): StartedAgentStates {
  const held = new Map<string, HeldWorkflow>()
  /** The workflow of each held conversation. */
  const workflowOf = new Map<string, string>()
  /** The held conversations whose turn ends each waiter's reply waits decided. */
  const decidedByWaits = new Map<string, Set<string>>()
  const listeners = new Set<(workflowIds: ReadonlySet<string>, conversationIds: ReadonlySet<string>) => void>()
  const startedListeners = new Set<(workflowId: string, change: StartedAgentsChange) => void>()
  /** The reads of started sets that commits started and nothing awaits. */
  const advancing = new Set<Promise<void>>()
  let startedReads = 0
  /** Counts the changes of reply waits. A turn-end read takes the count
   *  when it starts, so it can tell whether the waits that decided it
   *  changed while it ran, before it registered to hear of them. */
  let waitChanges = 0
  let evidenceReads = 0
  /** The count at each waiter's newest change of its waits. It holds
   *  entries only while a turn-end read runs, so it stays small. */
  const waitsChangedAt = new Map<string, number>()

  const forgetWaits = (conversationId: string, conversation: HeldConversation) => {
    if (conversation.waitsOf === undefined) return
    const conversations = decidedByWaits.get(conversation.waitsOf)
    conversations?.delete(conversationId)
    if (conversations?.size === 0) decidedByWaits.delete(conversation.waitsOf)
    conversation.waitsOf = undefined
  }
  /** Clears what a change of `conversationId` can move and returns its workflow. */
  const invalidate = (conversationId: string, operations: boolean): string | undefined => {
    const workflowId = workflowOf.get(conversationId)
    const conversation = workflowId === undefined ? undefined : held.get(workflowId)?.conversations.get(conversationId)
    if (!conversation) return undefined
    forgetWaits(conversationId, conversation)
    conversation.evidence = undefined
    if (operations) conversation.operations = undefined
    return workflowId
  }
  /** Collects the conversations that moved, with their workflows, and tells the listeners once. */
  const changes = () => {
    const workflowIds = new Set<string>()
    const conversationIds = new Set<string>()
    return {
      add(workflowId: string, conversationId: string) { workflowIds.add(workflowId); conversationIds.add(conversationId) },
      tell() { if (workflowIds.size > 0) for (const listener of listeners) listener(workflowIds, conversationIds) },
    }
  }
  const offFacts = deps.onStored((facts) => {
    const moved = changes()
    const committed = new Set<string>()
    for (const { aggregateId, type } of facts) {
      if (aggregateId.startsWith(WORKFLOW_PREFIX)) {
        const workflowId = aggregateId.slice(WORKFLOW_PREFIX.length)
        const workflow = held.get(workflowId)
        if (!workflow) continue
        workflow.started = undefined
        committed.add(workflowId)
        continue
      }
      if (type !== "chat.entries.appended" || !aggregateId.startsWith(CONVERSATION_PREFIX)) continue
      const conversationId = aggregateId.slice(CONVERSATION_PREFIX.length)
      const workflowId = invalidate(conversationId, true)
      if (workflowId !== undefined) moved.add(workflowId, conversationId)
    }
    moved.tell()
    for (const workflowId of committed) advance(workflowId)
  })
  // Reply-wait cells change outside any append, so the turn ends that they
  // decided hear of them here.
  const offWaits = onReplyWaitsChanged(deps.reader, (waiterSessionId) => {
    waitChanges++
    if (evidenceReads > 0) waitsChangedAt.set(waiterSessionId, waitChanges)
    const moved = changes()
    for (const conversationId of decidedByWaits.get(waiterSessionId) ?? []) {
      const workflowId = invalidate(conversationId, false)
      if (workflowId !== undefined) moved.add(workflowId, conversationId)
    }
    moved.tell()
  })

  /** Holds `pending` until a change clears it. A failed read is not held,
   *  so the next reader reads again. */
  const hold = <T>(pending: Promise<T>, current: () => Promise<T> | undefined, clear: () => void): Promise<T> => {
    pending.catch(() => { if (current() === pending) clear() })
    return pending
  }
  /** Holds `after`, the started set that a read found, and tells the
   *  agents that started and settled since the set it held. One pass over
   *  the set finds them, as the queue view that gave the set costs; the
   *  held conversations and the consumers then change only by them. */
  const sync = (workflowId: string, owner: HeldWorkflow, after: readonly StartedAgent[], order: number) => {
    const before = owner.synced
    const attempts = new Map(after.map(({ attemptId, conversationId }) => [attemptId, conversationId]))
    const started = after.filter(({ attemptId, conversationId }) => owner.attempts.get(attemptId) !== conversationId)
    const settled = before.filter(({ attemptId, conversationId }) => attempts.get(attemptId) !== conversationId)
    owner.syncedOrder = order
    // A commit that moved no agent keeps the held list, so the `before` of
    // the next change told is the `after` of the last one told.
    if (started.length === 0 && settled.length === 0) return
    owner.synced = after
    owner.attempts = attempts
    for (const { conversationId } of settled) {
      const conversation = owner.conversations.get(conversationId)
      if (conversation) forgetWaits(conversationId, conversation)
      owner.conversations.delete(conversationId)
      workflowOf.delete(conversationId)
    }
    for (const { conversationId } of started) {
      owner.conversations.set(conversationId, { toolUses: newToolUseFold() })
      workflowOf.set(conversationId, workflowId)
    }
    for (const listener of startedListeners) listener(workflowId, { before, after, started, settled })
  }
  /** The workflow's started agents, each with a held conversation. The
   *  started set is read again only after a commit can have moved it, and
   *  a read that a newer read overtook never replaces the newer set. */
  const startedOf = async (workflowId: string): Promise<{ readonly workflow: HeldWorkflow; readonly started: readonly StartedAgent[] }> => {
    let workflow = held.get(workflowId)
    if (!workflow) held.set(workflowId, workflow = { synced: [], attempts: new Map(), syncedOrder: 0, conversations: new Map() })
    const owner = workflow
    if (!owner.started) {
      const agents = readStartedWorkflowAgents(deps.reader, workflowId)
      owner.started = { order: ++startedReads, agents }
      hold(agents, () => owner.started?.agents, () => { owner.started = undefined })
    }
    const read = owner.started
    const started = await read.agents
    if (read.order > owner.syncedOrder) sync(workflowId, owner, started, read.order)
    return { workflow: owner, started: owner.synced }
  }
  const log = Log.create({ service: "started-agent-states" })
  /** Reads the started set of a workflow that a commit moved, so that each
   *  consumer hears what started and settled without reading it. */
  const advance = (workflowId: string) => {
    const run = startedOf(workflowId).then(() => {}, (error: unknown) => recordBackgroundFailure(log, "read started workflow agents", { workflowId }, error))
    advancing.add(run)
    void run.finally(() => advancing.delete(run))
  }
  const evidenceOf = (workflowId: string, workflow: HeldWorkflow, conversationId: string): Promise<TurnEndEvidence> => {
    const conversation = workflow.conversations.get(conversationId)
    if (!conversation) return readChatTurnEndEvidence(deps.reader, conversationId)
    if (conversation.evidence) return conversation.evidence
    const since = waitChanges
    evidenceReads++
    const pending: Promise<TurnEndEvidence> = readChatTurnEndEvidence(deps.reader, conversationId).then((evidence) => {
      // A change during the read cleared the slot or replaced the agent; the
      // read that follows it decides which waits to hear of.
      if (evidence?.waitsOf === undefined || conversation.evidence !== pending || workflow.conversations.get(conversationId) !== conversation) return evidence
      if ((waitsChangedAt.get(evidence.waitsOf) ?? 0) > since) {
        // The waits changed after the read took them, before it could hear
        // of the change, so this evidence can be stale: the next reader
        // reads again, and the consumers hear that it moved.
        conversation.evidence = undefined
        const moved = changes()
        moved.add(workflowId, conversationId)
        moved.tell()
        return evidence
      }
      conversation.waitsOf = evidence.waitsOf
      let conversations = decidedByWaits.get(evidence.waitsOf)
      if (!conversations) decidedByWaits.set(evidence.waitsOf, conversations = new Set())
      conversations.add(conversationId)
      return evidence
    }).finally(() => { if (--evidenceReads === 0) waitsChangedAt.clear() })
    conversation.evidence = hold(pending, () => conversation.evidence, () => { conversation.evidence = undefined })
    return pending
  }
  const operationsOf = (workflow: HeldWorkflow, conversationId: string): Promise<number> => {
    const conversation = workflow.conversations.get(conversationId)
    if (!conversation) return advanceToolUses(deps.reader, conversationId, newToolUseFold())
    conversation.operations ??= hold(advanceToolUses(deps.reader, conversationId, conversation.toolUses), () => conversation.operations, () => { conversation.operations = undefined })
    return conversation.operations
  }

  return {
    async turnEnds(workflowId) {
      const { workflow, started } = await startedOf(workflowId)
      return await Promise.all(started.map(async (agent) => workflowAgentTurnEnd(agent, await evidenceOf(workflowId, workflow, agent.conversationId))))
    },
    started: async (workflowId) => (await startedOf(workflowId)).started,
    async conversations(workflowId, conversationIds, countsOperations) {
      const { workflow } = await startedOf(workflowId)
      return await conversationsLive(conversationIds, countsOperations,
        (conversationId) => evidenceOf(workflowId, workflow, conversationId),
        (conversationId) => operationsOf(workflow, conversationId))
    },
    onChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    onStarted(listener) {
      startedListeners.add(listener)
      return () => { startedListeners.delete(listener) }
    },
    async settled() { while (advancing.size > 0) await Promise.all(advancing) },
    dispose() { offFacts(); offWaits(); listeners.clear(); startedListeners.clear(); held.clear(); workflowOf.clear(); decidedByWaits.clear() },
  }
}
