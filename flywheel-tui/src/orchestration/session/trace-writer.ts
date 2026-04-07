/**
 * Trace Writer
 *
 * Persists completed spans to JSONL trace files and maintains an atomic
 * trace index. Provides rotation to bound disk usage, preserving error
 * traces longer than successful ones.
 *
 * Design follows the SubprocessLogger pattern for fd-append writes and
 * the BudgetTracker pattern for in-memory buffering with debounced flush.
 *
 * Single-threaded assumption: Bun's event loop serializes buffer drains
 * and lifecycle updates — no locking needed. Do NOT use Worker threads
 * for this component.
 *
 * Usage:
 *   const writer = createTraceWriter({ sessionId, baseDir });
 *   writer.writeSpan(span);        // buffer a span
 *   writer.flush();                 // force-write buffered spans
 *   writer.finalizeTrace(summary);  // write index entry + rotate
 *   writer.dispose();               // flush + close fd + cancel timers
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { TRACES_DIR, ensureTracesDir, resolveTraceFile, resolveTranscriptFile } from "../../infra/paths";
import { writeFileAtomic } from "../../workflows/shared/atomic-write";
import { createBufferedFileWriter, DEFAULT_DEBOUNCE_MS } from "./buffered-file-writer";
import type { Span } from "../../infra/trace-types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TraceIndexEntry {
  traceId: string;
  sessionId: string;
  workflowName: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: "ok" | "error";
  spanCount: number;
  closedSpanCount: number;
}

export interface TraceWriterDeps {
  sessionId: string;
  baseDir: string;
  /** Maximum number of traces to keep in the index. Default: 100 */
  maxTraces?: number;
  /** Debounce interval in ms for buffered writes. Default: 100ms */
  debounceMs?: number;
}

export interface TraceWriter {
  /** Append a completed span to the trace file (buffered). */
  writeSpan(span: Span): void;
  /** Update the trace index with final summary. Call once per trace completion. */
  finalizeTrace(summary: TraceIndexEntry): void;
  /** Force-write all buffered spans to disk. */
  flush(): void;
  /** Flush + close fd + cancel timers. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveIndexFile(baseDir: string): string {
  return path.resolve(baseDir, TRACES_DIR, "index.jsonl");
}

function readIndex(baseDir: string): TraceIndexEntry[] {
  const indexPath = resolveIndexFile(baseDir);
  if (!fs.existsSync(indexPath)) return [];
  try {
    const content = fs.readFileSync(indexPath, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TraceIndexEntry);
  } catch {
    return [];
  }
}

function writeIndex(baseDir: string, entries: TraceIndexEntry[]): void {
  const indexPath = resolveIndexFile(baseDir);
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
  writeFileAtomic(indexPath, content);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TRACES = 100;

export function createTraceWriter(deps: TraceWriterDeps): TraceWriter {
  const {
    sessionId,
    baseDir,
    maxTraces = DEFAULT_MAX_TRACES,
    debounceMs = DEFAULT_DEBOUNCE_MS,
  } = deps;

  // Ensure traces directory exists
  ensureTracesDir(baseDir);

  // Buffered span writer (fd-append + debounce)
  const writer = createBufferedFileWriter<Span>({
    filePath: resolveTraceFile(sessionId, baseDir),
    serialize: (spans) => spans.map((s) => JSON.stringify(s) + "\n").join(""),
    debounceMs,
  });

  function writeSpan(span: Span): void {
    writer.push(span);
  }

  function finalizeTrace(summary: TraceIndexEntry): void {
    // Read existing index, append new entry, rotate, write atomically
    const entries = readIndex(baseDir);
    entries.push(summary);

    // Rotation: if over max, evict oldest non-error traces first
    if (entries.length > maxTraces) {
      rotate(entries);
    }

    writeIndex(baseDir, entries);
  }

  function flush(): void {
    writer.flush();
  }

  function dispose(): void {
    writer.dispose();
  }

  // -------------------------------------------------------------------------
  // Rotation
  // -------------------------------------------------------------------------

  /**
   * Evict oldest non-error traces until entries.length <= maxTraces.
   * Mutates the array in place. Deletes trace files for evicted entries.
   */
  function rotate(entries: TraceIndexEntry[]): void {
    // Sort candidates: non-error traces ordered by startTimeMs ascending (oldest first)
    while (entries.length > maxTraces) {
      // Find oldest non-error entry
      let evictIdx = -1;
      let oldestTime = Infinity;

      for (let i = 0; i < entries.length; i++) {
        if (entries[i].status !== "error" && entries[i].startTimeMs < oldestTime) {
          oldestTime = entries[i].startTimeMs;
          evictIdx = i;
        }
      }

      if (evictIdx === -1) {
        // All remaining are error traces — nothing more to evict
        break;
      }

      const evicted = entries.splice(evictIdx, 1)[0];

      // Delete the trace file and companion transcript file for the evicted entry
      try {
        const filePath = resolveTraceFile(evicted.sessionId, baseDir);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Best-effort deletion
      }
      try {
        const transcriptPath = resolveTranscriptFile(evicted.sessionId, baseDir);
        if (fs.existsSync(transcriptPath)) {
          fs.unlinkSync(transcriptPath);
        }
      } catch {
        // Best-effort — companion .ndjson may not exist for old traces
      }
    }
  }

  return {
    writeSpan,
    finalizeTrace,
    flush,
    dispose,
  };
}
