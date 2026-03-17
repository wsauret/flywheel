/**
 * Worktree Manager
 *
 * Manages git worktree lifecycle tied to session state transitions.
 * Uses `IWorktreeClient` interface for testability — default implementation
 * shells out to the `wt` CLI (Worktrunk), mock implementation for tests.
 *
 * Key behaviors:
 * - plan:approved -> work:active  -> createForSession() (creates worktree)
 * - work:active -> work:paused    -> no action (Worktrunk preserves)
 * - work:paused -> work:active    -> switchToSession() (switches to existing)
 * - * -> archived                 -> optionally removeForSession() (configurable)
 * - * -> trashed                  -> trashSession() + cleanupTrashed() with grace period
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
}

/** Zod schema for parsing worktree info from wt CLI output. */
export const WorktreeInfoSchema = z.object({
  path: z.string(),
  branch: z.string(),
  isActive: z.boolean(),
});

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

/** Dependencies injected into the worktree manager. */
export interface WorktreeManagerDeps {
  client: IWorktreeClient;
  /** Whether worktree integration is enabled. */
  enabled: boolean;
  /** Whether to auto-remove worktree on archive. */
  autoRemoveOnArchive: boolean;
  /** Grace period (ms) before trashed worktrees are cleaned up. */
  gracePeriodMs: number;
}

/** Returned by trashSession to persist in the session record. */
export interface TrashInfo {
  lastTrashedAt: number;
  branchName: string;
}

/** The WorktreeManager interface. */
export interface WorktreeManager {
  /** Create a worktree for a session entering work:active. Returns null on failure or disabled. */
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

    const state = sessions.get(sessionId);
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

// ---------------------------------------------------------------------------
// Default IWorktreeClient — shells out to `wt` CLI
// ---------------------------------------------------------------------------

/**
 * Create a production IWorktreeClient that shells out to the `wt` CLI.
 *
 * Uses Bun.spawn for process execution with proper timeout/abort handling.
 * Parses wt output with Zod schemas.
 */
export function createWtClient(opts?: {
  /** Working directory for wt commands. */
  cwd?: string;
  /** Timeout in ms for wt commands. Default: 30_000 (30s). */
  timeoutMs?: number;
}): IWorktreeClient {
  const cwd = opts?.cwd ?? process.cwd();
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  /** Run a wt CLI command and return stdout. */
  async function runWt(args: string[]): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const proc = Bun.spawn(["wt", ...args], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });

      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) {
        const stderr = await new Response(proc.stderr).text();
        throw new Error(`wt ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim()}`);
      }

      return stdout.trim();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async isAvailable(): Promise<boolean> {
      try {
        const resolved = Bun.which("wt");
        return resolved !== null;
      } catch {
        return false;
      }
    },

    async create(branchName: string, baseBranch?: string): Promise<WorktreeInfo> {
      const args = ["switch", "--create", branchName];
      if (baseBranch) args.push(baseBranch);

      const output = await runWt(args);

      // Parse output — wt typically returns the worktree path
      // Fallback: construct from branch name
      return {
        path: output || `${cwd}/.worktrees/${branchName}`,
        branch: branchName,
        isActive: true,
      };
    },

    async switchTo(branchName: string): Promise<WorktreeInfo> {
      const output = await runWt(["switch", branchName]);

      return {
        path: output || `${cwd}/.worktrees/${branchName}`,
        branch: branchName,
        isActive: true,
      };
    },

    async remove(branchName: string, force?: boolean): Promise<void> {
      const args = ["remove", branchName];
      if (force) args.push("--force");
      await runWt(args);
    },

    async list(): Promise<WorktreeInfo[]> {
      const output = await runWt(["list", "--json"]);

      try {
        const parsed = JSON.parse(output);
        const items = z.array(WorktreeInfoSchema).safeParse(parsed);
        if (items.success) return items.data;
      } catch {
        // Fall through to empty list
      }

      return [];
    },
  };
}
