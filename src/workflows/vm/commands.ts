import { Schema } from "effect";
import { DurableFollowUpInputSchema } from "../../infra/chat-input-schema.js";
import { FollowUpIdentitySchema } from "./committed-control.js";
import { AttemptProvenanceSchema } from "./graph-types.js";
import { RecipientScopeSchema } from "../context-bundle/context-facts.js";
import { WorkflowMachineStateSchema } from "./control-types.js";
import { WorkflowSessionFactSchema } from "./session-facts.js";

const IdSchema = Schema.NonEmptyString;
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const WorkflowCommitProposalSchema = Schema.Struct({
  proposalId: IdSchema,
  expectedSeq: NonNegativeIntSchema,
  facts: Schema.Array(WorkflowSessionFactSchema),
});

const AttemptExecutionInputSchema = Schema.Struct({
  attemptId: IdSchema,
  logicalNodeId: IdSchema,
  /** The agent record this attempt runs. */
  definitionId: IdSchema,
  workflowDefinitionId: IdSchema,
  conversationId: Schema.NullOr(IdSchema),
  iteration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  provenance: AttemptProvenanceSchema,
  priorRetryFeedback: Schema.NullOr(Schema.String),
  /** The item of an attempt of a repeat over items. */
  item: Schema.Json,
  /** The vote that an agent of a list with votes casts on its item: its
   *  vote number and the list's vote count. Absent for every other
   *  attempt. */
  vote: Schema.optionalKey(Schema.Struct({
    number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  })),
  /** The context view the attempt reads: the workflow scope, or its item
   *  with the entries its list froze at expansion. */
  scope: RecipientScopeSchema,
});

const FollowUpRunInputSchema = Schema.Struct({
  workflowDefinitionId: IdSchema,
  input: DurableFollowUpInputSchema,
  identity: FollowUpIdentitySchema,
  requestSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  conversationId: IdSchema,
});

const WorkflowCommandSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("commit"),
    proposal: WorkflowCommitProposalSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("prepare_attempt"),
    attempt: AttemptExecutionInputSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("run_attempts"),
    attempts: Schema.Array(AttemptExecutionInputSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("run_follow_up"),
    input: FollowUpRunInputSchema,
  }),
  Schema.Struct({ kind: Schema.Literal("none") }),
]);

const WorkflowTransitionResultSchema = Schema.Struct({
  state: WorkflowMachineStateSchema,
  command: WorkflowCommandSchema,
});

export type AttemptExecutionInput = typeof AttemptExecutionInputSchema.Type;
export type WorkflowMutation = typeof WorkflowCommandSchema.Type;
export type WorkflowTransitionResult = typeof WorkflowTransitionResultSchema.Type;

export function parseWorkflowCommand(value: unknown): WorkflowMutation {
  return Schema.decodeUnknownSync(WorkflowCommandSchema, { onExcessProperty: "error" })(value);
}
