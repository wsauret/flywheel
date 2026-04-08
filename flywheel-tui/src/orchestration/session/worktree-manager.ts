/**
 * Worktree Manager
 *
 * Manages git worktree lifecycle tied to session state transitions.
 * Uses `IWorktreeClient` interface for testability — default implementation
 * shells out to the `wt` CLI (Worktrunk), mock implementation for tests.
 *
 * Key behaviors:
 * - active (new session)          -> createForSession() (creates worktree)
 * - active -> paused              -> no action (Worktrunk preserves)
 * - paused -> active              -> switchToSession() (switches to existing)
 * - * -> completed                -> optionally removeForSession() (configurable)
 * - trash                         -> trashSession() + cleanupTrashed() with grace period
 *
 * Graceful fallback: all operations return null/no-op when wt is unavailable.
 */


import { z } from "zod";

// ---------------------------------------------------------------------------
// IWorktreeClient interface — dependency inversion for testability
// ---------------------------------------------------------------------------

/** Information about a git worktree. */
export interface WorktreeInfo {
  path: string;
  branch: string;
  isActive: boolean;
  /** Commit info (from worktrunk's --format=json). */
  commit?: { sha?: string; short_sha?: string; message?: string; timestamp?: string };
  /** Working tree status (from worktrunk's --format=json). */
  working_tree?: { staged?: number; modified?: number; untracked?: number };
  /** Whether this is the main worktree. */
  is_main?: boolean;
}

/** Zod schema for parsing worktree info from wt CLI output.
 * Accepts both the legacy shape (path, branch, isActive) and
 * worktrunk's richer --format=json output. */
export const WorktreeInfoSchema = z.object({
  path: z.string(),
  branch: z.string(),
  isActive: z.boolean().optional().default(false),
  is_current: z.boolean().optional(),
  is_main: z.boolean().optional(),
  commit: z.object({
    sha: z.string().optional(),
    short_sha: z.string().optional(),
    message: z.string().optional(),
    timestamp: z.string().optional(),
  }).optional(),
  working_tree: z.object({
    staged: z.number().optional(),
    modified: z.number().optional(),
    untracked: z.number().optional(),
  }).optional(),
}).transform((data) => ({
  ...data,
  // Derive isActive from is_current if present (worktrunk format)
  isActive: data.is_current ?? data.isActive ?? false,
}));

/**
 * Abstract interface for worktree operations.
 * Default implementation shells out to `wt` CLI.
 * Mock implementation used in tests.
 */
export interface IWorktreeClient {
  /** Check if the wt CLI is available on the system. */
  isAvailable(): Promise<boolean>;
  /** Create a new worktree for the given branch. */
  create(branchName: string, baseBranch?: string): Promise<WorktreeInfo>;
  /** Switch to an existing worktree. */
  switchTo(branchName: string): Promise<WorktreeInfo>;
  /** Remove a worktree. */
  remove(branchName: string, force?: boolean): Promise<void>;
  /** List all worktrees. */
  list(): Promise<WorktreeInfo[]>;
}

// ---------------------------------------------------------------------------
// WorktreeManager types
// ---------------------------------------------------------------------------

/** Minimal session shape for worktree rehydration (avoids coupling to full Session). */
export interface WorktreeSessionData {
  worktreePath?: string;
  branch?: string;
}

/** Dependencies injected into the worktree manager. */
export interface WorktreeManagerDeps {
  client: IWorktreeClient;
  /** Whether worktree integration is enabled. */
  enabled: boolean;
  /** Whether to auto-remove worktree on archive. */
  autoRemoveOnArchive: boolean;
  /** Grace period (ms) before trashed worktrees are cleaned up. */
  gracePeriodMs: number;
  /** Optional: persist worktreePath/branch to session JSON after creation. */
  updateSession?: (id: string, partial: { worktreePath?: string; branch?: string }) => void;
  /** Optional: read worktreePath/branch from session JSON for lazy rehydration. */
  readSession?: (id: string) => WorktreeSessionData | null;
}

/** Returned by trashSession to persist in the session record. */
export interface TrashInfo {
  lastTrashedAt: number;
  branchName: string;
}

/** The WorktreeManager interface. */
export interface WorktreeManager {
  /** Create a worktree for a session entering active state. Returns null on failure or disabled. */
  createForSession(
    sessionId: string,
    branchName: string,
    baseBranch?: string,
  ): Promise<WorktreeInfo | null>;

  /** Switch to an existing worktree for a session (e.g., resuming from paused). */
  switchToSession(sessionId: string): Promise<WorktreeInfo | null>;

  /** Remove the worktree for a session. Swallows errors. */
  removeForSession(sessionId: string): Promise<void>;

  /** Mark a session as trashed. Returns trash metadata, or null if no worktree tracked. */
  trashSession(sessionId: string): TrashInfo | null;

  /** Clean up a trashed session's worktree if grace period elapsed and not locked. */
  cleanupTrashed(sessionId: string): Promise<boolean>;

  /** Lock a session to prevent cleanup (e.g., during resume). */
  lockSession(sessionId: string): void;

  /** Unlock a session. */
  unlockSession(sessionId: string): void;

  /** Check if the underlying wt client is available. Returns false if disabled. */
  isAvailable(): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Internal tracking state per session
// ---------------------------------------------------------------------------

interface SessionWorktreeState {
  branchName: string;
  lastTrashedAt?: number;
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new WorktreeManager instance.
 *
 * @param deps - Injected dependencies (client, config flags).
 */
export function createWorktreeManager(deps: WorktreeManagerDeps): WorktreeManager {
  const { client, enabled, gracePeriodMs } = deps;

  /** Session ID -> worktree state mapping. */
  const sessions = new Map<string, SessionWorktreeState>();

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function checkAvailable(): Promise<boolean> {
    if (!enabled) return false;
    try {
      return await client.isAvailable();
    } catch {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // WorktreeManager methods
  // -------------------------------------------------------------------------

  async function createForSession(
    sessionId: string,
    branchName: string,
    baseBranch?: string,
  ): Promise<WorktreeInfo | null> {
    if (!(await checkAvailable())) return null;

    try {
      const info = await client.create(branchName, baseBranch);
      sessions.set(sessionId, { branchName, locked: false });

      // Persist worktreePath and branch to session JSON (best effort)
      if (deps.updateSession) {
        try {
          deps.updateSession(sessionId, { worktreePath: info.path, branch: branchName });
        } catch {
          // Non-fatal — worktree was created, just not persisted
        }
      }

      return info;
    } catch {
      // Graceful fallback on failure
      return null;
    }
  }

  async function switchToSession(
    sessionId: string,
  ): Promise<WorktreeInfo | null> {
    if (!(await checkAvailable())) return null;

    let state = sessions.get(sessionId);

    // Lazy rehydration: if Map has no entry, try reading from disk
    if (!state && deps.readSession) {
      try {
        const diskData = deps.readSession(sessionId);
        if (diskData?.worktreePath && diskData?.branch) {
          state = { branchName: diskData.branch, locked: false };
          sessions.set(sessionId, state);
        }
      } catch {
        // Fallback: no rehydration possible
      }
    }

    if (!state) return null;

    try {
      return await client.switchTo(state.branchName);
    } catch {
      return null;
    }
  }

  async function removeForSession(sessionId: string): Promise<void> {
    const state = sessions.get(sessionId);
    if (!state) return;

    // Check availability before attempting removal
    if (!(await checkAvailable())) {
      sessions.delete(sessionId);
      return;
    }

    try {
      await client.remove(state.branchName);
    } catch {
      // Swallow removal errors — best-effort cleanup
    }

    sessions.delete(sessionId);
  }

  function trashSession(sessionId: string): TrashInfo | null {
    const state = sessions.get(sessionId);
    if (!state) return null;

    const now = Date.now();
    state.lastTrashedAt = now;

    return {
      lastTrashedAt: now,
      branchName: state.branchName,
    };
  }

  async function cleanupTrashed(sessionId: string): Promise<boolean> {
    const state = sessions.get(sessionId);
    if (!state) return false;
    if (!state.lastTrashedAt) return false;

    // Gate on lock — prevent race with resume
    if (state.locked) return false;

    // Check grace period
    const elapsed = Date.now() - state.lastTrashedAt;
    if (elapsed < gracePeriodMs) return false;

    // Grace period elapsed and not locked — clean up
    if (!(await checkAvailable())) {
      sessions.delete(sessionId);
      return false;
    }

    try {
      await client.remove(state.branchName);
      sessions.delete(sessionId);
      return true;
    } catch {
      return false;
    }
  }

  function lockSession(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (state) {
      state.locked = true;
    }
  }

  function unlockSession(sessionId: string): void {
    const state = sessions.get(sessionId);
    if (state) {
      state.locked = false;
    }
  }

  async function isAvailable(): Promise<boolean> {
    return checkAvailable();
  }

  return {
    createForSession,
    switchToSession,
    removeForSession,
    trashSession,
    cleanupTrashed,
    lockSession,
    unlockSession,
    isAvailable,
  };
}




