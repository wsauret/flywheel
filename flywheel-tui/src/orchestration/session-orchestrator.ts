/**
 * Session Orchestrator
 *
 * Extracts lifecycle orchestration logic out of the shell: resume
 * operations. All dependencies are injected via factory
 * function — NO direct imports of shell/session/TUI.
 *
 * Factory pattern matching `createSessionManager(deps)`, `createWorktreeManager(deps)`.
 *
 * Usage:
 *   const orchestrator = createSessionOrchestrator({
 *     readSession, createOutputPersistence, fromSnapshot,
 *     manager, refreshList,  // kept in deps interface for caller compatibility
 *   });
 *   const result = await orchestrator.handleResumeSession(sessionId);
 */

import type { OutputSnapshot } from "./session/output-schemas";
import type { Session } from "./session/schemas";
import type { Queue } from "../workflows/queue/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by handleResumeSession. */
export interface ResumeResult {
  session: Session;
  outputBlocks: OutputSnapshot[];
  planPath: string;
  worktreePath?: string;
  /** Queue state loaded from .queue.json. */
  queue: Queue;
}

/** Minimal OutputPersistence interface — only the load we need. */
interface OutputPersistenceReader {
  load(): Promise<OutputSnapshot[]>;
}

/** Minimal QueuePersistence interface — only the load we need. */
interface QueuePersistenceReader {
  load(): Promise<Queue | null>;
}

/** Minimal SessionManager interface — only the methods we need. */
interface ManagerSubset {
  updateState(id: string, newState: string): void;
  delete(id: string): void;
}

/** Dependencies injected into the session orchestrator. */
export interface SessionOrchestratorDeps {
  /** Read a session from disk by ID. Returns null if not found. */
  readSession: (id: string) => Session | null;

  /** Factory to create an output persistence reader for a given session. */
  createOutputPersistence: (sessionId: string) => OutputPersistenceReader;

  /** Factory to create a queue persistence reader for a given session. */
  createQueuePersistence?: (sessionId: string) => QueuePersistenceReader;

  /** Validate and filter raw snapshot data. */
  fromSnapshot: (snapshots: unknown[]) => OutputSnapshot[];

  /** Session manager for state transitions and deletion. */
  manager: ManagerSubset;

  /** Callback to refresh the session list in the UI. */
  refreshList: () => void;
}

/** The SessionOrchestrator interface. */
export interface SessionOrchestrator {
  /** Resume a session: load from disk, restore output blocks. */
  handleResumeSession(sessionId: string): Promise<ResumeResult | null>;
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

    // 4. Load queue state from .queue.json (required)
    let queue: Queue | null = null;
    if (deps.createQueuePersistence) {
      try {
        const queuePersistence = deps.createQueuePersistence(sessionId);
        queue = await queuePersistence.load();
      } catch {
        // Queue file missing or corrupt
      }
    }

    if (!queue) {
      return null;
    }

    // 5. Return structured result
    return {
      session,
      outputBlocks,
      planPath: session.planPath ?? session.label,
      worktreePath: session.worktreePath,
      queue,
    };
  }

  return {
    handleResumeSession,
  };
}
