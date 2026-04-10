import { z } from "zod";
import { SessionStateSchema } from "./state-machine";
import { BudgetLimitsSchema, BudgetUsageSchema } from "../../workflows/schemas";

// ---------------------------------------------------------------------------
// Shared base fields (spread into each variant)
// ---------------------------------------------------------------------------

const baseFields = {
  label: z.string(),
  lastUpdated: z.string().datetime(),
  budgetLimits: BudgetLimitsSchema.strip(),
  budgetUsage: BudgetUsageSchema.strip(),
  state: SessionStateSchema.default("active"),
  name: z.string().default(""),
  createdAt: z.string().datetime().optional(),
  totalCost: z.number().min(0).default(0),
  outputPath: z.string().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
};

// ---------------------------------------------------------------------------
// Discriminated variants
// ---------------------------------------------------------------------------

export const WorkflowSessionSchema = z.object({
  ...baseFields,
  kind: z.literal("workflow"),
  command: z.enum(["work", "plan", "review", "ship", "debug", "research", "verify", "gate"]),
  planPath: z.string(),
  worktreePath: z.string().min(1).optional(),
}).strict();

export const ChatSessionSchema = z.object({
  ...baseFields,
  kind: z.literal("chat"),
  command: z.literal("chat"),
  /** Claude Code session ID — used for --resume to reconnect with full context. */
  claudeSessionId: z.string().optional(),
}).strict();

export const SessionSchema = z.discriminatedUnion("kind", [
  WorkflowSessionSchema,
  ChatSessionSchema,
]);

export type Session = z.infer<typeof SessionSchema>;
