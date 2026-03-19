/**
 * Session Orchestrator
 *
 * Extracts lifecycle orchestration logic out of the shell: resume,
 * auto-archive, and delete operations. All dependencies are
 * injected via factory function — NO direct imports of shell/session/TUI.
 *
 * Factory pattern matching `createSessionManager(deps)`, `createWorktreeManager(deps)`.
 *
 * Usage:
 *   const orchestrator = createSessionOrchestrator({
 *     readSession, createOutputPersistence, fromSnapshot,
 *     manager, worktreeManager, refreshList,
 *   });
 *   const result = await orchestrator.handleResumeSession(sessionId);
 */

import type { OutputSnapshot } from "../../schemas/output";
import type { CliSession } from "../../schemas/session";
import type { DeleteResult } from "../../session/persistence";
import type { PipelineStageResult } from "../../controller/workflow-pipeline";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by handleResumeSession. */
export interface ResumeResult {
  session: CliSession;
  outputBlocks: OutputSnapshot[];
  planPath: string;
  statePath: string;
  worktreePath?: string;
}

/** Minimal OutputPersistence interface — only the load we need. */
interface OutputPersistenceReader {
  load(): Promise<OutputSnapshot[]>;
}

/** Minimal SessionManager interface — only the methods we need. */
interface ManagerSubset {
  updateState(id: string, newState: string): void;
  trash(id: string): void;
  archive(id: string): void;
}

/** Minimal WorktreeManager interface — only the methods we need. */
interface WorktreeManagerSubset {
  removeForSession(id: string): Promise<void>;
  cleanupTrashed(id: string): Promise<boolean>;
}

/** Dependencies injected into the session orchestrator. */
export interface SessionOrchestratorDeps {
  /** Read a session from disk by ID. Returns null if not found. */
  readSession: (id: string) => CliSession | null;

  /** Factory to create an output persistence reader for a given session. */
  createOutputPersistence: (sessionId: string) => OutputPersistenceReader;

  /** Validate and filter raw snapshot data. */
  fromSnapshot: (snapshots: unknown[]) => OutputSnapshot[];

  /** Session manager for state transitions. */
  manager: ManagerSubset;

  /** Optional worktree manager for git worktree lifecycle. */
  worktreeManager?: WorktreeManagerSubset;

  /** Callback to refresh the session list in the UI. */
  refreshList: () => void;

  /**
   * Delete session files and companions from disk.
   * Returns `{ deleted, errors }` for partial failure reporting.
   */
  deleteSessionFiles?: (id: string, activeSessionId?: string | null) => DeleteResult;
}

/** The SessionOrchestrator interface. */
export interface SessionOrchestrator {
  /** Resume a session: load from disk, restore output blocks. */
  handleResumeSession(sessionId: string): Promise<ResumeResult | null>;

  /** Auto-archive: transition to completed, optionally archive if ship stage completed. */
  handleAutoArchive(
    sessionId: string,
    stageResults: PipelineStageResult[],
  ): Promise<void>;

  /** Delete a session: trash, cleanup worktree, refresh list. */
  handleDeleteSession(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a new SessionOrchestrator instance.
 *
 * @param deps - Injected dependencies (no direct module imports).
 */
export function createSessionOrchestrator(
  deps: SessionOrchestratorDeps,
): SessionOrchestrator {
  const {
    readSession,
    createOutputPersistence,
    fromSnapshot,
    manager,
    worktreeManager,
    refreshList,
  } = deps;

  // -------------------------------------------------------------------------
  // Methods
  // -------------------------------------------------------------------------

  async function handleResumeSession(
    sessionId: string,
  ): Promise<ResumeResult | null> {
    // 1. Read session from disk
    const session = readSession(sessionId);
    if (session === null) {
      return null;
    }

    // 2. Load output snapshots
    const persistence = createOutputPersistence(sessionId);
    const rawSnapshots = await persistence.load();

    // 3. Validate via fromSnapshot
    const outputBlocks = fromSnapshot(rawSnapshots);

    // 4. Return structured result
    return {
      session,
      outputBlocks,
      planPath: session.planPath,
      statePath: session.statePath,
      worktreePath: session.worktreePath,
    };
  }

  async function handleAutoArchive(
    sessionId: string,
    stageResults: PipelineStageResult[],
  ): Promise<void> {
    // 1. Always transition to completed
    manager.updateState(sessionId, "completed");

    // 2. Check if ship stage is present and completed
    const shipResult = stageResults.find((r) => r.workflow === "ship");
    const shouldArchive = shipResult !== undefined && shipResult.completed;

    if (shouldArchive) {
      // 3. Archive the session
      manager.archive(sessionId);

      // 4. Clean up worktree (optional)
      if (worktreeManager) {
        await worktreeManager.removeForSession(sessionId);
      }
    }

    // 5. Always refresh the session list
    refreshList();
  }

  async function handleDeleteSession(sessionId: string): Promise<void> {
    // 1. Trash the session (state transition)
    manager.trash(sessionId);

    // 2. Clean up worktree (optional)
    if (worktreeManager) {
      await worktreeManager.cleanupTrashed(sessionId);
    }

    // 3. Delete session files + companions from disk
    if (deps.deleteSessionFiles) {
      deps.deleteSessionFiles(sessionId);
    }

    // 4. Refresh the session list
    refreshList();
  }

  return {
    handleResumeSession,
    handleAutoArchive,
    handleDeleteSession,
  };
}
