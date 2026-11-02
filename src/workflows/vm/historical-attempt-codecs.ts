import { Schema } from "effect";
import { FollowUpSettledArmsV3, ReassessmentProposalV3Schema, SharedEventArmsV3, WorkflowProposalEventV4Schema, WorkflowProposalEventV5Schema } from "./historical-codecs.js";

// Frozen attempt codecs from before each outcome carried the operations its
// attempt ran. Nothing here derives from the current event or fact schemas,
// so a change to them cannot change how a stored fact decodes.

const Id = Schema.NonEmptyString;

/** Attempt payloads before measured operations: attempt.succeeded v2,
 *  attempt.failed v2, and attempt.retry_inserted v1. History only; remove
 *  after 2027-04-15. */
export const AttemptSucceededV2PayloadSchema = Schema.Struct({ attemptId: Id });
export const AttemptFailedV2PayloadSchema = Schema.Struct({
  attemptId: Id,
  kind: Schema.Literals(["handoff", "missing_handoff", "invalid_handoff", "transient", "context_overflow", "fatal"]),
  reason: Schema.NonEmptyString,
});
export const AttemptRetryInsertedV1PayloadSchema = Schema.Struct({ attemptId: Id, retryAttemptId: Id, feedback: Schema.String });

const FailureV6Fields = {
  attemptId: Id,
  reason: Schema.NonEmptyString,
  conversationId: Schema.NullOr(Id),
};
const FailureV6Schema = Schema.Union([
  Schema.Struct({
    ...FailureV6Fields,
    kind: Schema.Union([Schema.Literal("handoff"), Schema.Literal("transient"), Schema.Literal("context_overflow"), Schema.Literal("fatal")]),
  }),
  Schema.Struct({
    ...FailureV6Fields,
    kind: Schema.Literal("invalid_handoff"),
    content: Schema.Record(Schema.String, Schema.Unknown),
    issues: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String, hint: Schema.optionalKey(Schema.String) })),
  }),
  Schema.Struct({ ...FailureV6Fields, kind: Schema.Literal("missing_handoff") }),
]);

/** The event of committed v6 through v8, before measured operations.
 *  History only; remove after 2027-04-15. */
export const WorkflowProposalEventV6Schema = Schema.Union([
  SharedEventArmsV3[0],
  SharedEventArmsV3[1],
  SharedEventArmsV3[2],
  Schema.Struct({
    type: Schema.Literal("ATTEMPT_SUCCEEDED"),
    outcome: Schema.Struct({
      attemptId: Id,
      conversationId: Schema.NullOr(Id),
      handoff: Schema.Record(Schema.String, Schema.Unknown),
      reassessment: Schema.NullOr(ReassessmentProposalV3Schema),
    }),
  }),
  SharedEventArmsV3[4],
  Schema.Struct({ type: Schema.Literal("ATTEMPT_FAILED"), failure: FailureV6Schema }),
  SharedEventArmsV3[6],
  SharedEventArmsV3[7],
  SharedEventArmsV3[8],
  SharedEventArmsV3[9],
  WorkflowProposalEventV4Schema.members[10],
  ...FollowUpSettledArmsV3,
  WorkflowProposalEventV5Schema.members[1],
]);

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** The event of committed v9: the v6 event with the measured operations of
 *  each attempt outcome and failure. Its reassessment changes hold graph
 *  version 3 shapes only, because no item of a repeat existed. History only;
 *  remove after 2027-04-30. */
export const WorkflowProposalEventV9Schema = Schema.Union([
  SharedEventArmsV3[0],
  SharedEventArmsV3[1],
  SharedEventArmsV3[2],
  Schema.Struct({
    type: Schema.Literal("ATTEMPT_SUCCEEDED"),
    outcome: Schema.Struct({
      attemptId: Id,
      conversationId: Schema.NullOr(Id),
      handoff: Schema.Record(Schema.String, Schema.Unknown),
      reassessment: Schema.NullOr(ReassessmentProposalV3Schema),
      toolUses: Schema.optionalKey(Count),
    }),
  }),
  SharedEventArmsV3[4],
  Schema.Struct({
    type: Schema.Literal("ATTEMPT_FAILED"),
    // The fields keep the order of the last build that wrote them, which
    // names the tool-use count before the failure's kind.
    failure: Schema.Union([
      Schema.Struct({ ...FailureV6Fields, toolUses: Schema.optionalKey(Count), kind: FailureV6Schema.members[0].fields.kind }),
      Schema.Struct({ ...FailureV6Fields, toolUses: Schema.optionalKey(Count), kind: FailureV6Schema.members[1].fields.kind, content: FailureV6Schema.members[1].fields.content, issues: FailureV6Schema.members[1].fields.issues }),
      Schema.Struct({ ...FailureV6Fields, toolUses: Schema.optionalKey(Count), kind: FailureV6Schema.members[2].fields.kind }),
    ]),
  }),
  SharedEventArmsV3[6],
  SharedEventArmsV3[7],
  SharedEventArmsV3[8],
  SharedEventArmsV3[9],
  WorkflowProposalEventV4Schema.members[10],
  ...FollowUpSettledArmsV3,
  WorkflowProposalEventV5Schema.members[1],
]);
