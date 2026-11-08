import type { TurnParkState } from "../../infra/agent-loop-events.js"
import type { ChatInput } from "../../infra/chat-input.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { ConversationTreeWriterController } from "../chat/tree-writer.js"
import type { HeldBackgroundNotification } from "../session/conversation/queued-background-notifications.js"
import { heldAtWakeLimit, type DeliveryOutcome } from "../session/live-session-control.js"
import { WorkflowInjectionQueue } from "./injection-queue.js"
import { createHeldCellClaims, type HeldCellClaims } from "../session/conversation/queued-user-inputs.js"
import { consumeWorkflowRecoveryInputs } from "./recovery-input.js"
import { readHeldAddressedMessages, WHOLE_WORKFLOW, type HeldAddressedMessage, type WorkflowDeliveryAddress } from "../session/conversation/addressed-workflow-messages.js"
import type { ChatTurnEnd, TurnInterruption } from "../session/conversation/turn-end-record.js"
import { automaticWake, type WorkflowWake } from "./runner-types.js"
import { conversationHoldsEntries } from "../session/conversation/session-message-entries.js"
import { addressReachesAgent } from "../../workflows/context-bundle/context-facts.js"
import { loadQueueSnapshotFromReader } from "../../workflows/view/view-store.js"
import { startedAgents, type StartedAgent } from "../../workflows/vm/host-commit-controller.js"
import { workflowInterruptRefusal } from "./workflow-addressing.js"
import { interruptRank, strongestInterrupt } from "../session/child-continuation.js"

/** The attempt of one agent that runs, which a held message's address
 *  reaches or not. */
interface AgentAttempt {
  readonly attemptId: string
  readonly conversationId: string
}

/** The input of one agent that runs: its own queue, which its loop drains,
 *  and how its loop parked. */
export interface WorkflowAgentInput {
  /** Initializes once, before context mutation; undefined evidence is explicitly uncut. */
  initialize(agent: StartedAgent["agent"] | undefined, end: ChatTurnEnd | undefined, timestamp?: number): void
  readonly cut: AttemptInterrupt | undefined
  interrupt(by: TurnInterruption, timestamp?: number): boolean
  /** Authorizes only this member after an agent/runtime cut. Person and replacement cuts keep their owner. */
  resumeFromParent(): boolean
  /** A person's admitted private message releases only this member's cut. The message supplies the wake. */
  resumeFromPerson(): boolean
  /** One generation-opening action, without replaying a restored cut after Resume. */
  takeOpeningInterrupt(): AttemptInterrupt | undefined
  /** The cut's actor remains available to an unwinding turn until its Resume is emitted. */
  interruptionToRecord(): TurnInterruption
  /** The agent's own input queue. No other agent reads it. */
  readonly queue: WorkflowInjectionQueue
  /** Called once by the agent at its start: commits the held cells into its
   *  conversation, and from then on the agent takes live messages. The agent
   *  also takes each held message whose address reaches it and that its
   *  conversation does not hold, as its first live input: a resumed agent's
   *  prompt predates such a message, and a message held while the agent
   *  started missed its prompt. True when the agent must rebuild its
   *  context. */
  adopt(treeWriter: ConversationTreeWriterController): Promise<boolean>
  /** The agent's loop parked as its `TurnParkedContext.park` states. */
  parked(state: TurnParkState): void
  /** The agent's loop left its park. */
  resumed(): void
  /** Called once by the agent when it ends, after its writes are durable:
   *  the cells it took and did not read wait for the next agent. */
  release(): void
}

/** The one consumer of the messages a workflow accepts, and of the notices
 *  other sessions hold for it, such as its returned messages. Each is
 *  durable in a workflow-target cell before it arrives here. Several agents
 *  can run at the same time, and each one has its own input
 *  (`WorkflowAgentInput`). A message whose address reaches an agent that runs
 *  goes into that agent's queue, so a message to the whole workflow reaches
 *  every agent that runs. A message or notice that waits for one reader, such
 *  as a message from another session or a returned message, goes to one agent
 *  only. With no agent running, the cell waits, and the next agent adopts it
 *  into its conversation when it starts. An agent that ends leaves the cells
 *  it did not read, so the next agent adopts them, and no agent reads a cell
 *  twice. */
export interface WorkflowAgentInputs {
  /** The park state of one admitted attempt, including its effective interrupt. */
  stateOf(attemptId: string): WorkflowAgentInputs["state"] | "handing_off"
  interrupt(address: WorkflowDeliveryAddress, by: TurnInterruption): boolean
  evidence(attemptId: string): { readonly cut: AttemptInterrupt | undefined } | undefined
  effective(agent: StartedAgent["agent"]): AttemptInterrupt | undefined
  reached(address: WorkflowDeliveryAddress): readonly string[]
  stateAt(address: WorkflowDeliveryAddress): WorkflowAgentInputs["state"]
  hasPending(address: WorkflowDeliveryAddress): boolean
  pendingCut(address: WorkflowDeliveryAddress): AttemptInterrupt | undefined
  pendingControl(): "person" | "agent" | undefined
  /** Opens the input of the agent that runs `attempt`. */
  open(attempt: AgentAttempt): WorkflowAgentInput
  /** Hands the held messages that `include` admits to the agents that run:
   *  each recovery-retained input to one agent, and to each agent every held
   *  message whose address reaches it and that its conversation does not
   *  hold, in the order they were held. The count of messages handed. */
  handOver(retained: readonly ChatInput[], include: (message: ChatInput) => boolean, outcome: DeliveryOutcome, address?: WorkflowDeliveryAddress): Promise<number>
  /** Hands one held message, with the outcome its delivery decided, to each
   *  agent that runs and that `address` reaches, or to one agent that runs
   *  when the message has no address. Its cell key rides in `dispatchIds`.
   *  With no such agent, the cell waits for the next one. The attempts that
   *  took it. */
  deliver(input: ChatInput, outcome: DeliveryOutcome, address?: WorkflowDeliveryAddress): readonly string[]
  /** Hands one held notice to one agent that runs. False with no agent
   *  running: the cell waits for the next one. */
  notify(notification: HeldBackgroundNotification): boolean
  /** A person's Resume, or the parent's hand-back, of the agents an
   *  interrupt parked: each agent that has not parked for another reason
   *  takes it as its authorizing input. The attempts that took it. */
  resume(address?: WorkflowDeliveryAddress): readonly string[]
  /** A capacity wake of the agents of `conversationIds` while the workflow
   *  runs (PI-MODEL-039): each one that the runtime or a replacement cut
   *  takes it as its authorizing input, as a capacity wake's start does, and
   *  every cut by a person or the parent agent stays. The conversations
   *  that continue now, including an agent that runs. */
  continueCapacity(conversationIds: ReadonlySet<string>): ReadonlySet<string>
  /** Asks each agent that runs to compact its conversation. False with no
   *  agent running. */
  compact(): boolean
  /** Takes back the latest message of the person, while no agent that it
   *  reached has read it, once `confirm` agrees for the attempts it
   *  reached. */
  recallLastUserMessage(confirm: (attemptIds: readonly string[]) => boolean): ChatInput | null
  /** What a message meets now: no agent takes it (`between_steps`), the turn
   *  of an agent that runs reads it, or the agents' loops are parked. An
   *  interrupted agent wins, because a message hands it back. */
  readonly state: "between_steps" | "running" | TurnParkState
}

interface Slot {
  readonly attempt: AgentAttempt
  readonly queue: WorkflowInjectionQueue
  /** The cells this agent took that wait for one reader. */
  readonly sole: Set<string>
  /** The addressed cells this agent took. */
  readonly addressed: HeldCellClaims
  /** The agent's node, known once its adoption reads the queue. */
  agent: StartedAgent["agent"] | undefined
  /** How the agent's loop parked, undefined while its turn runs. */
  park: TurnParkState | undefined
  initialized: boolean
  cut: AttemptInterrupt | undefined
  opening: boolean
  announcement: AttemptInterrupt | undefined
}

interface AttemptInterrupt {
  readonly by: TurnInterruption
  readonly timestamp: number
}

const whole = (address: WorkflowDeliveryAddress): boolean => address.addressedTo.some(({ _tag }) => _tag === "workflow")
const reaches = (address: WorkflowDeliveryAddress, agent: StartedAgent["agent"] | undefined): boolean => whole(address) || (agent !== undefined && addressReachesAgent(address.addressedTo, agent))

/** The order in which a parked state wins the state of the whole workflow. */
const STATE_RANK = { running: 0, waiting_on_work: 1, interrupted: 2, idle: 3 } as const

export function createWorkflowAgentInputs(input: {
  readonly store: AsyncEventStateReadSurface
  readonly sessionId: string
  readonly wake?: WorkflowWake
  readonly restore?: boolean
  readonly onChange?: () => void
  readonly runningAgents?: () => readonly StartedAgent["agent"][]
}): WorkflowAgentInputs {
  // The open agents in the order they started. A cell for one reader goes to
  // the first.
  const slots = new Map<string, Slot>()
  const closed = new Map<string, { readonly cut: AttemptInterrupt | undefined }>()
  type RunningAgent = StartedAgent["agent"]
  const pending: { agent: RunningAgent | undefined; cut: AttemptInterrupt }[] = []
  const runningAgents = () => input.runningAgents?.() ?? [...slots.values()].flatMap(({ agent }) => agent ? [agent] : [])
  function expandWaitingCoverage(): void {
    const agents = runningAgents()
    if (agents.length === 0) return
    const expanded = pending.flatMap((entry) => entry.agent === undefined ? agents.map((agent) => ({ agent, cut: entry.cut })) : [entry])
    pending.splice(0, pending.length, ...expanded)
  }
  function pendingAt(agent: StartedAgent["agent"] | undefined): AttemptInterrupt | undefined {
    return strongestInterrupt(pending.filter((entry) => entry.agent === undefined || entry.agent.id === agent?.id).map(({ cut }) => cut))
  }
  const effective = (slot: Slot) => strongestInterrupt([slot.cut, pendingAt(slot.agent)])
  const selected = (address: WorkflowDeliveryAddress) => [...slots.values()].filter(({ agent, queue }) => !queue.isHandingOff && reaches(address, agent))
  function pendingFor(address: WorkflowDeliveryAddress): AttemptInterrupt | undefined {
    return strongestInterrupt(pending.filter((entry) => entry.agent === undefined || reaches(address, entry.agent)).map(({ cut }) => cut))
  }
  function release(released: (agent: RunningAgent | undefined) => boolean): void {
    expandWaitingCoverage()
    const kept = pending.filter((entry) => !released(entry.agent))
    pending.splice(0, pending.length, ...kept)
  }
  function authorize(slot: Slot, address?: WorkflowDeliveryAddress): void {
    slot.announcement = effective(slot)
    const own = slot.agent
    if (address) release((agent) => reaches(address, agent))
    else if (own) release((agent) => agent !== undefined && agent.id === own.id)
    else release((agent) => reaches(WHOLE_WORKFLOW, agent))
    slot.cut = undefined
    slot.opening = false
    input.onChange?.()
  }
  function stateAt(address: WorkflowDeliveryAddress): WorkflowAgentInputs["state"] {
    let state: WorkflowAgentInputs["state"] = "between_steps"
    for (const slot of selected(address)) {
      const own = effective(slot) !== undefined ? "interrupted" : slot.park ?? "running"
      if (state === "between_steps" || STATE_RANK[own] < STATE_RANK[state]) state = own
    }
    if (state === "between_steps" && pendingFor(address) !== undefined) return "interrupted"
    return state
  }
  // The cells for one reader that an agent took, by key: a recovery's
  // retained input, a message from another session, or a returned message.
  // The agent that took one owns it until it ends.
  const soleOwners = new Map<string, string>()
  // The person's messages that agents took live, latest last, with the agents
  // that took each.
  const personMessages: { readonly key: string; readonly input: ChatInput; readonly attemptIds: readonly string[] }[] = []

  function claimSole(slot: Slot, key: string): boolean {
    if (soleOwners.has(key)) return false
    soleOwners.set(key, slot.attempt.attemptId)
    slot.sole.add(key)
    return true
  }

  function firstSlot(): Slot | undefined {
    return [...slots.values()].find(({ queue }) => !queue.isHandingOff)
  }

  /** The held messages whose address reaches the agent's node and that its
   *  conversation does not hold. A commit retires a recorded cell unless
   *  its agent continues in the same attempt (`addressedKeysToRetire`), so an
   *  agent that a commit started finds only a message held after its prompt
   *  was built. */
  async function unreadAddressed(slot: Slot): Promise<{ message: ChatInput; addressedTo: HeldAddressedMessage["addressedTo"] }[]> {
    if (slot.agent === undefined) return []
    const agent = slot.agent
    const held = await readHeldAddressedMessages(input.store, input.sessionId)
    const reaching = held.filter(({ addressedTo }) => addressReachesAgent(addressedTo, agent))
    if (reaching.length === 0) return []
    const read = await conversationHoldsEntries(input.store, slot.attempt.conversationId, reaching.map(({ input: message }) => message.key))
    return reaching.flatMap(({ input: { key, origin: _origin, ...message }, addressedTo }) => read.has(key) ? [] : [{ message: { ...message, dispatchIds: [key] }, addressedTo }])
  }

  function enqueue(slot: Slot, message: ChatInput, outcome: DeliveryOutcome): void {
    slot.queue.enqueueMessage(message, { held: heldAtWakeLimit(outcome) })
  }

  function rememberPersonMessage(message: ChatInput, taken: readonly Slot[]): readonly string[] {
    const attemptIds = taken.map(({ attempt }) => attempt.attemptId)
    const key = message.dispatchIds?.[0]
    if (message.producer?.kind !== "session" && key !== undefined && taken.length > 0) personMessages.push({ key, input: message, attemptIds })
    return attemptIds
  }

  function deliverAddressed(message: ChatInput, outcome: DeliveryOutcome, address: WorkflowDeliveryAddress): readonly Slot[] {
    const taken = selected(address).filter((slot) => slot.agent !== undefined && slot.addressed.claimMessage(message))
    for (const slot of taken) enqueue(slot, message, outcome)
    return taken
  }

  function deliverSole(message: ChatInput, outcome: DeliveryOutcome): readonly Slot[] {
    const slot = firstSlot()
    const keys = message.dispatchIds ?? []
    if (slot === undefined || keys.some((key) => soleOwners.has(key))) return []
    for (const key of keys) claimSole(slot, key)
    enqueue(slot, message, outcome)
    return [slot]
  }

  return {
    stateOf(attemptId) {
      const slot = slots.get(attemptId)
      if (!slot) return "running"
      if (slot.queue.isHandingOff) return "handing_off"
      return effective(slot) !== undefined ? "interrupted" : slot.park ?? "running"
    },
    interrupt(address, by) {
      const agents = runningAgents()
      if (workflowInterruptRefusal(address, agents) !== undefined) return false
      expandWaitingCoverage()
      // A pending cut waits for an agent that no slot holds yet. An agent that
      // hands off can no longer be cut, and nothing would consume its entry.
      const handingOff = new Set([...slots.values()].flatMap(({ agent, queue }) => agent && queue.isHandingOff ? [agent.id] : []))
      const coverage: (RunningAgent | undefined)[] = agents.length === 0 ? [undefined] : agents.filter((agent) => reaches(address, agent) && !handingOff.has(agent.id))
      const uncovered = coverage.filter((agent) => !pending.some((entry) => interruptRank(entry.cut.by) <= interruptRank(by) && (entry.agent === undefined || entry.agent.id === agent?.id)))
      if (uncovered.length === 0) return false
      const cut = { by, timestamp: Date.now() }
      pending.push(...uncovered.map((agent) => ({ agent, cut })))
      input.onChange?.()
      return true
    },
    evidence(attemptId) {
      const slot = slots.get(attemptId)
      return slot?.initialized ? { cut: effective(slot) } : closed.get(attemptId)
    },
    effective: (agent) => pendingAt(agent),
    hasPending: (address) => pendingFor(address) !== undefined,
    pendingCut: pendingFor,
    pendingControl() {
      const cut = pendingFor(WHOLE_WORKFLOW)
      return cut?.by === "person" || cut?.by === "agent" ? cut.by : undefined
    },
    reached: (address) => selected(address).map(({ attempt }) => attempt.attemptId),
    stateAt,
    open(attempt) {
      const slot: Slot = { attempt, queue: new WorkflowInjectionQueue(), sole: new Set(), addressed: createHeldCellClaims(), agent: undefined, park: undefined, initialized: false, cut: undefined, opening: true, announcement: undefined }
      slots.set(attempt.attemptId, slot)
      return {
        initialize(agent, end, timestamp = Date.now()) {
          if (slot.initialized) return
          slot.agent = agent
          slot.initialized = true
          const actor = end?.end.reason === "paused" ? end.end.pausedBy : undefined
          const wake = input.wake ?? WHOLE_WORKFLOW
          const kept = actor === "person" || actor === "agent"
            ? automaticWake(wake) || !reaches(wake, agent)
            : actor !== undefined && typeof wake === "object" && "capacity" in wake && !wake.capacity.has(attempt.conversationId)
          if (input.restore !== false && actor !== undefined && kept) slot.cut = { by: actor, timestamp }
          input.onChange?.()
        },
        get cut() { return effective(slot) },
        resumeFromPerson() {
          if (slot.queue.isHandingOff) return false
          if (!slot.agent || !effective(slot)) return false
          authorize(slot)
          return true
        },
        resumeFromParent() {
          if (slot.queue.isHandingOff) return false
          const cut = effective(slot)
          if (!slot.agent || !cut || cut.by === "person" || cut.by === "replacement") return false
          authorize(slot)
          slot.queue.enqueueResume()
          input.onChange?.()
          return true
        },
        interruptionToRecord: () => effective(slot)?.by ?? slot.announcement?.by ?? "person",
        interrupt(by, timestamp = Date.now()) {
          if (slot.queue.isHandingOff) return false
          const prior = effective(slot)
          if (prior !== undefined && interruptRank(prior.by) <= interruptRank(by)) return false
          slot.cut = { by, timestamp }
          slot.opening = true
          input.onChange?.()
          return true
        },
        takeOpeningInterrupt() {
          if (!slot.opening) return undefined
          const cut = effective(slot)
          if (cut) slot.opening = false
          return cut
        },
        queue: slot.queue,
        async adopt(treeWriter) {
          const refresh = await consumeWorkflowRecoveryInputs(input.store, input.sessionId, treeWriter, (key) => claimSole(slot, key))
          // The node is known before the held cells are read, so a message
          // held after this read reaches the agent live.
          const queue = await loadQueueSnapshotFromReader(input.store, input.sessionId)
          slot.agent = startedAgents(queue).find(({ attemptId }) => attemptId === attempt.attemptId)?.agent
          for (const { message } of await unreadAddressed(slot)) {
            if (slot.addressed.claimMessage(message)) slot.queue.enqueueMessage(message)
          }
          return refresh
        },
        parked(state) { slot.park = state; input.onChange?.() },
        resumed() { slot.park = undefined; slot.announcement = undefined; input.onChange?.() },
        release() {
          if (slots.get(attempt.attemptId) !== slot) return
          if (slot.initialized) closed.set(attempt.attemptId, { cut: effective(slot) })
          slots.delete(attempt.attemptId)
          input.onChange?.()
          for (const key of slot.sole) soleOwners.delete(key)
          for (let index = personMessages.length - 1; index >= 0; index -= 1) {
            if (personMessages[index]?.attemptIds.every((attemptId) => !slots.has(attemptId))) personMessages.splice(index, 1)
          }
        },
      }
    },
    async handOver(retained, include, outcome, address = WHOLE_WORKFLOW) {
      let handed = 0
      for (const message of retained) {
        if (whole(address) && include(message) && deliverSole(message, outcome).length > 0) {
          const slot = firstSlot()
          if (slot) authorize(slot)
          handed += 1
        }
      }
      for (const slot of selected(address)) {
        for (const { message, addressedTo } of await unreadAddressed(slot)) {
          if (!include(message) || !slot.addressed.claimMessage(message)) continue
          enqueue(slot, message, outcome)
          authorize(slot, whole(address) ? { addressedTo, label: "the message's agents" } : address)
          handed += 1
        }
      }
      return handed
    },
    deliver(message, outcome, address) {
      return rememberPersonMessage(message, address === undefined ? deliverSole(message, outcome) : deliverAddressed(message, outcome, address))
    },
    notify({ text, key }) {
      const slot = firstSlot()
      if (slot === undefined) return false
      if (key === undefined) slot.queue.enqueue(text, { silent: true })
      else if (claimSole(slot, key)) slot.queue.enqueueAcceptedNotice(text, key)
      return true
    },
    resume(address = WHOLE_WORKFLOW) {
      const taken = selected(address).filter((slot) => effective(slot) !== undefined)
      for (const slot of taken) slot.announcement = effective(slot)
      release((agent) => reaches(address, agent))
      for (const slot of taken) { slot.cut = undefined; slot.opening = false }
      for (const slot of taken) slot.queue.enqueueResume()
      input.onChange?.()
      return taken.map(({ attempt }) => attempt.attemptId)
    },
    continueCapacity(conversationIds) {
      const continued = new Set<string>()
      for (const slot of slots.values()) {
        const { conversationId } = slot.attempt
        if (!conversationIds.has(conversationId) || !slot.initialized || slot.queue.isHandingOff) continue
        const cut = effective(slot)
        if (cut?.by === "person" || cut?.by === "agent") continue
        if (cut !== undefined) {
          authorize(slot)
          slot.queue.enqueueResume()
        }
        continued.add(conversationId)
      }
      return continued
    },
    compact() {
      const readers = [...slots.values()].filter(({ queue }) => !queue.isHandingOff)
      if (readers.length === 0) return false
      for (const slot of readers) slot.queue.enqueueCompact()
      return true
    },
    recallLastUserMessage(confirm) {
      const latest = personMessages.at(-1)
      if (latest === undefined) return null
      const holders = latest.attemptIds.flatMap((attemptId) => slots.get(attemptId) ?? [])
      if (holders.length === 0 || !holders.every(({ queue }) => queue.holdsMessage(latest.key))) return null
      if (!confirm(latest.attemptIds)) return null
      personMessages.pop()
      for (const { queue } of holders) queue.takeMessage(latest.key)
      return latest.input
    },
    get state() { return stateAt(WHOLE_WORKFLOW) },
  }
}
