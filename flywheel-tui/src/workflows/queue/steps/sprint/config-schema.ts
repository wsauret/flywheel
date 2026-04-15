import { z } from "zod";
import { TierConfigSchema } from "../../../../infra/workflow-types.js";

export const SprintConfigSchema = z.object({
  max_iterations: z.number().int().min(1).max(10).default(5),
  detect_stuck: z.boolean().default(false),
  worker: TierConfigSchema,
  evaluator: TierConfigSchema,
  dispatcher: TierConfigSchema,
}).default({});

export type SprintConfig = z.infer<typeof SprintConfigSchema>;
