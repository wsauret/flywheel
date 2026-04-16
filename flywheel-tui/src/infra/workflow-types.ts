/** Shared domain schemas consumed by both workflows/ and orchestration/. Lives in infra/ because the one-way dependency rule prevents orchestration/ from importing workflows/. */
import { z } from "zod"

export const EffortSchema = z.enum(["low", "medium", "high", "max"])

export const TierConfigSchema = z.object({
  /** Engine override for this tier (e.g., "claude", "harness"). Falls back to top-level engine. */
  engine: z.string().optional(),
  model: z.string().optional(),
  effort: EffortSchema.optional(),
}).default({})

export const EvaluationCriteriaSchema = z.object({
  acceptance_criteria: z.array(z.string()),
  required_tests: z.boolean(),
  custom_checks: z.array(z.string()),
  required_outputs: z.array(z.string()),
}).strip()

export type EvaluationCriteria = z.infer<typeof EvaluationCriteriaSchema>

export const ToolScopingSchema = z.object({
  read: z.boolean(),
  bash: z.boolean(),
  write: z.boolean(),
  edit: z.boolean(),
  task: z.boolean().default(false),
}).strip()

type ToolScoping = z.infer<typeof ToolScopingSchema>

const TOOL_SCOPING_TO_NAME: Record<string, string> = {
  read: "Read",
  bash: "Bash",
  write: "Write",
  edit: "Edit",
  task: "Task",
}

/** Convert ToolScoping flags to an explicit tool name list. Write is always included (handoff). */
export function toolScopingToToolNames(scoping: ToolScoping): string[] {
  const allowed: string[] = []
  for (const [key, cliName] of Object.entries(TOOL_SCOPING_TO_NAME)) {
    if (scoping[key as keyof ToolScoping]) {
      allowed.push(cliName)
    }
  }
  if (!allowed.includes("Write")) {
    allowed.push("Write")
  }
  return allowed
}

export const WorkerConfigSchema = z.object({
  tool_scoping: ToolScopingSchema.optional(),
}).strip()

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>

export const MutationRequestSchema = z.object({
  type: z.enum(["insert_after", "skip", "remove"]),
  target_step_id: z.string().optional(),
  steps: z.array(
    z.object({
      type: z.string(),
      title: z.string(),
      description: z.string().optional(),
      acceptance_criteria: z.array(z.string()).optional(),
    })
  ).optional(),
  reason: z.string(),
}).strict()

export const DispatcherDecisionSchema = z.object({
  schema_version: z.literal(1),
  step_index: z.number().optional(),
  task_content: z.string(),
  context_files: z.array(z.string()),
  context_to_inline: z.array(z.string()).optional(),
  evaluation_criteria: EvaluationCriteriaSchema,
  reasoning: z.string().optional(),
  warnings: z.array(z.string()).optional(),
  worker_config: WorkerConfigSchema.optional(),
  mutation_requests: z.array(MutationRequestSchema).optional(),
}).strip()

export type DispatcherDecision = z.infer<typeof DispatcherDecisionSchema>

export const EvaluatorResultSchema = z.object({
  passed: z.boolean(),
  reasoning: z.string(),
  suggestions: z.array(z.string()).optional(),
  feedback: z.string(),
}).strip()

export type EvaluatorResult = z.infer<typeof EvaluatorResultSchema>

