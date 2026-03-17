/**
 * Session Manager
 *
 * Coordinates session lifecycle: persistence, state machine validation,
 * and runtime WorkflowSession creation/destruction.
 *
 * Uses factory function pattern (`createSessionManager(deps)`) with
 * dependency injection for testability. Wraps (not replaces) the existing
 * `createWorkflowSession`/`destroyWorkflowSession` from workflow-session.ts.
 *
 * Historical sessions are returned as plain `SessionSummary` objects,
 * NOT live UIActions stores.
 */

import {
  createSession as persistCreateSession,
  readSession,
  updateSession,
  listSessions,
  type SessionListResult as PersistenceListResult,
} from "./persistence";
import { isValidTransition, type SessionLifecycleState } from "./state-machine";
import type { WorkflowSession } from "../tui/components/workflow-session";
import type { WorktreeManager as IWorktreeManager } from "./worktree-manager";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Plain data summary of a session (no live store/adapter). */
export interface SessionSummary {
  id: string;
  name: string;
  planPath: string;
  lifecycleState: SessionLifecycleState;
  currentPhase: number;
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
  createWorkflowSessionFn: (planPath: string) => WorkflowSession;
  destroyWorkflowSessionFn: (session: WorkflowSession) => void;
  /** Optional worktree manager for git worktree lifecycle integration. */
  worktreeManager?: IWorktreeManager;
}

/** The SessionManager interface. */
export interface SessionManager {
  /** Create a new session and persist it. Returns session ID. */
  create(planPath: string, name?: string): string;

  /** Resume a session from disk. Creates a live WorkflowSession. */
  resume(id: string): WorkflowSession | null;

  /** List all sessions as summaries. */
  list(): SessionListResult;

  /** Update session lifecycle state with validation. */
  updateState(id: string, newState: SessionLifecycleState): void;

  /** Transition session to trashed state. */
  trash(id: string): void;

  /** Transition session to archived state. */
  archive(id: string): void;

  /** Get the currently active workflow session (if any). */
  getActiveSession(): WorkflowSession | null;

  /** Destroy the active session's runtime (stop adapter, disconnect). */
  destroyActive(): void;
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
  const { baseDir, createWorkflowSessionFn, destroyWorkflowSessionFn, worktreeManager } = deps;

  let activeSession: WorkflowSession | null = null;

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

  function create(planPath: string, name?: string): string {
    const now = new Date().toISOString();

    const id = persistCreateSession(
      {
        planPath,
        statePath: `.flywheel/state/${crypto.randomUUID()}.state.md`,
        contextPath: `.flywheel/context/${crypto.randomUUID()}.ctx.md`,
        currentPhase: 0,
        lastUpdated: now,
        workflowId: crypto.randomUUID(),
        sessionLifecycleState: "new" as SessionLifecycleState,
        name,
        createdAt: now,
      },
      baseDir,
    );

    return id;
  }

  function resume(id: string): WorkflowSession | null {
    const persisted = readSession(id, baseDir);
    if (persisted === null) {
      return null;
    }

    // Destroy any existing active session first
    if (activeSession !== null) {
      destroyWorkflowSessionFn(activeSession);
      activeSession = null;
    }

    // Create a live workflow session via the injected factory
    const session = createWorkflowSessionFn(persisted.planPath);
    activeSession = session;

    return session;
  }

  function list(): SessionListResult {
    const raw = listSessions(baseDir);

    const sessions: SessionSummary[] = raw.sessions.map((entry) => ({
      id: entry.id,
      name: entry.data.name ?? "",
      planPath: entry.data.planPath,
      lifecycleState: getLifecycleState(entry.data),
      currentPhase: entry.data.currentPhase,
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

  function getActiveSession(): WorkflowSession | null {
    return activeSession;
  }

  function destroyActive(): void {
    if (activeSession === null) {
      return;
    }

    destroyWorkflowSessionFn(activeSession);
    activeSession = null;
  }

  return {
    create,
    resume,
    list,
    updateState,
    trash,
    archive,
    getActiveSession,
    destroyActive,
  };
}
