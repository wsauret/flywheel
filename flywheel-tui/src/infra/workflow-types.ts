import { z } from "zod"

export const EffortSchema = z.enum(["low", "medium", "high", "max"])

export const TierConfigSchema = z.object({
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

const ToolScopingSchema = z.object({
  read: z.boolean(),
  bash: z.boolean(),
  write: z.boolean(),
  edit: z.boolean(),
  task: z.boolean().default(false),
}).strip()

type ToolScoping = z.infer<typeof ToolScopingSchema>

export type ToolAction =
  | "handoff_write"
  | "file_read"
  | "file_search"
  | "shell_exec"
  | "file_write"
  | "file_edit"
  | "task_or_progress"
  | "ask_user"

const TOOL_SCOPING_TO_ACTIONS: Record<keyof ToolScoping, readonly ToolAction[]> = {
  read: ["file_read"],
  bash: ["shell_exec"],
  write: ["file_write"],
  edit: ["file_edit"],
  task: ["task_or_progress"],
}

export function toolScopingToActions(scoping: ToolScoping): ToolAction[] {
  const allowed: ToolAction[] = []
  for (const [key, actions] of Object.entries(TOOL_SCOPING_TO_ACTIONS)) {
    if (scoping[key as keyof ToolScoping]) {
      for (const action of actions) {
        if (!allowed.includes(action)) allowed.push(action)
      }
    }
  }
  if (!allowed.includes("handoff_write")) {
    allowed.push("handoff_write")
  }
  return allowed
}

export const WorkerConfigSchema = z.object({
  tool_scoping: ToolScopingSchema.optional(),
  self_review_items: z.array(z.string()).optional(),
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

