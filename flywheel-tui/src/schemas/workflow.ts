import { z } from "zod";

const WorkflowStepSchema = z.object({
  description: z.string(),
  dispatcherHint: z.string().optional(),
  validationCriteria: z.string().optional(),
  requiredOutputs: z.array(z.string()).optional(),
  dependencies: z.array(z.string()).optional(),
});

export const WorkflowDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  steps: z.array(WorkflowStepSchema).min(1),
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
