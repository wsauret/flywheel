import { z } from "zod";
import { SessionStateSchema } from "./types.js";
import { BudgetLimitsSchema, BudgetUsageSchema } from "../../workflows/schemas.js";

const baseFields = {
  label: z.string(),
  lastUpdated: z.string().datetime(),
  budgetLimits: BudgetLimitsSchema.strip(),
  budgetUsage: BudgetUsageSchema.strip(),
  state: SessionStateSchema.default("active"),
  name: z.string().default(""),
  createdAt: z.string().datetime().optional(),
  totalCost: z.number().min(0).default(0),
  repo: z.string().optional(),
  branch: z.string().optional(),
};

const WorkflowSessionSchema = z.object({
  ...baseFields,
  kind: z.literal("workflow"),
  command: z.literal("work"),
  planPath: z.string(),
}).strict();

const ChatSessionSchema = z.object({
  ...baseFields,
  kind: z.literal("chat"),
  command: z.literal("chat"),
  engineSessionId: z.string().optional(),
}).strict();

export const SessionSchema = z.discriminatedUnion("kind", [
  WorkflowSessionSchema,
  ChatSessionSchema,
]);

export type Session = z.infer<typeof SessionSchema>;
