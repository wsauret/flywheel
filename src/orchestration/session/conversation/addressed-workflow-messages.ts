import { Schema } from "effect"
import type { AsyncEventStateReadSurface, AsyncEventWriter, InFlightRecord } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import type { ChatInput } from "../../../infra/chat-input.js"
import { coalesceRepeats } from "../../../infra/repeat-coalescer.js"
import { currentAddresses, HeldMessageAddressesSchema, type AddressedAddendum, type WorkflowMessageAddress } from "../../../workflows/context-bundle/context-facts.js"
import { loadQueueSnapshotFromReader } from "../../../workflows/view/view-store.js"
import { startedAgents } from "../../../workflows/vm/host-commit-controller.js"
import { decodeHeldInput, queuedInputPayload, readUnreadMessages, type QueuedUserInput, type QueuedUserInputCell } from "./queued-user-inputs.js"
import { conversationHoldsEntries } from "./session-message-entries.js"

/** The in-flight kind that holds every message to a workflow, with its
 *  address: the whole workflow for a message without `targets`, or the items
 *  and agents that its targets name. It is a kind of its own, not a queued
 *  user input, so no agent adopts it as the next agent's input: only its
 *  address decides who reads it. A build that does not know the kind leaves
 *  the cell in place, so the message waits for a build that records it and
 *  is never delivered to the wrong item.
 *
 *  The cell stores the input in the form that every held-input family
 *  writes, with its sender's provenance, and the address beside it. The
 *  workflow's next commit records it as a context record, which every agent
 *  in the address reads when it starts, and the agent that runs or waits in
 *  the address reads the input itself in its conversation. */
export const ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND = "workflow.addressed_message"

/** Where one message to a workflow goes: the whole workflow, or the items
 *  and agents that its sender named in `targets`, resolved against the
 *  workflow's tree when it was sent. */
export interface WorkflowDeliveryAddress {
  readonly addressedTo: readonly [WorkflowMessageAddress, ...WorkflowMessageAddress[]]
  /** The address in a person's words, such as `item json`. */
  readonly label: string
}

/** The address of a message to a workflow without `targets`: every agent
 *  that runs now and every agent that starts later, on any item. */
export const WHOLE_WORKFLOW: WorkflowDeliveryAddress = { addressedTo: [{ _tag: "workflow" }], label: "the workflow" }

/** One held addressed message: the input as its sender sent it, under its
 *  delivery key, and its address. */
export interface HeldAddressedMessage {
  readonly input: QueuedUserInput
  readonly addressedTo: readonly [WorkflowMessageAddress, ...WorkflowMessageAddress[]]
  /** The stored bytes of the cell. */
  readonly raw: string
}

const log = Log.create({ service: "addressed-workflow-messages" })

/** A cell that does not decode stays in place and is read again on every
 *  commit, so its warning records once per window with a count. */
const unreadable = coalesceRepeats<{ readonly sessionId: string; readonly key: string }>({
  windowMs: 60_000,
  first: (_key, cell) => log.warn("unreadable addressed workflow message kept in place", cell),
  repeated: (_key, repeats) => log.warn("unreadable addressed workflow message kept in place", { ...repeats.events[0], repeats: repeats.count, windowMs: repeats.windowMs }),
})

const decodeAddresses = Schema.decodeUnknownOption(HeldMessageAddressesSchema, { onExcessProperty: "error" })

/** Holds one addressed message durably under `key` before any agent reads
 *  it. False when the store cannot hold in-flight state, so the caller
 *  refuses the message instead of losing it. */
export async function holdAddressedWorkflowMessage(writer: AsyncEventWriter, sessionId: string, key: string, input: ChatInput, address: WorkflowDeliveryAddress): Promise<boolean> {
  if (!writer.putInFlight) return false
  await writer.putInFlight(sessionId, ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND, key, addressedWorkflowMessagePayload(input, address))
  return true
}

/** The stored form of one addressed message: the held input and its address. */
export function addressedWorkflowMessagePayload(input: ChatInput, address: WorkflowDeliveryAddress) {
  return { ...queuedInputPayload(input), addressedTo: address.addressedTo }
}

function decodeHeld(row: InFlightRecord): HeldAddressedMessage | undefined {
  const input = decodeHeldInput(row)
  const addressedTo = decodeAddresses(row.payload.addressedTo)
  if ("unreadable" in input || addressedTo._tag === "None" || input.text.length === 0) return undefined
  return { input, addressedTo: currentAddresses(addressedTo.value), raw: row.raw }
}

/** The addressed messages that a workflow holds, in the order they were
 *  held. A cell that does not decode stays in place with a warning: it is
 *  never recorded, never read, and never discarded. */
export async function readHeldAddressedMessages(reader: AsyncEventStateReadSurface, sessionId: string): Promise<HeldAddressedMessage[]> {
  const messages: HeldAddressedMessage[] = []
  for (const row of await reader.readInFlight(sessionId, ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND)) {
    const message = decodeHeld(row)
    if (message) messages.push(message)
    else unreadable.observe(`${sessionId}\0${row.key}`, { sessionId, key: row.key })
  }
  return messages
}

/** The context record of one held message: its sender, its words, the
 *  person's words that a session sender read, and its address. Only the
 *  workflow's parent and a person send to a workflow. */
function addressedAddendum({ input, addressedTo }: HeldAddressedMessage): AddressedAddendum {
  const producer = input.producer?.kind === "session" ? input.producer : undefined
  const personWords = producer?.envelope?.personWords
  const attachments = input.attachments?.length ?? 0
  return {
    key: input.key,
    source: producer ? { kind: "parent", name: producer.envelope?.name || producer.sessionId } : { kind: "person" },
    text: input.text,
    ...(personWords ? { personWords } : {}),
    ...(attachments > 0 ? { attachmentCount: attachments } : {}),
    addressedTo,
  }
}

/** The context records of the addressed messages that a workflow holds,
 *  for its next commit to record. */
export async function readAddressedWorkflowMessages(reader: AsyncEventStateReadSurface, sessionId: string): Promise<AddressedAddendum[]> {
  return (await readHeldAddressedMessages(reader, sessionId)).map(addressedAddendum)
}

/** The held messages to a workflow that no agent read yet. A cell stays held
 *  after its record only for an agent that runs or waits in the same
 *  attempt, so the agents that can have read a held message live are the
 *  agents that run now or that an interrupt parked: a message that one of
 *  their conversations holds is read. Every later agent reads the record of
 *  a retired cell. */
async function readUnreadWorkflowMessages(reader: AsyncEventStateReadSurface, sessionId: string): Promise<QueuedUserInputCell[]> {
  const held = await readHeldAddressedMessages(reader, sessionId)
  if (held.length === 0) return []
  const keys = held.map(({ input }) => input.key)
  const read = new Set<string>()
  for (const started of startedAgents(await loadQueueSnapshotFromReader(reader, sessionId))) {
    for (const key of await conversationHoldsEntries(reader, started.conversationId, keys)) read.add(key)
  }
  return held.flatMap(({ input, raw }) => read.has(input.key) ? [] : [{ ...input, raw, target: "workflow" as const, workflowId: sessionId }])
}

/** Every message that a session accepted and no reader read: its held
 *  queued inputs, and for a workflow, each held message to it that no agent
 *  read. Reply waits and the return of unread messages read this. */
export async function readUnreadSessionMessages(reader: AsyncEventStateReadSurface, sessionId: string): Promise<QueuedUserInputCell[]> {
  return [...await readUnreadMessages(reader, sessionId), ...await readUnreadWorkflowMessages(reader, sessionId)]
}

/** Retires the cells of messages that a workflow commit recorded, that a
 *  refused delivery takes back, or that a person recalled. */
export async function retireAddressedWorkflowMessages(writer: AsyncEventWriter, sessionId: string, keys: readonly string[]): Promise<void> {
  for (const key of keys) await writer.dropInFlight?.(sessionId, ADDRESSED_WORKFLOW_MESSAGE_IN_FLIGHT_KIND, key)
}
