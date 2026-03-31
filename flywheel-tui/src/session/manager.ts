/**
 * Session Manager
 *
 * Coordinates session lifecycle: persistence, state machine validation,
 * and session metadata management.
 *
 * Uses factory function pattern (`createSessionManager(deps)`) with
 * dependency injection for testability.
 *
 * Historical sessions are returned as plain `SessionSummary` objects,
 * NOT live UIActions stores.
 */

import {
  createSession as persistCreateSession,
  readSession,
  updateSession,
  listSessions,
  deleteSessionWithCompanions,
  type SessionListResult as PersistenceListResult,
} from "./persistence";
import { isValidTransition, type SessionLifecycleState } from "./state-machine";
import type { WorkflowSession } from "../tui/session/workflow-session";
import type { WorktreeManager as IWorktreeManager } from "./worktree-manager";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../config/loader";
import { Log } from "../utils/log";

const log = Log.create({ service: "session.manager" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Plain data summary of a session (no live store/adapter). */
export interface SessionSummary {
  id: string;
  name: string;
  /** Display name for the session (user-facing). */
  label: string;
  /** Actual file path to the plan, if one exists on disk. */
  planPath?: string;
  lifecycleState: SessionLifecycleState;
  totalCost: number;
  lastUpdated: string;
  createdAt?: string;
  repo?: string;
  branch?: string;
}

/** Result of listing sessions — mirrors persistence shape but with summaries. */
export interface SessionListResult {
  sessions: SessionSummary[];
  errors: PersistenceListResult["errors"];
}

/** Dependencies injected into the session manager. */
export interface SessionManagerDeps {
  baseDir: string;
  /**
   * @deprecated No longer used by SessionManager — kept for backward
   * compatibility with existing test harnesses. Will be removed in a
   * future step.
   */
  createWorkflowSessionFn?: (planPath: string) => WorkflowSession;
  /**
   * @deprecated No longer used by SessionManager — kept for backward
   * compatibility with existing test harnesses. Will be removed in a
   * future step.
   */
  destroyWorkflowSessionFn?: (session: WorkflowSession) => void;
  /** Optional worktree manager for git worktree lifecycle integration. */
  worktreeManager?: IWorktreeManager;
  /** Optional config — defaults to CONFIG_DEFAULTS when omitted. */
  config?: FlywheelConfig;
}

import type { StepType } from "../queue/types";

/** Step type for a session (uses StepType as sole source of truth). */
export type SessionStepType = StepType;

/** The SessionManager interface. */
export interface SessionManager {
  /** Create a new session and persist it. Returns session ID. */
  create(planPath: string, name?: string, stepType?: SessionStepType): string;

  /** List all sessions as summaries. */
  list(): SessionListResult;

  /** Update session lifecycle state with validation. */
  updateState(id: string, newState: SessionLifecycleState): void;

  /** Transition session to trashed state. */
  trash(id: string): void;

  /** Transition session to archived state. */
  archive(id: string): void;

  /**
   * Sweep trashed sessions: delete their files and companions from disk.
   * Intended for fire-and-forget startup cleanup.
   *
   * @returns The number of trashed sessions cleaned up.
   */
  sweepTrashed(): number;

  /**
   * Recover stale `work:active` sessions that have no running queue execution.
   * Transitions them to `work:paused` so they can be resumed.
   *
   * Intended for startup crash recovery — call BEFORE `sweepTrashed()`.
   *
   * @returns The number of sessions recovered.
   */
  recoverStaleSessions(): number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new SessionManager instance.
 *
 * @param deps - Injected dependencies (baseDir, workflow session functions).
 */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { baseDir, worktreeManager } = deps;
  const config = deps.config ?? CONFIG_DEFAULTS;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Read a session from disk, throwing if it doesn't exist.
   */
  function readOrThrow(id: string) {
    const session = readSession(id, baseDir);
    if (session === null) {
      throw new Error(`Session not found: ${id}`);
    }
    return session;
  }

  /**
   * Get the current lifecycle state, defaulting to "new" for legacy sessions.
   */
  function getLifecycleState(
    session: { sessionLifecycleState?: SessionLifecycleState },
  ): SessionLifecycleState {
    return session.sessionLifecycleState ?? "new";
  }

  // -------------------------------------------------------------------------
  // SessionManager methods
  // -------------------------------------------------------------------------

  function create(planPath: string, name?: string, stepType?: SessionStepType): string {
    const now = new Date().toISOString();
    const budget = config.budget;

    // Map config budget to session budget limits:
    // - max_invocations: 0 stays 0 (BudgetTracker treats 0 as unlimited)
    // - max_tokens: 0 → null (unlimited)
    // - max_wall_clock_minutes: 0 → null (unlimited), >0 → ISO deadline
    const wallClockDeadline = budget.max_wall_clock_minutes > 0
      ? new Date(Date.now() + budget.max_wall_clock_minutes * 60_000).toISOString()
      : null;

    const id = persistCreateSession(
      {
        label: name ?? planPath,
        planPath,
        lastUpdated: now,
        sessionLifecycleState: "new" as SessionLifecycleState,
        name,
        createdAt: now,
        budgetLimits: {
          max_invocations: budget.max_invocations,
          max_tokens: budget.max_tokens > 0 ? budget.max_tokens : null,
          wall_clock_deadline: wallClockDeadline,
        },
        budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0 },
        workflowType: stepType ?? "work",
      },
      baseDir,
    );

    return id;
  }

  function list(): SessionListResult {
    const raw = listSessions(baseDir);

    const sessions: SessionSummary[] = raw.sessions.map((entry) => ({
      id: entry.id,
      name: entry.data.name ?? "",
      label: entry.data.label,
      planPath: entry.data.planPath,
      lifecycleState: getLifecycleState(entry.data),
      totalCost: entry.data.totalCost ?? 0,
      lastUpdated: entry.data.lastUpdated,
      createdAt: entry.data.createdAt,
      repo: entry.data.repo,
      branch: entry.data.branch,
    }));

    return { sessions, errors: raw.errors };
  }

  function updateState(id: string, newState: SessionLifecycleState): void {
    const persisted = readOrThrow(id);
    const currentState = getLifecycleState(persisted);

    if (!isValidTransition(currentState, newState)) {
      throw new Error(
        `Invalid state transition: ${currentState} -> ${newState}`,
      );
    }

    updateSession(id, { sessionLifecycleState: newState }, baseDir);

    // --- Worktree lifecycle side-effects (fire-and-forget) ---
    if (worktreeManager) {
      if (newState === "work:active" && currentState === "work:paused") {
        // Resuming from paused — switch to existing worktree
        worktreeManager.switchToSession(id).catch(() => {});
      }
    }
  }

  function trash(id: string): void {
    const persisted = readOrThrow(id);
    const currentState = getLifecycleState(persisted);

    if (!isValidTransition(currentState, "trashed")) {
      throw new Error(
        `Invalid state transition: ${currentState} -> trashed`,
      );
    }

    // Persist lastTrashedAt for grace-period worktree cleanup
    const now = Date.now();
    updateSession(
      id,
      { sessionLifecycleState: "trashed", lastTrashedAt: now },
      baseDir,
    );

    // Notify worktree manager about trash (for cleanup scheduling)
    if (worktreeManager) {
      worktreeManager.trashSession(id);
    }
  }

  function archive(id: string): void {
    updateState(id, "archived");
  }

  function sweepTrashed(): number {
    const { sessions } = listSessions(baseDir);
    let swept = 0;

    for (const entry of sessions) {
      const state = entry.data.sessionLifecycleState;
      if (state !== "trashed") continue;

      // Delete session files + companions
      deleteSessionWithCompanions(entry.id, baseDir);

      // Also clean up worktree if available
      if (worktreeManager) {
        worktreeManager.cleanupTrashed(entry.id).catch(() => {});
      }

      swept++;
    }

    return swept;
  }

  function recoverStaleSessions(): number {
    const { sessions } = listSessions(baseDir);
    let recovered = 0;

    for (const entry of sessions) {
      const state = entry.data.sessionLifecycleState;
      if (state !== "work:active") continue;

      // This session was work:active on disk but has no running queue
      // (since we just started up). Transition to work:paused.
      try {
        updateSession(entry.id, { sessionLifecycleState: "work:paused" }, baseDir);
        log.info("recovered stale session", { session: entry.data.name || entry.id, to: "work:paused" });
        recovered++;
      } catch {
        // Non-fatal — skip sessions that fail to update
      }
    }

    return recovered;
  }

  return {
    create,
    list,
    updateState,
    trash,
    archive,
    sweepTrashed,
    recoverStaleSessions,
  };
}
