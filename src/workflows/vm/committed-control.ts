import { Schema } from "effect";
import { DurableFollowUpInputSchema } from "../../infra/chat-input-schema.js";
import { DefinitionIdentitySchema } from "./definition-identity.js";
import { AttemptSchema, WorkflowGraphSchema } from "./graph-types.js";

const IdSchema = Schema.NonEmptyString;
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

// The guardrails of control version 11 (ARCH-WORKFLOWS-012). `maxAttempts` bounds the
// worst-case attempt count, and `maxInserts` and `insertsUsed` bound what a
// run adds after launch.
const WorkflowGuardrailAccountingSchema = Schema.Struct({
  maxAttempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** The author's `max_parallel`: how many attempts may run at one time.
   *  A launch writes it only when the author declares it. Without it, every
   *  ready attempt that waits on no other runs at once, which is also what
   *  a root from before the key means. */
  maxParallel: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  maxMutationsPerAttempt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  maxInserts: NonNegativeIntSchema,
  insertsUsed: NonNegativeIntSchema,
  attemptMutationsUsed: Schema.Array(Schema.Struct({
    attemptId: IdSchema,
    used: NonNegativeIntSchema,
  })),
});

const WorkflowControlStatusSchema = Schema.Union([
  Schema.Literal("ready"),
  Schema.Literal("executing"),
  Schema.Literal("paused"),
  Schema.Literal("follow_up"),
  Schema.Literal("completed"),
  Schema.Literal("failed"),
]);

export const IdentifiedFollowUpIdentitySchema = Schema.Struct({
  kind: Schema.Literal("identified"),
  inputID: IdSchema,
});
export const FollowUpIdentitySchema = Schema.Union([
  IdentifiedFollowUpIdentitySchema,
  Schema.Struct({ kind: Schema.Literal("historical") }),
]);
export type FollowUpIdentity = typeof FollowUpIdentitySchema.Type;

export const FollowUpTransferPayloadSchema = Schema.Struct({
  source: Schema.Struct({
    conversationId: IdSchema,
    requestSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    identity: FollowUpIdentitySchema,
  }),
  destination: Schema.Struct({
    parentSessionId: IdSchema,
    parentConversationId: IdSchema,
    inputEntryId: IdSchema,
    turnEndEntryId: IdSchema,
  }),
  queuedMappings: Schema.Array(Schema.Struct({
    sourceKey: IdSchema,
    destinationEntryId: IdSchema,
  })),
});

const FollowUpControlSchema = Schema.Struct({
  conversationId: IdSchema,
  requestSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  identity: FollowUpIdentitySchema,
  pendingInput: Schema.NullOr(DurableFollowUpInputSchema),
});

export const CommittedWorkflowControlSchema = Schema.Struct({
  definitionIdentity: DefinitionIdentitySchema,
  workflowName: IdSchema,
  graph: WorkflowGraphSchema,
  attempts: Schema.Array(AttemptSchema),
  frontier: Schema.Array(IdSchema),
  guardrails: WorkflowGuardrailAccountingSchema,
  status: WorkflowControlStatusSchema,
  followUp: Schema.NullOr(FollowUpControlSchema),
  aggregateSeq: NonNegativeIntSchema,
});

export type CommittedWorkflowControl = typeof CommittedWorkflowControlSchema.Type;

// Remove after 2027-10-17. Version 11 predates continuation attempts and
// delivered handoffs; its pinned contract must not admit the new provenance
// carried by version 12 or the issues of a delivered handoff.
const { handoffIssues: _handoffIssues, ...AttemptV11Fields } = AttemptSchema.fields;
export const WorkflowControlV11Schema = Schema.Struct({
  ...CommittedWorkflowControlSchema.fields,
  attempts: Schema.Array(Schema.Struct({
    ...AttemptV11Fields,
    provenance: Schema.Union([
      Schema.TaggedStruct("authored", {}),
      Schema.TaggedStruct("retry", {}),
      Schema.TaggedStruct("reassessment", {}),
      Schema.TaggedStruct("item", { ordinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
      Schema.TaggedStruct("round", { index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
      Schema.TaggedStruct("followUpV10", {}),
    ]),
  })),
});

export function parseCommittedWorkflowControl(value: unknown): CommittedWorkflowControl {
  return Schema.decodeUnknownSync(CommittedWorkflowControlSchema, { onExcessProperty: "error" })(value);
}
