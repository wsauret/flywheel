import { z } from "zod";
import { SessionStateSchema } from "./state-machine";
import { BudgetLimitsSchema, BudgetUsageSchema } from "../../workflows/schemas";

export const SessionSchema = z.object({
  label: z.string(),
  lastUpdated: z.string().datetime(),
  state: SessionStateSchema.optional(),
  kind: z.enum(["workflow", "chat"]),
  command: z.enum(["work", "plan", "review", "ship", "debug", "research", "verify", "gate", "chat"]),
  budgetLimits: BudgetLimitsSchema.strip(),
  budgetUsage: BudgetUsageSchema.strip(),

  planPath: z.string().optional(),
  name: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  totalCost: z.number().min(0).optional(),
  outputPath: z.string().optional(),
  worktreePath: z.string().optional(),
}).strict();

export type Session = z.infer<typeof SessionSchema>;
