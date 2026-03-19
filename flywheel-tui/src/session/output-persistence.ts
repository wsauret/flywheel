/**
 * Output Persistence
 *
 * Persists structured output blocks to `.flywheel/sessions/<id>.output.json`.
 * Factory pattern matching `createCostTracker`, `createSessionManager`, etc.
 *
 * Features:
 * - Atomic writes via writeFileAtomic
 * - Async reads via Bun.file().text()
 * - Zod validation on load (graceful degradation)
 * - Size cap with oldest-block truncation
 * - Debounced flusher via createDebouncedWriter
 *
 * Usage:
 *   const persistence = createOutputPersistence({ sessionId, baseDir });
 *   persistence.save(blocks);
 *   const loaded = await persistence.load();
 *   const flusher = persistence.createFlusher(() => getBlocks());
 */

import * as path from "node:path";
import * as fs from "node:fs";
import { writeFileAtomic } from "../utils/atomic-write";
import {
  toSnapshot,
  fromSnapshot,
  type OutputSnapshot,
} from "../schemas/output";
import {
  createDebouncedWriter,
  type DebouncedWriter,
} from "../utils/debounced-writer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SESSIONS_DIR = ".flywheel/sessions";
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const DEFAULT_FLUSH_INTERVAL_MS = 5000; // 5 seconds

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutputPersistenceDeps {
  sessionId: string;
  baseDir?: string;
  maxSizeBytes?: number;
}

export interface OutputFlusherOpts {
  intervalMs?: number;
}

export interface OutputFlusher {
  /** Schedule a debounced flush. */
  schedule(): void;
  /** Force-flush immediately. */
  flush(): Promise<void>;
  /** Cancel timers. Does NOT flush. */
  dispose(): void;
}

export interface OutputPersistence {
  /** Save blocks to disk (synchronous atomic write). */
  save(blocks: AnyBlockLike[]): void;
  /** Load blocks from disk (async via Bun.file). Returns [] on missing/corrupt. */
  load(): Promise<OutputSnapshot[]>;
  /** Delete the output file. Returns true if deleted, false if not found. */
  delete(): Promise<boolean>;
  /** Create a debounced flusher that calls save() with getBlocks() on each tick. */
  createFlusher(getBlocks: () => AnyBlockLike[], opts?: OutputFlusherOpts): OutputFlusher;
}

/** Loose block shape — avoids importing TUI types. */
interface AnyBlockLike {
  kind: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOutputPersistence(deps: OutputPersistenceDeps): OutputPersistence {
  const { sessionId, baseDir = ".", maxSizeBytes = DEFAULT_MAX_SIZE_BYTES } = deps;

  function outputFilePath(): string {
    return path.join(baseDir, SESSIONS_DIR, `${sessionId}.output.json`);
  }

  function save(blocks: AnyBlockLike[]): void {
    const snapshots = toSnapshot(blocks);
    let json = JSON.stringify(snapshots);

    // Size cap: truncate oldest blocks (from beginning) if over limit
    if (json.length > maxSizeBytes) {
      let truncated = [...snapshots];
      while (truncated.length > 1) {
        truncated.shift(); // remove oldest
        json = JSON.stringify(truncated);
        if (json.length <= maxSizeBytes) break;
      }
    }

    writeFileAtomic(outputFilePath(), json);
  }

  async function load(): Promise<OutputSnapshot[]> {
    const filePath = outputFilePath();

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) return [];

      const raw = await file.text();
      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed)) return [];

      return fromSnapshot(parsed);
    } catch {
      // Corrupt file, missing file, parse error — return empty
      return [];
    }
  }

  async function del(): Promise<boolean> {
    const filePath = outputFilePath();
    try {
      if (!fs.existsSync(filePath)) return false;
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  function createFlusher(
    getBlocks: () => AnyBlockLike[],
    opts?: OutputFlusherOpts,
  ): OutputFlusher {
    const intervalMs = opts?.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    const writer = createDebouncedWriter<void>(
      async () => {
        const blocks = getBlocks();
        save(blocks);
      },
      { intervalMs },
    );

    return {
      schedule(): void {
        writer.schedule(undefined as unknown as void);
      },
      flush(): Promise<void> {
        return writer.flush();
      },
      dispose(): void {
        writer.dispose();
      },
    };
  }

  return {
    save,
    load,
    delete: del,
    createFlusher,
  };
}
