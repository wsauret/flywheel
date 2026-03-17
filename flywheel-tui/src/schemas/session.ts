import { z } from "zod";
import { SessionLifecycleStateSchema } from "../session/state-machine";

export const CliSessionSchema = z.object({
  // --- Required fields (original) ---
  planPath: z.string(),
  statePath: z.string(),
  contextPath: z.string(),
  currentPhase: z.number().int().min(0),
  lastUpdated: z.string().datetime(),
  workflowId: z.string().uuid(),

  // --- Optional fields (new — backward-compatible) ---
  sessionLifecycleState: SessionLifecycleStateSchema.optional(),
  name: z.string().optional(),
  createdAt: z.string().datetime().optional(),
  repo: z.string().optional(),
  branch: z.string().optional(),
  totalCost: z.number().min(0).optional(),

  // --- Worktree integration (Phase 7) ---
  /** Path to the git worktree directory, if one was created for this session. */
  worktreePath: z.string().optional(),
  /** Epoch ms when session was trashed — used for grace-period cleanup. */
  lastTrashedAt: z.number().int().min(0).optional(),
}).strict();

export type CliSession = z.infer<typeof CliSessionSchema>;
