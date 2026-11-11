import { Schema } from "effect";
import {
  CommittedWorkflowControlSchema,
  FollowUpTransferPayloadSchema,
  IdentifiedFollowUpIdentitySchema,
  type FollowUpIdentity,
} from "./committed-control.js";
import { ReassessmentChangeV3Schema, SharedEventArmsV3 } from "./historical-codecs.js";
import { DurableFollowUpInputSchema } from "../../infra/chat-input-schema.js";
import { HandoffIssueSchema } from "./graph-types.js";

const IdSchema = Schema.NonEmptyString;
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const AttemptFailureFields = {
  attemptId: IdSchema,
  reason: Schema.NonEmptyString,
  conversationId: Schema.NullOr(IdSchema),
  toolUses: Schema.optionalKey(NonNegativeIntSchema),
};

const AttemptFailureSchema = Schema.Union([
  Schema.Struct({
    ...AttemptFailureFields,
    kind: Schema.Union([
      Schema.Literal("handoff"),
      Schema.Literal("transient"),
      Schema.Literal("context_overflow"),
      Schema.Literal("fatal"),
    ]),
  }),
  Schema.Struct({
    ...AttemptFailureFields,
    kind: Schema.Literal("invalid_handoff"),
    content: Schema.Record(Schema.String, Schema.Unknown),
    issues: Schema.Array(HandoffIssueSchema),
  }),
  Schema.Struct({
    ...AttemptFailureFields,
    kind: Schema.Literal("missing_handoff"),
  }),
]);

// The reassessment vocabulary. A change of control from before phases holds
// graph version 3 shapes in every encoding, so a reassessment that a stored
// workflow recorded and one that a history arm proposes read the same way.
// The item changes edit the remaining items of a repeat over items, by item
// id, in order; only encoding 10 and later hold them.
const ItemChangeFields = { repeatNodeId: IdSchema, reason: Schema.NonEmptyString };
export const ReassessmentChangeSchema = Schema.Union([
  ...ReassessmentChangeV3Schema.members,
  Schema.Struct({ kind: Schema.Literal("drop_item"), ...ItemChangeFields, itemId: IdSchema }),
  Schema.Struct({ kind: Schema.Literal("replace_item"), ...ItemChangeFields, itemId: IdSchema, item: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("insert_item"), ...ItemChangeFields, afterItemId: IdSchema, item: Schema.Json }),
]);

const ReassessmentProposalSchema = Schema.Struct({
  proposalId: IdSchema,
  ownerNodeId: IdSchema,
  reason: Schema.NonEmptyString,
  changes: Schema.NonEmptyArray(ReassessmentChangeSchema),
});

// Remove after 2027-10-17. The outcome of encodings 10 to 13, which predate
// delivered handoffs.
const AttemptOutcomeV13Schema = Schema.Struct({
  attemptId: IdSchema,
  conversationId: Schema.NullOr(IdSchema),
  handoff: Schema.Record(Schema.String, Schema.Unknown),
  reassessment: Schema.NullOr(ReassessmentProposalSchema),
  toolUses: Schema.optionalKey(NonNegativeIntSchema),
});

const AttemptOutcomeSchema = Schema.Struct({
  attemptId: IdSchema,
  conversationId: Schema.NullOr(IdSchema),
  handoff: Schema.Record(Schema.String, Schema.Unknown),
  reassessment: Schema.NullOr(ReassessmentProposalSchema),
  /** The problems that remain in a handoff that the runtime delivered after
   *  the agent's handoff correction ran out. Absent for a handoff that its
   *  contract accepted, and in every outcome recorded before 2026-11-11. */
  issues: Schema.optionalKey(Schema.Array(HandoffIssueSchema)),
  toolUses: Schema.optionalKey(NonNegativeIntSchema),
});

// Dated history, removed after 2027-04-03. A build before blocked retirement
// committed ATTEMPT_BLOCKED when an agent handed off `outcome.state: "blocked"`.
// `handoff` is that canonical evidence, with its own reason and evidence.
// Replay still reads the event so a stored corrective chain resumes through its
// reassess agent. No current writer proposes it: see NewWorkflowProposalEvent.
const AttemptBlockedSchema = Schema.Struct({
  attemptId: IdSchema,
  conversationId: Schema.NullOr(IdSchema),
  handoff: Schema.Record(Schema.String, Schema.Unknown),
});

/** The arms before RECOVER, with the outcome shape of their encoding. */
const proposalEventArmsBeforeRecover = <Outcome extends Schema.Top>(outcome: Outcome) => [
  Schema.Struct({ type: Schema.Literal("START") }),
  Schema.Struct({ type: Schema.Literal("ADVANCE") }),
  Schema.Struct({
    type: Schema.Literal("ATTEMPT_STARTED"),
    attemptId: IdSchema,
    conversationId: IdSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("ATTEMPT_SUCCEEDED"),
    outcome,
  }),
  Schema.Struct({
    type: Schema.Literal("ATTEMPT_BLOCKED"),
    blocked: AttemptBlockedSchema,
    // Definition id of the authored continuation eligible to receive this
    // blocker: the unconditional next unit whose definition writes a
    // reassessment handoff. Null when no eligible continuation exists and the
    // workflow has no configured corrective continuation. The pure machine
    // definitions, so the host resolves this from the definitions the run is
    // pinned to and `blockAttempt` verifies it against the authored graph
    // before it routes.
    correctiveDefinitionId: Schema.NullOr(IdSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("ATTEMPT_FAILED"),
    failure: AttemptFailureSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("PAUSE"),
    reason: Schema.NonEmptyString,
  }),
] as const;

const ProposalEventArmsAfterRecover = [
  Schema.Struct({
    type: Schema.Literal("ABORT"),
    reason: Schema.NonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("FOLLOW_UP_REQUESTED"),
    input: DurableFollowUpInputSchema,
    identity: IdentifiedFollowUpIdentitySchema,
    conversationId: IdSchema,
    requestSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  Schema.Struct({
    type: Schema.Literal("FOLLOW_UP_SUCCEEDED"),
    conversationId: IdSchema,
    requestSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  Schema.Struct({
    type: Schema.Literal("FOLLOW_UP_FAILED"),
    reason: Schema.NonEmptyString,
    conversationId: IdSchema,
    requestSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
  Schema.Struct({
    type: Schema.Literal("REASSESSMENT_PROPOSED"),
    proposal: ReassessmentProposalSchema,
  }),
] as const;

const FollowUpTransferEventSchema = Schema.Struct({
  type: Schema.Literal("FOLLOW_UP_TRANSFERRED"),
  ...FollowUpTransferPayloadSchema.fields,
});
/** A person's Resume. `readers` holds, for each agent record id, the node
 *  ids of the outputs that its record declares in `reads`, and whether it
 *  writes a transient artifact, which the agent after it reads as its prior
 *  handoff. Both come from the definitions that the run is pinned to, which
 *  control does not hold. The Resume of a failed run reruns each finished
 *  agent that reads the output of an agent that runs again
 *  (`reopenFailedNodes`), and replay reads the same map from the event. */
const ResumeEventSchema = Schema.Struct({
  type: Schema.Literal("RESUME"),
  readers: Schema.Record(IdSchema, Schema.Struct({ reads: Schema.Array(IdSchema), transient: Schema.Boolean })),
});
/** The restart of a crashed run. `progressed` names each attempt in flight
 *  whose conversation recorded a served model response since the run last
 *  recovered or the attempt last started, so its restart count starts over. */
const RecoverEventSchema = Schema.Struct({
  type: Schema.Literal("RECOVER"),
  progressed: Schema.Array(IdSchema),
});
export const WorkflowProposalEventSchema = Schema.Union([
  ...proposalEventArmsBeforeRecover(AttemptOutcomeSchema),
  ResumeEventSchema,
  RecoverEventSchema,
  ...ProposalEventArmsAfterRecover,
  FollowUpTransferEventSchema,
]);

// Dated history, removed after 2027-10-17, the latest date of the versions
// it serves. Proposals of encodings 10 to 13
// hold the current event, except a RESUME that carries no reader map and a
// RECOVER that names no progressed attempt. They decode as `readers: {}`
// and `progressed: []`, their exact meaning, because no version before 14
// reruns a reader (`normalizeHistoricalWorkflowEvent`).
export const WorkflowProposalEventV13Schema = Schema.Union([
  ...proposalEventArmsBeforeRecover(AttemptOutcomeV13Schema),
  SharedEventArmsV3[7],
  SharedEventArmsV3[8],
  ...ProposalEventArmsAfterRecover,
  FollowUpTransferEventSchema,
]);

const WorkflowEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("INITIALIZE"),
    control: CommittedWorkflowControlSchema,
  }),
  Schema.Struct({
    type: Schema.Literal("COMMIT_SUCCEEDED"),
    proposalId: IdSchema,
    aggregateSeq: NonNegativeIntSchema,
  }),
  WorkflowProposalEventSchema,
]);

export type ReassessmentChange = typeof ReassessmentChangeSchema.Type;
export type AttemptOutcome = typeof AttemptOutcomeSchema.Type;
export type AttemptFailure = typeof AttemptFailureSchema.Type;
export type ReassessmentProposal = typeof ReassessmentProposalSchema.Type;
export type WorkflowProposalEvent = typeof WorkflowProposalEventSchema.Type;
/** An event a current writer may propose. An agent that cannot finish messages
 *  its parent instead of stopping, so `ATTEMPT_BLOCKED` is replay history only. */
export type NewWorkflowProposalEvent = Exclude<WorkflowProposalEvent, { type: "ATTEMPT_BLOCKED" }>;
export type WorkflowEvent = typeof WorkflowEventSchema.Type;

/** The `workflow.control.committed` version whose semantics a proposal
 *  carries. Strict replay re-derives a stored proposal at its recorded
 *  version. Version 14 names the progressed attempts of a RECOVER and
 *  continues an agent whose conversation overflowed after tool calls.
 *  Version 12 fails a named phase when an agent failed, also when
 *  it has a join. Version 11 ends a `while` repeat on its check. Version 10
 *  names new nodes of a list `item` and `phase` and holds repeat item changes. */
export type WorkflowProposalEncoding = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export const CURRENT_PROPOSAL_ENCODING = 14;

/** Whether a proposal of `encoding` holds the current event shape. Versions
 *  2 through 13 hold frozen historical shapes. */
export function holdsCurrentEvent(encoding: WorkflowProposalEncoding): encoding is 14 {
  return encoding === CURRENT_PROPOSAL_ENCODING;
}

export type FollowUpTransferEvent = typeof FollowUpTransferEventSchema.Type;
export type FollowUpTransferInput = Omit<FollowUpTransferEvent, "type">;
type ReplayedFollowUpRequest = Omit<Extract<WorkflowProposalEvent, { type: "FOLLOW_UP_REQUESTED" }>, "identity"> & { readonly identity: FollowUpIdentity };
export type DecodedWorkflowProposalEvent = Exclude<WorkflowProposalEvent, { type: "FOLLOW_UP_REQUESTED" }> | ReplayedFollowUpRequest;
export type DecodedWorkflowEvent = Exclude<WorkflowEvent, { type: "FOLLOW_UP_REQUESTED" }> | ReplayedFollowUpRequest;

export function parseWorkflowEvent(value: unknown): WorkflowEvent {
  return Schema.decodeUnknownSync(WorkflowEventSchema, { onExcessProperty: "error" })(value);
}

export function parseFollowUpTransferEvent(value: unknown): FollowUpTransferEvent {
  return Schema.decodeUnknownSync(FollowUpTransferEventSchema, { onExcessProperty: "error" })(value);
}
