/** The durable records of a step-grammar definition, frozen as the last
 *  build before phases wrote them. A paused run's identity hashed them, and
 *  a launch approval answered on a step-grammar file pinned the hash of its
 *  record, so the identity proofs and the approval check rebuild them here.
 *  Remove after 2027-04-30. */
import { Schema } from "effect";
import { CanonicalWorkflowStepSchema, StepGrammarWorkflowSchema, type StepGrammarWorkflow, type WorkflowStep } from "./schema.js";

const policyFields = CanonicalWorkflowStepSchema.fields;

/** Durable record of one step's policy: what only the workflow could mean at
 *  this position. `writes` is the authored value, not the resolved default.
 *  A record holds `kind` only when the step declared one. The step's `model`
 *  and `effort` were not policy. */
const StepPolicyRecordSchema = Schema.Struct({
  stepId: Schema.String,
  name: policyFields.name,
  writes: policyFields.writes,
  reads: policyFields.reads,
  toolScoping: policyFields.toolScoping,
  kind: policyFields.kind,
  external: policyFields.external,
});
export type StepPolicyRecord = typeof StepPolicyRecordSchema.Type;

/** The policy record of one authored step, decoded strictly. */
export function canonicalStepPolicy(stepId: string, step: WorkflowStep): StepPolicyRecord {
  return Schema.decodeUnknownSync(StepPolicyRecordSchema, { onExcessProperty: "error" })({
    stepId,
    ...(step.name === undefined ? {} : { name: step.name }),
    ...(step.writes === undefined ? {} : { writes: step.writes }),
    ...(step.reads === undefined ? {} : { reads: step.reads }),
    ...(step.toolScoping === undefined ? {} : { toolScoping: step.toolScoping }),
    ...(step.kind === undefined ? {} : { kind: step.kind }),
    ...(step.external === undefined ? {} : { external: step.external }),
  });
}

/** The step-grammar workflow as authored, without the loader's
 *  attachments. */
export function canonicalStepWorkflowRecord(workflow: StepGrammarWorkflow): typeof StepGrammarWorkflowSchema.Type {
  const { provenance: _provenance, retiredBindings: _retiredBindings, ...source } = workflow;
  return Schema.decodeUnknownSync(StepGrammarWorkflowSchema, { onExcessProperty: "error" })(source);
}
