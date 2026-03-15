import { z } from "zod";

// REMOVED: full_content — use phases[] only
const PlanPhaseStepSchema = z.object({
  description: z.string(),
  dispatcherHint: z.string().optional(),
  validationCriteria: z.string().optional(),
}).strip();

const PlanPhaseSchema = z.object({
  name: z.string(),
  steps: z.array(PlanPhaseStepSchema),
}).strip();

const PlanInputSchema = z.object({
  // REMOVED: full_content — use phases[] only
  phases: z.array(PlanPhaseSchema),
}).strip();

export const DispatcherInputSchema = z.object({
  plan: PlanInputSchema,
  state: z.object({
    completed_phases: z.array(z.number()),
    current_phase_index: z.number(),
  }).strip(),
  context: z.object({
    files: z.array(z.string()),
  }).strip(),
}).strip();

export type DispatcherInput = z.infer<typeof DispatcherInputSchema>;

// REMOVED: adapted_plan — Decision #7
export const DispatcherDecisionSchema = z.object({
  phase_index: z.number(),
  step_index: z.number(),
  prompt: z.string(),
  context_files: z.array(z.string()),
  validation_criteria: z.string(),
  timeout_minutes: z.number(),
  parallel: z.boolean().optional(),
}).strip().refine(
  (data) => data.parallel !== true,
  { message: "parallel: true is not supported — sequential execution only" }
);

export type DispatcherDecision = z.infer<typeof DispatcherDecisionSchema>;
