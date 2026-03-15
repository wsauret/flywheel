import { z } from "zod";

export const CliSessionSchema = z.object({
  planPath: z.string(),
  statePath: z.string(),
  contextPath: z.string(),
  currentPhase: z.number().int().min(0),
  lastUpdated: z.string().datetime(),
  workflowId: z.string().uuid(),
}).strict();

export type CliSession = z.infer<typeof CliSessionSchema>;
