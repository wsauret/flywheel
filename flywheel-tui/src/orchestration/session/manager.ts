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
import { isValidTransition, type SessionState } from "./state-machine";
import type { WorktreeManager as IWorktreeManager } from "./worktree-manager";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../config/loader";
import { Log } from "../../infra/log";

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
  state: SessionState;
  /** Session kind: workflow or chat. */
  kind: "workflow" | "chat";
  /** The slash command that launched this session. */
  command: string;
  totalCost: number;
  totalTokens: number;
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
  /** Optional worktree manager for git worktree lifecycle integration. */
  worktreeManager?: IWorktreeManager;
  /** Optional config — defaults to CONFIG_DEFAULTS when omitted. */
  config?: FlywheelConfig;
}

import type { SessionKind } from "./types";

/** The SessionManager interface. */
export interface SessionManager {
  /** Create a new session and persist it. Returns session ID. */
  create(planPath: string, name?: string, kind?: SessionKind, initialState?: SessionState): string;

  /** List all sessions as summaries. */
  list(): SessionListResult;

  /** Update session lifecycle state with validation. */
  updateState(id: string, newState: SessionState): void;

  /** Update session label (display name). */
  updateLabel(id: string, label: string): void;

  /**
   * Delete a session: remove files from disk, clear cache, clean up worktree.
   * Immediate and permanent — no trash/archive intermediate state.
   */
  delete(id: string): void;

  /**
   * Recover stale `active` sessions that have no running queue execution.
   * Transitions work sessions to `paused` and chat sessions to `completed`.
   *
   * Intended for startup crash recovery.
   *
   * @returns The number of sessions recovered.
   */
  recoverStaleSessions(): number;

  /**
   * Get the cached state for a session.
   * Returns null if the session is not in the cache.
   */
  getState(id: string): SessionState | null;
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

  // In-memory state cache for O(1) reads
  const stateCache = new Map<string, SessionState>();

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
   * Get the current lifecycle state, defaulting to "active" for legacy sessions.
   */
  function getLifecycleState(
    session: { state?: SessionState },
  ): SessionState {
    return session.state ?? "active";
  }

  // -------------------------------------------------------------------------
  // SessionManager methods
  // -------------------------------------------------------------------------

  function create(planPath: string, name?: string, kind?: SessionKind, initialState?: SessionState): string {
    const now = new Date().toISOString();
    const budget = config.budget;

    // Map config budget to session budget limits:
    // - max_invocations: 0 stays 0 (BudgetTracker treats 0 as unlimited)
    // - max_tokens: 0 → null (unlimited)
    // - max_wall_clock_minutes: 0 → null (unlimited), >0 → ISO deadline
    const wallClockDeadline = budget.max_wall_clock_minutes > 0
      ? new Date(Date.now() + budget.max_wall_clock_minutes * 60_000).toISOString()
      : null;

    const state: SessionState = (initialState ?? "active") as SessionState;

    const id = persistCreateSession(
      {
        label: name ?? planPath,
        planPath,
        lastUpdated: now,
        state,
        name,
        createdAt: now,
        kind: kind === "chat" ? "chat" : "workflow",
        command: kind === "chat" ? "chat" : "work",
        budgetLimits: {
          max_invocations: budget.max_invocations,
          max_tokens: budget.max_tokens > 0 ? budget.max_tokens : null,
          wall_clock_deadline: wallClockDeadline,
        },
        budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0 },
      },
      baseDir,
    );

    // Populate cache
    stateCache.set(id, state);

    return id;
  }

  function list(): SessionListResult {
    const raw = listSessions(baseDir);

    const sessions: SessionSummary[] = raw.sessions.map((entry) => {
      const state = getLifecycleState(entry.data);
      // Populate cache on list
      stateCache.set(entry.id, state);

      return {
        id: entry.id,
        name: entry.data.name ?? "",
        label: entry.data.label,
        planPath: entry.data.planPath,
        state: state,
        kind: entry.data.kind ?? "workflow",
        command: entry.data.command ?? "work",
        totalCost: entry.data.totalCost ?? entry.data.budgetUsage?.cost_usd ?? 0,
        totalTokens: entry.data.budgetUsage?.tokens_used ?? 0,
        lastUpdated: entry.data.lastUpdated,
        createdAt: entry.data.createdAt,
        repo: entry.data.repo,
        branch: entry.data.branch,
      };
    });

    return { sessions, errors: raw.errors };
  }

  function updateState(id: string, newState: SessionState): void {
    const persisted = readOrThrow(id);
    const currentState = getLifecycleState(persisted);

    if (!isValidTransition(currentState, newState)) {
      throw new Error(
        `Invalid state transition: ${currentState} -> ${newState}`,
      );
    }

    updateSession(id, { state: newState }, baseDir);

    // Update cache
    stateCache.set(id, newState);

    // --- Worktree lifecycle side-effects (fire-and-forget) ---
    if (worktreeManager) {
      if (newState === "active" && currentState === "paused") {
        // Resuming from paused — switch to existing worktree
        worktreeManager.switchToSession(id).catch(() => {});
      }
    }
  }

  function updateLabel(id: string, label: string): void {
    try {
      updateSession(id, { label, name: label }, baseDir);
    } catch {
      // Non-fatal — label update failure shouldn't crash anything
    }
  }

  function deleteSession(id: string): void {
    // Delete session files + companions from disk
    deleteSessionWithCompanions(id, baseDir);

    // Remove from cache
    stateCache.delete(id);

    // Clean up worktree if available (fire-and-forget)
    if (worktreeManager) {
      worktreeManager.cleanupTrashed(id).catch(() => {});
    }
  }

  function recoverStaleSessions(): number {
    const { sessions } = listSessions(baseDir);
    let recovered = 0;

    for (const entry of sessions) {
      const state = getLifecycleState(entry.data);

      // Only active sessions with no running queue need recovery
      if (state !== "active") continue;

      // Chat sessions → completed (no resume for chat)
      // Work sessions → paused (can be resumed)
      const isChat = entry.data.kind === "chat";
      const target: SessionState = isChat ? "completed" : "paused";

      try {
        updateState(entry.id, target);
        log.info("recovered stale session", { session: entry.data.name || entry.id, to: target });
        recovered++;
      } catch {
        // Non-fatal — skip sessions that fail to update
      }
    }

    return recovered;
  }

  function getState(id: string): SessionState | null {
    return stateCache.get(id) ?? null;
  }

  return {
    create,
    list,
    updateState,
    updateLabel,
    delete: deleteSession,
    recoverStaleSessions,
    getState,
  };
}
