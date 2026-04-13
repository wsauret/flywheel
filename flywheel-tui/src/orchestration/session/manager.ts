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
import type { Session } from "./schemas";
import { toBudgetLimits } from "../../workflows/schemas";
import { computeContextPercent } from "./budget-tracker-types.js";
import { isValidTransition, type SessionState } from "./state-machine";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../config/schema";
import { Log } from "../../infra/log";

const log = Log.create({ service: "session.manager" });

// Types

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
  contextPercent: number;
  lastUpdated: string;
  createdAt?: string;
  repo?: string;
  branch?: string;
  /** Claude Code session ID — for chat --resume. */
  claudeSessionId?: string;
}

/** Result of listing sessions — mirrors persistence shape but with summaries. */
export interface SessionListResult {
  sessions: SessionSummary[];
  errors: PersistenceListResult["errors"];
}

/** Dependencies injected into the session manager. */
export interface SessionManagerDeps {
  baseDir: string;
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

}

// Factory

/**
 * Create a new SessionManager instance.
 *
 * @param deps - Injected dependencies (baseDir, workflow session functions).
 */
export function createSessionManager(deps: SessionManagerDeps): SessionManager {
  const { baseDir } = deps;
  const config = deps.config ?? CONFIG_DEFAULTS;

  // Helpers

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

  // SessionManager methods

  function create(planPath: string, name?: string, kind?: SessionKind, initialState?: SessionState): string {
    const now = new Date().toISOString();
    const budget = config.budget;

    const state = initialState ?? "active";

    const sharedFields = {
      label: name ?? planPath,
      lastUpdated: now,
      state,
      name: name ?? "",
      createdAt: now,
      totalCost: 0,
      budgetLimits: toBudgetLimits(budget),
      budgetUsage: { invocations_used: 0, tokens_used: 0, cost_usd: 0, context_prompt_tokens: 0, context_window: 0 },
    };

    const sessionData: Session = kind === "chat"
      ? { ...sharedFields, kind: "chat", command: "chat" } satisfies Session
      : { ...sharedFields, kind: "workflow", command: "work", planPath } satisfies Session;

    const id = persistCreateSession(sessionData, baseDir);

    return id;
  }

  function list(): SessionListResult {
    const raw = listSessions(baseDir);

    const sessions: SessionSummary[] = raw.sessions.map((entry) => {
      const state = entry.data.state;

      return {
        id: entry.id,
        name: entry.data.name,
        label: entry.data.label,
        planPath: entry.data.kind === "workflow" ? entry.data.planPath : undefined,
        state: state,
        kind: entry.data.kind,
        command: entry.data.command,
        totalCost: entry.data.totalCost || entry.data.budgetUsage?.cost_usd || 0,
        totalTokens: entry.data.budgetUsage?.tokens_used ?? 0,
        contextPercent: computeContextPercent(
          entry.data.budgetUsage?.context_prompt_tokens ?? 0,
          entry.data.budgetUsage?.context_window ?? 0,
        ),
        lastUpdated: entry.data.lastUpdated,
        createdAt: entry.data.createdAt,
        repo: entry.data.repo,
        branch: entry.data.branch,
        claudeSessionId: entry.data.kind === "chat" ? entry.data.claudeSessionId : undefined,
      };
    });

    return { sessions, errors: raw.errors };
  }

  function updateState(id: string, newState: SessionState): void {
    const persisted = readOrThrow(id);
    const currentState = persisted.state;

    if (currentState === newState) return;

    if (!isValidTransition(currentState, newState)) {
      throw new Error(
        `Invalid state transition: ${currentState} -> ${newState}`,
      );
    }

    updateSession(id, { state: newState }, baseDir);
  }

  function updateLabel(id: string, label: string): void {
    try {
      updateSession(id, { label, name: label }, baseDir);
    } catch {
      // Non-fatal — label update failure shouldn't crash anything
    }
  }

  function deleteSession(id: string): void {
    deleteSessionWithCompanions(id, baseDir);
  }

  function recoverStaleSessions(): number {
    const { sessions } = listSessions(baseDir);
    let recovered = 0;

    for (const entry of sessions) {
      const state = entry.data.state;

      // Only active sessions with no running queue need recovery
      if (state !== "active") continue;

      try {
        updateState(entry.id, "paused");
        log.info("recovered stale session", { session: entry.data.name || entry.id, to: "paused" });
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
    updateLabel,
    delete: deleteSession,
    recoverStaleSessions,
  };
}
