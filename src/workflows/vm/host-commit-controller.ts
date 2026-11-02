import { DebugLog } from "../../infra/debug-log.js"
import { errorMessage } from "../../infra/error-message.js"
import type { StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { addressReachesAgent, type AddressedAddendum, type AddressedAgent, type RequestAddendumMessage } from "../context-bundle/context-facts.js"
import type { WorkflowView } from "../view/types.js"
import type { ResolvedAgent } from "../agent-resolution.js"
import type { WorkflowTransitionResult } from "./commands.js"
import { WorkflowCommitStorageError, createWorkflowCommitHost, type WorkflowCommitResult } from "./commit-host.js"
import { composeWorkflowCompanions, settledAttempt } from "./companions.js"
import type { NewWorkflowProposalEvent } from "./events.js"
import { lifecycleError } from "./host-failures.js"
import { WorkflowHostStorageError, type SettlingAttempt, type WorkflowVmHostDeps } from "./host-types.js"
import type { WorkflowRuntimePublisher } from "./host-publication.js"

const log = Log.create({ service: "workflow-vm-host" })

type Transition = {
  readonly event: NewWorkflowProposalEvent
  readonly result: WorkflowTransitionResult
}

interface CommitControllerDeps {
  readonly host: WorkflowVmHostDeps
  readonly resolvedAgents: ReadonlyMap<string, ResolvedAgent>
  readonly publisher: WorkflowRuntimePublisher
  readonly queue: () => Promise<WorkflowView>
  readonly applyStoredFacts: (events: readonly StoredFact[]) => Promise<void>
}

interface WorkflowHostCommitController {
  commit(transition: Transition): Promise<Transition & { readonly publication: WorkflowCommitResult["publication"] }>
}

export function createWorkflowHostCommitController(deps: CommitControllerDeps): WorkflowHostCommitController {
  const commitHost = createWorkflowCommitHost(deps.host)

  /** The parent messages that the attempt this commit settles read and that
   *  the workflow context does not hold yet. The context projection is the
   *  one record of what is recorded, so this filter is the only guard against
   *  a duplicate addendum when two settlements read one conversation, such
   *  as a failure that a run of encoding 7 or earlier paused on and the
   *  success of the Resume that followed it. */
  async function unrecordedAddenda(transition: Transition, held: Set<string>): Promise<{ readonly attempt: SettlingAttempt | null; readonly addenda: readonly RequestAddendumMessage[] }> {
    const settled = settledAttempt(transition.result)
    const conversationId = settled?.attempt.conversationId
    if (!settled || !conversationId) return { attempt: null, addenda: [] }
    const attempt = { attemptId: settled.attempt.id, conversationId }
    let read: readonly RequestAddendumMessage[]
    try {
      read = await deps.host.requestAddenda(attempt)
    } catch (error) {
      throw new WorkflowHostStorageError({ operation: "read_request_addenda", message: errorMessage(error) })
    }
    const addenda = read.filter(({ key }) => {
      if (held.has(key)) return false
      held.add(key)
      return true
    })
    return { attempt, addenda }
  }

  /** The held addressed messages and those of them that this commit
   *  records. A message is recorded from its address, never from a reading,
   *  so its key joins `held` first: the running agent that read it live
   *  records it only once, through its address. */
  async function heldAddressed(held: Set<string>): Promise<{ readonly messages: readonly AddressedAddendum[]; readonly record: readonly AddressedAddendum[] }> {
    if (!deps.host.addressedMessages) return { messages: [], record: [] }
    let messages: readonly AddressedAddendum[]
    try {
      messages = await deps.host.addressedMessages.read()
    } catch (error) {
      throw new WorkflowHostStorageError({ operation: "read_addressed_messages", message: errorMessage(error) })
    }
    const record = messages.filter(({ key }) => {
      if (held.has(key)) return false
      held.add(key)
      return true
    })
    return { messages, record }
  }

  async function retireAddressed(keys: readonly string[]): Promise<void> {
    if (keys.length === 0 || !deps.host.addressedMessages) return
    try {
      await deps.host.addressedMessages.retire(keys)
    } catch (error) {
      // A cell that stays is recorded already, so the next commit retires it.
      log.warn("addressed message cells were not retired", { sessionId: deps.host.sessionId, messages: keys.length, error: errorMessage(error) })
    }
  }

  async function commit(transition: Transition): Promise<Transition & { readonly publication: WorkflowCommitResult["publication"] }> {
    const held = new Set((await deps.host.contextStore.loadState())?.addenda.map(({ key }) => key))
    const addressed = await heldAddressed(held)
    const { attempt, addenda } = await unrecordedAddenda(transition, held)
    const before = await deps.queue()
    const composed = composeWorkflowCompanions(transition.result, {
      queue: before,
      resolvedAgents: deps.resolvedAgents,
      timestamp: (deps.host.now ?? Date.now)(),
      addenda,
      addressed: addressed.record,
    })
    if (composed.command.kind !== "commit") throw lifecycleError("commit", "Workflow commit command disappeared during companion composition")
    const proposal = composed.command.proposal
    const proposedCommitted = composed.state.context.pending?.proposedCommitted
    if (!proposedCommitted) throw lifecycleError("commit", "Workflow commit command has no proposed control")

    let result: WorkflowCommitResult
    try {
      result = await commitHost.commitOrReplay({
        snapshot: composed.state,
        event: transition.event,
        proposal,
        applyStoredFacts: deps.applyStoredFacts,
        onCommitted: async (stored) => {
          await deps.publisher.publishCommittedBatch(stored, proposedCommitted)
        },
      })
    } catch (error) {
      if (error instanceof WorkflowCommitStorageError) {
        throw new WorkflowHostStorageError({ operation: "commit", message: error.message })
      }
      throw error
    }

    if (attempt && result.publication === "committed") {
      for (const addendum of addenda) recordAddendum(deps.host.sessionId, attempt, addendum)
    }
    if (result.publication === "committed") {
      for (const message of addressed.record) recordAddressedMessage(deps.host.sessionId, message)
      if (addressed.messages.length > 0) await retireAddressed(addressedKeysToRetire(addressed.messages, before, await deps.queue()))
    }
    const { publication, ...continued } = result
    return { event: transition.event, result: continued, publication }
  }

  return { commit }
}

/** One record of an addendum that this host committed: its ids and its byte
 *  counts, never its text. */
function recordAddendum(sessionId: string, attempt: SettlingAttempt, addendum: RequestAddendumMessage): void {
  DebugLog.record({
    type: "workflow.request_addendum.recorded",
    sessionId,
    payload: {
      key: addendum.key,
      attemptId: attempt.attemptId,
      conversationId: attempt.conversationId,
      textBytes: Buffer.byteLength(addendum.text),
      ...(addendum.personWords === undefined ? {} : { personWordsBytes: Buffer.byteLength(addendum.personWords) }),
      ...(addendum.attachmentCount === undefined ? {} : { attachmentCount: addendum.attachmentCount }),
    },
  })
}

/** One record of an addressed message that this host committed: its ids,
 *  its address count, and its byte count, never its text. */
function recordAddressedMessage(sessionId: string, message: AddressedAddendum): void {
  DebugLog.record({
    type: "workflow.addressed_message.recorded",
    sessionId,
    payload: { key: message.key, source: message.source.kind, addresses: message.addressedTo.length, textBytes: Buffer.byteLength(message.text) },
  })
}

/** One agent whose attempt started and has not finished. */
export interface StartedAgent {
  readonly agent: AddressedAgent
  readonly attemptId: string
  readonly conversationId: string
}

/** The agents that run now or that an interrupt parked, in tree order:
 *  each agent whose current attempt holds a conversation and has not
 *  settled. Several run at once in a phase of several agents. Empty between
 *  agents, when every agent is only ready, and after the run. */
export function startedAgents(view: Pick<WorkflowView, "tree" | "attempts"> | null | undefined): readonly StartedAgent[] {
  if (view == null) return []
  const attempts = new Map(view.attempts.map((attempt) => [attempt.id, attempt]))
  return view.tree.nodes.flatMap((agent): StartedAgent[] => {
    if (agent.kind !== "agent" || agent.currentAttemptId === undefined) return []
    if (agent.disposition === "completed" || agent.disposition === "failed" || agent.disposition === "skipped") return []
    const attempt = attempts.get(agent.currentAttemptId)
    if (attempt?.lastConversationId === undefined || (attempt.status !== "running" && attempt.status !== "pending")) return []
    return [{ agent, attemptId: attempt.id, conversationId: attempt.lastConversationId }]
  })
}

/** The agents that run or wait both before and after a commit, each in the
 *  same attempt: agents whose prompts the commit did not build. An agent
 *  that was only ready before the commit starts in it, so the commit builds
 *  its prompt. */
function continuingAgents(before: WorkflowView, after: WorkflowView): readonly AddressedAgent[] {
  const prior = new Set(startedAgents(before).map(({ attemptId }) => attemptId))
  return startedAgents(after).flatMap(({ agent, attemptId }) => prior.has(attemptId) ? [agent] : [])
}

/** The held addressed messages whose cells a published commit retires: all
 *  of them, once recorded, except a message for an agent that runs or waits
 *  in the same attempt before and after the commit. That agent's prompt was
 *  built before the record, so it reads the message in its conversation:
 *  live at once, or when it resumes in a later run, which adopts the cell.
 *  The commit that settles or replaces that attempt retires the cell. An
 *  agent that a commit starts reads the record in its prompt. */
export function addressedKeysToRetire(messages: readonly AddressedAddendum[], before: WorkflowView, after: WorkflowView): readonly string[] {
  const agents = continuingAgents(before, after)
  return messages.flatMap(({ key, addressedTo }) => agents.some((agent) => addressReachesAgent(addressedTo, agent)) ? [] : [key])
}
