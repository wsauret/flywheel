import { z } from "zod";

const EffortSchema = z.enum(["low", "medium", "high", "max"]);

export const SprintConfigSchema = z.object({
  max_iterations: z.number().int().min(1).max(10).default(5),
  detect_stuck: z.boolean().default(false),
  worker: z.object({
    model: z.string().optional(),
    effort: EffortSchema.optional(),
  }).default({}),
  evaluator: z.object({
    model: z.string().optional(),
    effort: EffortSchema.optional(),
  }).default({}),
  dispatcher: z.object({
    model: z.string().optional(),
    effort: EffortSchema.optional(),
  }).default({}),
}).default({});

export type SprintConfig = z.infer<typeof SprintConfigSchema>;
