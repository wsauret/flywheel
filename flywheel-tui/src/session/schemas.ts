import { z } from "zod";
import { SessionLifecycleStateSchema } from "./state-machine";
import { BudgetLimitsSchema, BudgetUsageSchema } from "../schemas/shared";

export const SessionSchema = z.object({
  // --- Required fields ---
  /** Display name for the session (user-facing). */
  label: z.string(),
  lastUpdated: z.string().datetime(),

  // --- Optional fields ---
  /** Actual file path to the plan, if one exists on disk. */
  planPath: z.string().optional(),
  sessionLifecycleState: SessionLifecycleStateSchema.optional(),
  name: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  totalCost: z.number().min(0).optional(),

  // --- Output persistence ---
  /** Path to the output snapshot file (`.output.json`). */
  outputPath: z.string().optional(),

  // --- Worktree integration ---
  /** Path to the git worktree directory, if one was created for this session. */
  worktreePath: z.string().optional(),
  /** Epoch ms when session was trashed — used for grace-period cleanup. */
  lastTrashedAt: z.number().int().min(0).optional(),

  // --- Budget tracking ---
  /** Budget limits for this session. Uses .strip() for forward-compat. */
  budgetLimits: BudgetLimitsSchema.strip(),
  /** Accumulated budget usage for this session. Uses .strip() for forward-compat. */
  budgetUsage: BudgetUsageSchema.strip(),
  /** The step type that initiated this session. */
  workflowType: z.enum(["work", "plan", "review", "ship", "debug", "research", "verify", "gate"]),
}).strict();

export type Session = z.infer<typeof SessionSchema>;

/**
 * Migrate raw session JSON to the current schema shape.
 *
 * Called before `.safeParse()` to ensure old session files (written before
 * budget/workflowType fields existed) still load correctly. Handles:
 *
 * 1. Old `budgetConfig`/`budgetUsed` → new `budgetLimits`/`budgetUsage` mapping
 * 2. Old `total_token_budget: 0` → `max_tokens: null` (0 means unlimited)
 * 3. Removal of vestigial fields: `statePath`, `contextPath`, `currentStep`, `workflowId`
 * 4. `planPath` (required string) → `label` (required) + `planPath` (optional)
 * 5. Default `workflowType` to `"work"` if absent
 *
 * **Forward-compat limitation:** fields written by a newer binary version
 * will cause `.strict()` parse failures on older binaries. This is acceptable
 * for internal persistence; the upgrade path is to update the binary.
 */
export function migrateSession(raw: Record<string, unknown>): Record<string, unknown> {
  const migrated = { ...raw };

  // --- Handle old budgetConfig → new budgetLimits ---
  if (migrated.budgetConfig && !migrated.budgetLimits) {
    const old = migrated.budgetConfig as Record<string, unknown>;
    // total_token_budget: 0 means unlimited → map to null
    const totalTokenBudget = old.total_token_budget;
    const maxTokens = (totalTokenBudget === 0 || totalTokenBudget === undefined)
      ? null
      : totalTokenBudget;
    migrated.budgetLimits = {
      max_invocations: old.total_invocations_limit ?? 0,
      max_tokens: maxTokens,
      wall_clock_deadline: old.wall_clock_deadline ?? null,
    };
  }

  // --- Handle old budgetUsed → new budgetUsage ---
  if (migrated.budgetUsed && !migrated.budgetUsage) {
    const old = migrated.budgetUsed as Record<string, unknown>;
    migrated.budgetUsage = {
      invocations_used: old.total_invocations_used ?? 0,
      tokens_used: old.total_tokens_used ?? 0,
      cost_usd: 0,
    };
  }

  // --- Default budgetLimits if still missing ---
  if (!migrated.budgetLimits) {
    migrated.budgetLimits = {
      max_invocations: 0,
      max_tokens: null,
      wall_clock_deadline: null,
    };
  }

  // --- Default budgetUsage if still missing ---
  if (!migrated.budgetUsage) {
    migrated.budgetUsage = {
      invocations_used: 0,
      tokens_used: 0,
      cost_usd: 0,
    };
  }

  // --- Default workflowType ---
  if (!migrated.workflowType) {
    migrated.workflowType = "work";
  }

  // --- Add label defaulting to planPath for old sessions ---
  if (!migrated.label) {
    migrated.label = (migrated.planPath as string) ?? "unknown";
  }

  // --- Remove vestigial fields (would cause .strict() to reject) ---
  delete migrated.statePath;
  delete migrated.contextPath;
  delete migrated.currentStep;
  delete migrated.workflowId;
  // Remove old budget fields (already migrated above)
  delete migrated.budgetConfig;
  delete migrated.budgetUsed;

  return migrated;
}
