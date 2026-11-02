import { Schema } from "effect";
import { CommittedWorkflowControlSchema } from "./committed-control.js";
import { WorkflowSessionFactSchema } from "./session-facts.js";

const IdSchema = Schema.NonEmptyString;
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const VmLifecycleSchema = Schema.Union([
  Schema.Literal("bootstrapping"),
  Schema.Literal("ready"),
  Schema.Literal("awaiting_commit"),
  Schema.Literal("executing"),
  Schema.Literal("paused"),
  Schema.Literal("follow_up"),
  Schema.Literal("completed"),
  Schema.Literal("failed"),
]);

const PendingWorkflowCommitSchema = Schema.Struct({
  proposalId: IdSchema,
  expectedSeq: NonNegativeIntSchema,
  previousCommitted: CommittedWorkflowControlSchema,
  proposedCommitted: CommittedWorkflowControlSchema,
  facts: Schema.Array(Schema.suspend(() => WorkflowSessionFactSchema)),
  nextLifecycle: VmLifecycleSchema,
});

const WorkflowMachineContextSchema = Schema.Struct({
  committed: CommittedWorkflowControlSchema,
  pending: Schema.NullOr(PendingWorkflowCommitSchema),
});

export const WorkflowMachineStateSchema = Schema.Struct({
  lifecycle: VmLifecycleSchema,
  context: WorkflowMachineContextSchema,
});

export type VmLifecycle = typeof VmLifecycleSchema.Type;
export type PendingWorkflowCommit = typeof PendingWorkflowCommitSchema.Type;
export type WorkflowMachineContext = typeof WorkflowMachineContextSchema.Type;
export type WorkflowMachineState = typeof WorkflowMachineStateSchema.Type;

export function parseWorkflowMachineState(value: unknown): WorkflowMachineState {
  return Schema.decodeUnknownSync(WorkflowMachineStateSchema, { onExcessProperty: "error" })(value);
}

export function parseWorkflowMachineContext(value: unknown): WorkflowMachineContext {
  return Schema.decodeUnknownSync(WorkflowMachineContextSchema, { onExcessProperty: "error" })(value);
}

export function parsePendingWorkflowCommit(value: unknown): PendingWorkflowCommit {
  return Schema.decodeUnknownSync(PendingWorkflowCommitSchema, { onExcessProperty: "error" })(value);
}
