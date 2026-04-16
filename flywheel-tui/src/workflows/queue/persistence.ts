import * as fs from "node:fs";
import { writeFileAtomic } from "../../infra/atomic-write.js";
import { createDebouncedWriter } from "../../infra/debounced-writer.js";
import { resolveSessionFile } from "../../infra/paths.js";
import type { Queue } from "./types.js";
import type { AccumulatorState } from "./context-accumulator.js";

const DEFAULT_FLUSH_INTERVAL_MS = 500;

interface QueuePersistenceDeps {
  /** Session ID — used to derive the file path. */
  sessionId: string;
  /** Base directory (project cwd). Defaults to ".". */
  baseDir?: string;
  /** When false, save/load are no-ops. Defaults to true. */
  persistQueue?: boolean;
}

interface QueueFlusherOpts {
  /** Debounce interval in ms. Default: 500. */
  intervalMs?: number;
}

interface QueueFlusher {
  /** Schedule a debounced write of the given queue state. */
  schedule(queue: Queue): void;
  /** Force-flush immediately. */
  flush(): Promise<void>;
  /** Cancel timers. Does NOT flush. */
  dispose(): void;
}

interface QueuePersistence {
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

// Crash recovery — revert running steps to pending so they retry on resume

function applyCrashRecovery(queue: Queue): void {
  const runningStepIds: string[] = [];

  for (const step of queue.steps) {
    if (step.status === "running") {
      step.status = "pending";
      runningStepIds.push(step.id);
    }
  }

  if (runningStepIds.length > 0) {
    queue.mutationLog.push({
      timestamp: Date.now(),
      action: "crash-recovery",
      actor: "persistence",
      reason: "crash recovery: step was running when process exited — reverted to pending for retry",
      stepIds: runningStepIds,
    });
  }
}

export function createQueuePersistence(deps: QueuePersistenceDeps): QueuePersistence {
  const {
    sessionId,
    baseDir = ".",
    persistQueue = true,
  } = deps;

  function queueFilePath() {
    return resolveSessionFile(sessionId, "queue", baseDir);
  }

  function accumulatorFilePath() {
    return resolveSessionFile(sessionId, "context", baseDir);
  }

  function save(queue: Queue) {
    if (!persistQueue) return;

    const json = JSON.stringify(queue);
    writeFileAtomic(queueFilePath(), json);
  }

  async function readJsonFile<T>(filePath: string, validate: (v: unknown) => v is T): Promise<T | null> {
    if (!persistQueue) return null;
    try {
      const file = Bun.file(filePath);
      if (!await file.exists()) return null;
      const parsed = JSON.parse(await file.text());
      return validate(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async function load(): Promise<Queue | null> {
    const queue = await readJsonFile<Queue>(
      queueFilePath(),
      (v): v is Queue => v != null && Array.isArray((v as Queue).steps),
    );
    if (queue) applyCrashRecovery(queue);
    return queue;
  }

  async function del() {
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
      // Reachable via config queue.persist_queue=false or FLYWHEEL_QUEUE_PERSIST_QUEUE=false.
      return {
        schedule(): void {},
        flush(): Promise<void> {
          return Promise.resolve();
        },
        dispose(): void {},
      };
    }

    return createDebouncedWriter<Queue>(
      async (queue) => { save(queue); },
      { intervalMs: opts?.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS },
    );
  }

  function saveAccumulatorState(state: AccumulatorState) {
    if (!persistQueue) return;
    const json = JSON.stringify(state);
    writeFileAtomic(accumulatorFilePath(), json);
  }

  async function loadAccumulatorState(): Promise<AccumulatorState | null> {
    return readJsonFile<AccumulatorState>(
      accumulatorFilePath(),
      (v): v is AccumulatorState => v != null && Array.isArray((v as AccumulatorState).entries),
    );
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
