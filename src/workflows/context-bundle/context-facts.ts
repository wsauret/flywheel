import { Schema } from "effect"
import { defineFact, factDescriptors } from "../../infra/event-registry.js"
import { ArtifactContractSchema } from "../artifact-contracts.js"
import type { WorkflowInputValue } from "../output-contract/compile.js"

const ContextInputSeededFactSchema = defineFact({
  type: "context.input.seeded",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    workflowDefinitionId: Schema.NonEmptyString,
    userRequest: Schema.String,
  }),
})

// v2: the launch also passed structured input, which the workflow's input
// contract decoded. Version 1 is a launch with the text request only, so a
// launch without input keeps the version 1 bytes, and a version 1 fact
// written before input existed reads as such a launch.
const StructuredContextInputSeededFactSchema = defineFact({
  type: "context.input.seeded",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    workflowDefinitionId: Schema.NonEmptyString,
    userRequest: Schema.String,
    input: Schema.Record(Schema.String, Schema.Json),
  }),
})

const InheritedContextInputSeededFactSchema = defineFact({
  type: "context.input.seeded",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    workflowDefinitionId: Schema.NonEmptyString,
    userRequest: Schema.String,
    input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
    inheritedIntent: Schema.NonEmptyString,
  }),
})

const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const NonEmpty = Schema.NonEmptyString

/** One handoff entry of the context: an attempt's handoff, whose `entryId`
 *  is the attempt id, or a join's output, whose `entryId` is
 *  `<list node id>:join` (refer to `joinEntryId`). `definitionId` is the
 *  record that wrote it: the agent record, or the list phase of a join. */
export const HandoffEntrySchema = Schema.Struct({
  entryId: Schema.String,
  agentName: Schema.String,
  definitionId: NonEmpty,
  workflowDefinitionId: NonEmpty,
  /** Attempt this entry is addressed to, or null when it is the ordinary
   *  prior context for whichever attempt runs next. Current writers set
   *  null. Only a stored blocked attempt from a build before the blocked
   *  retirement addresses its blocker report, to the attempt that reassesses
   *  the stopped work; that reader is removed after 2027-04-03. */
  recipientAttemptId: Schema.NullOr(Schema.String),
  writes: Schema.mutable(Schema.Array(ArtifactContractSchema)),
  timestamp: Schema.Number,
  handoff: Schema.Record(Schema.String, Schema.Unknown),
})
export type HandoffEntry = typeof HandoffEntrySchema.Type

/** One request addendum: a message that an agent of the workflow read from
 *  its parent session. Every later attempt reads it after the original
 *  request. `key` is the id of the user entry that delivered the message,
 *  so a replayed delivery keeps the same key. `source` is a tagged object so
 *  that a later source kind is an additive change. The message bytes of
 *  attachments are not carried; only their count is recorded. `readBy`
 *  names the attempt that read it. */
export const RequestAddendumSchema = Schema.Struct({
  key: NonEmpty,
  source: Schema.Struct({ kind: Schema.Literal("parent"), name: NonEmpty }),
  text: NonEmpty,
  personWords: Schema.optionalKey(NonEmpty),
  attachmentCount: Schema.optionalKey(PositiveInt),
  readBy: Schema.Struct({
    attemptId: NonEmpty,
    agentName: NonEmpty,
    conversationId: NonEmpty,
  }),
})
export type RequestAddendum = typeof RequestAddendumSchema.Type

/** A parent message as the agent that read it holds it, before the host
 *  commit names the reading attempt: an addendum without `readBy`. */
export type RequestAddendumMessage = Omit<typeof RequestAddendumSchema.Encoded, "readBy">

/** The list-local scope of a record that an agent produced inside one item
 *  of a list: its handoff, or, in a run that an earlier build recorded, a
 *  parent reply that the item read. It stays visible only to its own item
 *  until the list's join settles. `key` is the item key, the stable
 *  identity that orders promoted records. A record without a scope is
 *  workflow scope. */
const ItemScopeSchema = Schema.TaggedStruct("item", {
  listNodeId: NonEmpty,
  itemNodeId: NonEmpty,
  key: NonEmpty,
})
export type ItemScope = typeof ItemScopeSchema.Type

/** The context view one attempt reads. A workflow-scope recipient with a
 *  frozen bundle reads, of the attempt and join entries that a run records,
 *  only those that its bundle names: the entries of the nodes that complete
 *  before its node can start. It reads every other entry, such as inherited
 *  predecessor evidence, first in recorded order, then its bundle in bundle
 *  order. Without a bundle it reads every workflow-scope entry in recorded
 *  order: the whole-workflow view, and the view of an attempt that a serial
 *  build started. An item recipient reads the shared entries that its list
 *  froze at admission and the records of its own item. It reads the shared
 *  entries in bundle order when `bundleOrder` is set, else in recorded
 *  order, as a serial build did. Every recipient reads every live
 *  workflow-scope message and the messages addressed to it. */
export const RecipientScopeSchema = Schema.Union([
  Schema.TaggedStruct("workflow", {
    sharedEntryIds: Schema.optionalKey(Schema.Array(NonEmpty)),
  }),
  Schema.Struct({
    ...ItemScopeSchema.fields,
    sharedEntryIds: Schema.Array(NonEmpty),
    bundleOrder: Schema.optionalKey(Schema.Literal(true)),
  }),
])
export type RecipientScope = typeof RecipientScopeSchema.Type

/** The part of a workflow that a message is for: the whole workflow, which
 *  a message without `targets` names, or what its `targets` name: one item
 *  of a list, with the item scope that an item record carries, or one
 *  agent, by its node and its agent record. */
const AddressSchema = Schema.Union([
  Schema.TaggedStruct("workflow", {}),
  ItemScopeSchema,
  Schema.TaggedStruct("agent", { nodeId: NonEmpty, definitionId: NonEmpty }),
])
export type WorkflowMessageAddress = typeof AddressSchema.Type

/** The addresses of one message, which a recorded fact carries. */
const MessageAddressesSchema = Schema.NonEmptyArray(AddressSchema)

/** The parts of an agent of the workflow tree that an address names: its
 *  tree id, the control node that runs it when that differs, and its item. */
export interface AddressedAgent {
  readonly id: string
  readonly nodeId?: string
  readonly item?: { readonly nodeId: string }
}

/** Whether a message with `addressedTo` is for `agent`: the message is for
 *  the whole workflow, or the agent works on an item that it names, or it
 *  is the agent that it names. */
export function addressReachesAgent(addressedTo: readonly WorkflowMessageAddress[], agent: AddressedAgent): boolean {
  return addressedTo.some((address) => address._tag === "workflow"
    || (address._tag === "item" ? agent.item?.nodeId === address.itemNodeId : (agent.nodeId ?? agent.id) === address.nodeId))
}

/** One message to the workflow, with its address: the whole workflow for a
 *  message without `targets`, from the parent agent or from a person's
 *  composer at the workflow level, or the items or agents that the
 *  parent's `targets` or a person's agent view name. It is recorded from
 *  its address, not from a reading, so it carries no `readBy`: an agent
 *  that has not started reads it when it starts. `key` is the delivery key
 *  of the message, so the running agent that also read it live records
 *  nothing more. */
export const AddressedAddendumSchema = Schema.Struct({
  key: NonEmpty,
  source: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("parent"), name: NonEmpty }),
    Schema.Struct({ kind: Schema.Literal("person") }),
  ]),
  text: NonEmpty,
  personWords: Schema.optionalKey(NonEmpty),
  attachmentCount: Schema.optionalKey(PositiveInt),
  addressedTo: MessageAddressesSchema,
})
export type AddressedAddendum = typeof AddressedAddendumSchema.Type

// The stored shapes that builds before the agent lexicon recorded: `stepId` held
// an attempt id, or an agent record key in a retired `step` address, `stepName` the
// agent's name, and a `branch` scope named the list as `groupNodeId` and
// the item as `branchNodeId`. `context.accumulated` versions 4 and 5 and
// `step_context.input.added` versions 1 to 3 hold them, and so does a held
// addressed message that such a build wrote. Readers convert each to its
// current shape. Remove after 2027-04-30.
const BranchScopeV1Schema = Schema.TaggedStruct("branch", {
  groupNodeId: NonEmpty,
  branchNodeId: NonEmpty,
  key: NonEmpty,
})
const HandoffEntryV1Schema = Schema.Struct({
  stepId: Schema.String, // stored key of version 1
  stepName: Schema.String, // stored key of version 1
  definitionId: NonEmpty,
  workflowDefinitionId: NonEmpty,
  recipientStepId: Schema.NullOr(Schema.String),
  writes: Schema.mutable(Schema.Array(ArtifactContractSchema)),
  timestamp: Schema.Number,
  handoff: Schema.Record(Schema.String, Schema.Unknown),
})
const RequestAddendumV1Schema = Schema.Struct({
  ...RequestAddendumSchema.fields,
  readBy: Schema.Struct({ stepId: NonEmpty, stepName: NonEmpty, conversationId: NonEmpty }), // stored keys of version 1
})
const AddressV1Schema = Schema.Union([
  Schema.TaggedStruct("workflow", {}),
  BranchScopeV1Schema,
  Schema.TaggedStruct("step", { nodeId: NonEmpty, stepId: NonEmpty }), // stored kind and key of version 1
])
const AddressedAddendumV1Schema = Schema.Struct({
  ...AddressedAddendumSchema.fields,
  addressedTo: Schema.NonEmptyArray(AddressV1Schema),
})

function itemScopeFromBranch(scope: typeof BranchScopeV1Schema.Type): ItemScope {
  return { _tag: "item", listNodeId: scope.groupNodeId, itemNodeId: scope.branchNodeId, key: scope.key }
}

function currentAddress(address: typeof AddressV1Schema.Type | WorkflowMessageAddress): WorkflowMessageAddress {
  switch (address._tag) {
    case "branch": return itemScopeFromBranch(address)
    case "step": return { _tag: "agent", nodeId: address.nodeId, definitionId: address.stepId } // stored kind and key of version 1
    default: return address
  }
}

/** The addresses that a held addressed message stores. A cell that a build
 *  before the agent lexicon held names a retired `branch` or `step`; it decodes
 *  to the current address. Remove the retired arms after 2027-04-30. */
export const HeldMessageAddressesSchema = Schema.NonEmptyArray(Schema.Union([AddressSchema, AddressV1Schema]))

export function currentAddresses(addresses: typeof HeldMessageAddressesSchema.Type): readonly [WorkflowMessageAddress, ...WorkflowMessageAddress[]] {
  const [first, ...rest] = addresses
  return [currentAddress(first), ...rest.map(currentAddress)]
}

const ContextInputAddedV1FactSchema = defineFact({
  type: "step_context.input.added",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: RequestAddendumV1Schema,
})

// v2: a parent reply that an item attempt read without a person's words.
// It is list-local until the join. Version 1 is workflow scope. No writer
// writes version 2 since messages record from their address (v3), so only
// runs that an earlier build recorded hold it, and every reader folds it as
// that build did.
const ContextInputAddedV2FactSchema = defineFact({
  type: "step_context.input.added",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ ...RequestAddendumV1Schema.fields, scope: BranchScopeV1Schema }),
})

// v3: a message to the workflow with its address.
const ContextInputAddedV3FactSchema = defineFact({
  type: "step_context.input.added",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: AddressedAddendumV1Schema,
})

// v4: a message that an agent read (`readBy`), or a message to the workflow
// with its address (`addressedTo`), each in the agent lexicon. Each is its
// own kind of record.
const ContextInputAddedFactSchema = defineFact({
  type: "step_context.input.added",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Union([RequestAddendumSchema, AddressedAddendumSchema]),
})

// v3: accumulated entries carry canonical artifact contracts. The artifact
// index is derived by the context projection and is not a second fact stream.
// v4: entries carry the attempt they are addressed to. Current writers set
// null; only a stored blocked attempt's blocker report names its reassessment,
// and that reader is removed after 2027-04-03.
const ContextAccumulatedV4FactSchema = defineFact({
  type: "context.accumulated",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ entry: HandoffEntryV1Schema }),
})

// v5: the handoff entry of an item attempt, with its item scope.
const ContextAccumulatedV5FactSchema = defineFact({
  type: "context.accumulated",
  version: 5,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ entry: HandoffEntryV1Schema, scope: BranchScopeV1Schema }),
})

// v6: the handoff entry in the agent lexicon. An entry of an item attempt
// carries its item scope; an entry without one is workflow scope.
const ContextAccumulatedFactSchema = defineFact({
  type: "context.accumulated",
  version: 6,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ entry: HandoffEntrySchema, scope: Schema.optionalKey(ItemScopeSchema) }),
})

export const WorkflowContextFactSchemas = [
  ContextInputSeededFactSchema,
  StructuredContextInputSeededFactSchema,
  InheritedContextInputSeededFactSchema,
  ContextAccumulatedV4FactSchema,
  ContextAccumulatedV5FactSchema,
  ContextAccumulatedFactSchema,
  ContextInputAddedV1FactSchema,
  ContextInputAddedV2FactSchema,
  ContextInputAddedV3FactSchema,
  ContextInputAddedFactSchema,
] as const

/** The type of every workflow context fact. The projection and recovery read
 *  this one list, so a new context fact reaches both. */
export const WORKFLOW_CONTEXT_FACT_TYPES: readonly string[] = factDescriptors(WorkflowContextFactSchemas).map(({ type }) => type)

const WorkflowContextFactSchema = Schema.Union(WorkflowContextFactSchemas)
/** A workflow context fact as it is stored, at any version. */
export type WorkflowContextFact = typeof WorkflowContextFactSchema.Type

/** Retains the launch request and approved checkpoint snapshot once for all agents.
 * Launches without inherited intent retain the version 1 or 2 shape. */
export function buildContextInputSeededFact(
  workflowDefinitionId: string,
  userRequest: string,
  input: WorkflowInputValue | null = null,
  inheritedIntent?: string,
): Extract<WorkflowContextFact, { type: "context.input.seeded" }> {
  const fact = parseWorkflowContextFact(inheritedIntent !== undefined
    ? { type: "context.input.seeded", version: 3, actor: "flywheel", payload: { workflowDefinitionId, userRequest, ...(input === null ? {} : { input }), inheritedIntent } }
    : input === null
    ? { type: "context.input.seeded", version: 1, actor: "flywheel", payload: { workflowDefinitionId, userRequest } }
    : { type: "context.input.seeded", version: 2, actor: "flywheel", payload: { workflowDefinitionId, userRequest, input } })
  if (fact.type !== "context.input.seeded") throw new Error("Context input fact parser returned the wrong type")
  return fact
}

type ContextInputAddedFact = Extract<WorkflowContextFact, { type: "step_context.input.added" }>
type ContextAccumulatedFact = Extract<WorkflowContextFact, { type: "context.accumulated" }>

/** The fact of one message that an agent read, or of one addressed
 *  message. */
export function buildContextInputAddedFact(addendum: typeof RequestAddendumSchema.Encoded | typeof AddressedAddendumSchema.Encoded): Extract<ContextInputAddedFact, { version: 4 }> {
  const fact = parseWorkflowContextFact({ type: "step_context.input.added", version: 4, actor: "flywheel", payload: addendum })
  if (fact.type !== "step_context.input.added" || fact.version !== 4) throw new Error("Context input fact parser returned the wrong type")
  return fact
}

/** The fact of one handoff entry, with the item scope of an entry of an
 *  item attempt. */
export function buildContextAccumulatedFact(entry: HandoffEntry, scope: ItemScope | null = null): Extract<ContextAccumulatedFact, { version: 6 }> {
  const fact = parseWorkflowContextFact({ type: "context.accumulated", version: 6, actor: "flywheel", payload: scope === null ? { entry } : { entry, scope } })
  if (fact.type !== "context.accumulated" || fact.version !== 6) throw new Error("Context entry fact parser returned the wrong type")
  return fact
}

/** The handoff entry of a stored `context.accumulated` fact, and the item
 *  scope of an entry that an item recorded, in the current shape. */
interface AccumulatedRecord {
  readonly entry: HandoffEntry
  readonly scope: ItemScope | null
}

export function accumulatedEntry(fact: ContextAccumulatedFact): AccumulatedRecord {
  switch (fact.version) {
    case 6: return { entry: fact.payload.entry, scope: fact.payload.scope ?? null }
    case 5: return { entry: currentEntry(fact.payload.entry), scope: itemScopeFromBranch(fact.payload.scope) }
    case 4: return { entry: currentEntry(fact.payload.entry), scope: null }
  }
}

function currentEntry({ stepId, stepName, recipientStepId, ...rest }: typeof HandoffEntryV1Schema.Type): HandoffEntry { // stored keys of version 1
  return { entryId: stepId, agentName: stepName, recipientAttemptId: recipientStepId, ...rest } // stored keys of version 1
}

/** One stored request addendum in the current shape: a message that an
 *  agent read, with the item scope of a reply that an item read, or a
 *  message with its address. */
export type AddendumRecord =
  | { readonly kind: "read"; readonly addendum: RequestAddendum; readonly scope: ItemScope | null }
  | { readonly kind: "addressed"; readonly addendum: AddressedAddendum }

export function addendumRecord(fact: ContextInputAddedFact): AddendumRecord {
  switch (fact.version) {
    case 4: return "readBy" in fact.payload ? { kind: "read", addendum: fact.payload, scope: null } : { kind: "addressed", addendum: fact.payload }
    case 3: return { kind: "addressed", addendum: { ...fact.payload, addressedTo: currentAddresses(fact.payload.addressedTo) } }
    case 2: {
      const { scope, ...addendum } = fact.payload
      return { kind: "read", addendum: currentReader(addendum), scope: itemScopeFromBranch(scope) }
    }
    case 1: return { kind: "read", addendum: currentReader(fact.payload), scope: null }
  }
}

function currentReader({ readBy, ...rest }: typeof RequestAddendumV1Schema.Type): RequestAddendum {
  return { ...rest, readBy: { attemptId: readBy.stepId, agentName: readBy.stepName, conversationId: readBy.conversationId } } // stored keys of version 1
}

/** Strictly decode a stored workflow context fact at its stored version. */
export function parseWorkflowContextFact(value: unknown): WorkflowContextFact {
  return Schema.decodeUnknownSync(WorkflowContextFactSchema, { onExcessProperty: "error" })(value)
}
