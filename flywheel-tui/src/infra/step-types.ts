/**
 * Step type vocabulary — the kinds of step a queue can execute.
 *
 * Defined in infra/ because it's a foundational type used across all layers
 * (workflows, orchestration, tui).
 */
export type StepType =
  | "plan"
  | "work"
  | "review"
  | "ship"
  | "debug"
  | "research"
  | "verify"
  | "gate";
