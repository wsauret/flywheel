import type { StepGrammarWorkflow } from "./schema.js";

/** What a phase-grammar definition keeps of the step-grammar file it was
 *  converted from: the step-grammar record itself, which the identity proofs
 *  of a paused run read, and, keyed by agent record id, the step that the
 *  record runs and each brief id a converted bindings file kept. Brief
 *  loading preserves these inline brief ids, and agent
 *  resolution reads the steps, so an agent of a paused run reads its outputs
 *  where the step grammar put them. Remove after 2027-04-30. */
export interface RetiredStepGrammarView {
  readonly workflow: StepGrammarWorkflow;
  readonly stepIds: ReadonlyMap<string, string>;
  readonly briefIds: ReadonlyMap<string, string>;
}
