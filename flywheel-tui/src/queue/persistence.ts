/**
 * Queue Persistence
 *
 * Persists queue state to `.flywheel/sessions/<id>.queue.json`.
 * Factory pattern matching `createOutputPersistence` in output-persistence.ts.
 *
 * Features:
 * - Atomic writes via writeFileAtomic (write→fsync→rename)
 * - Async reads via Bun.file().text()
 * - Zod validation on load (graceful degradation — returns null on failure)
 * - Crash recovery: running steps automatically marked failed on load
 * - Debounced flusher via createDebouncedWriter
 * - persist_queue=false makes save/load no-ops
 *
 * Usage:
 *   const persistence = createQueuePersistence({ sessionId, baseDir });
 *   persistence.save(queue);
 *   const loaded = await persistence.load();
 *   const flusher = persistence.createFlusher({ intervalMs: 500 });
 *   flusher.schedule(queue);
 *   await flusher.flush();
 *   flusher.dispose();
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { writeFileAtomic } from "../utils/atomic-write";
import { QueueSchema } from "./schemas";
import {
  createDebouncedWriter,
  type DebouncedWriter,
} from "../utils/debounced-writer";
import { SESSIONS_DIR } from "../config/paths";
import type { Queue } from "./types";
import type { AccumulatorState } from "./context-accumulator";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FLUSH_INTERVAL_MS = 500;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface QueuePersistenceDeps {
  /** Session ID — used to derive the file path. */
  sessionId: string;
  /** Base directory (project cwd). Defaults to ".". */
  baseDir?: string;
  /** When false, save/load are no-ops. Defaults to true. */
  persistQueue?: boolean;
}

export interface QueueFlusherOpts {
  /** Debounce interval in ms. Default: 500. */
  intervalMs?: number;
}

export interface QueueFlusher {
  /** Schedule a debounced write of the given queue state. */
  schedule(queue: Queue): void;
  /** Force-flush immediately. */
  flush(): Promise<void>;
  /** Cancel timers. Does NOT flush. */
  dispose(): void;
}

export interface QueuePersistence {
  /** Save queue state to disk (synchronous atomic write). */
  save(queue: Queue): void;
  /** Load queue from disk. Returns null on missing/corrupt/disabled. */
  load(): Promise<Queue | null>;
  /** Delete the queue file. Returns true if deleted, false if not found. */
  delete(): Promise<boolean>;
  /** Create a debounced flusher that saves queue state on a schedule. */
  createFlusher(opts?: QueueFlusherOpts): QueueFlusher;
  /** Save accumulator state alongside queue state. */
  saveAccumulatorState(state: AccumulatorState): void;
  /** Load accumulator state. Returns null on missing/corrupt/disabled. */
  loadAccumulatorState(): Promise<AccumulatorState | null>;
}

// ---------------------------------------------------------------------------
// Crash recovery — mark running steps as failed on load
// ---------------------------------------------------------------------------

function applyCrashRecovery(queue: Queue): void {
  const runningStepIds: string[] = [];

  for (const step of queue.steps) {
    if (step.status === "running") {
      step.status = "failed";
      runningStepIds.push(step.id);
    }
  }

  if (runningStepIds.length > 0) {
    queue.mutationLog.push({
      timestamp: new Date().toISOString(),
      action: "crash-recovery",
      actor: "persistence",
      reason: "crash recovery: step was running when process exited",
      stepIds: runningStepIds,
    });
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createQueuePersistence(deps: QueuePersistenceDeps): QueuePersistence {
  const {
    sessionId,
    baseDir = ".",
    persistQueue = true,
  } = deps;

  function queueFilePath(): string {
    return path.join(baseDir, SESSIONS_DIR, `${sessionId}.queue.json`);
  }

  function accumulatorFilePath(): string {
    return path.join(baseDir, SESSIONS_DIR, `${sessionId}.context.json`);
  }

  function save(queue: Queue): void {
    if (!persistQueue) return;

    const json = JSON.stringify(queue);
    writeFileAtomic(queueFilePath(), json);
  }

  async function load(): Promise<Queue | null> {
    if (!persistQueue) return null;

    const filePath = queueFilePath();

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) return null;

      const raw = await file.text();
      const parsed = JSON.parse(raw);

      // Validate with Zod
      const result = QueueSchema.safeParse(parsed);
      if (!result.success) return null;

      const queue = result.data as Queue;

      // Crash recovery: mark any running steps as failed
      applyCrashRecovery(queue);

      return queue;
    } catch {
      // Corrupt file, parse error, etc. — graceful degradation
      return null;
    }
  }

  async function del(): Promise<boolean> {
    const filePath = queueFilePath();
    try {
      if (!fs.existsSync(filePath)) return false;
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  function createFlusher(opts?: QueueFlusherOpts): QueueFlusher {
    if (!persistQueue) {
      // No-op flusher when persistence is disabled
      return {
        schedule(): void {},
        flush(): Promise<void> {
          return Promise.resolve();
        },
        dispose(): void {},
      };
    }

    const intervalMs = opts?.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    const writer = createDebouncedWriter<Queue>(
      async (queue: Queue) => {
        save(queue);
      },
      { intervalMs },
    );

    return {
      schedule(queue: Queue): void {
        writer.schedule(queue);
      },
      flush(): Promise<void> {
        return writer.flush();
      },
      dispose(): void {
        writer.dispose();
      },
    };
  }

  function saveAccumulatorState(state: AccumulatorState): void {
    if (!persistQueue) return;
    const json = JSON.stringify(state);
    writeFileAtomic(accumulatorFilePath(), json);
  }

  async function loadAccumulatorState(): Promise<AccumulatorState | null> {
    if (!persistQueue) return null;

    const filePath = accumulatorFilePath();
    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) return null;

      const raw = await file.text();
      const parsed = JSON.parse(raw);

      // Basic shape validation: must have entries array
      if (!parsed || !Array.isArray(parsed.entries)) return null;

      return parsed as AccumulatorState;
    } catch {
      return null;
    }
  }

  return {
    save,
    load,
    delete: del,
    createFlusher,
    saveAccumulatorState,
    loadAccumulatorState,
  };
}
