/**
 * Transcript Writer
 *
 * Persists raw NDJSON events from subprocess streams to .ndjson transcript
 * files. Each event's `raw` string is appended as-is, preserving the exact
 * wire format for replay and analysis.
 *
 * Design follows the TraceWriter pattern: fd-append writes with DebouncedWriter
 * for timer scheduling, external buffer management, and batched writeSync calls.
 *
 * Single-threaded assumption: Bun's event loop serializes buffer drains
 * and lifecycle updates — no locking needed.
 *
 * Usage:
 *   const writer = createTranscriptWriter({ sessionId, baseDir });
 *   writer.handleEvent(event);    // buffer a raw NDJSON event
 *   writer.dispose();             // flush + close fd + cancel timers
 *   writer.getEventCount();       // number of events written
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { TRACES_DIR } from "../../infra/paths";
import { createDebouncedWriter } from "../../workflows/shared/debounced-writer";
import type { NDJSONEvent } from "../engines/subprocess/ndjson-parser";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptWriter {
  /** Append a raw NDJSON event to the transcript file (buffered). */
  handleEvent(event: NDJSONEvent): void;
  /** Flush + close fd + cancel timers. Safe to call multiple times. */
  dispose(): void;
  /** Number of events successfully buffered. */
  getEventCount(): number;
}

export interface TranscriptWriterDeps {
  sessionId: string;
  baseDir: string;
  /** Debounce interval in ms for buffered writes. Default: 100ms */
  debounceMs?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 100;

export function createTranscriptWriter(deps: TranscriptWriterDeps): TranscriptWriter {
  const { sessionId, baseDir, debounceMs = DEFAULT_DEBOUNCE_MS } = deps;

  // Ensure traces directory exists
  const tracesDir = path.resolve(baseDir, TRACES_DIR);
  fs.mkdirSync(tracesDir, { recursive: true });

  // Open transcript file for append
  const transcriptFilePath = path.resolve(tracesDir, `${sessionId}.ndjson`);
  const fd = fs.openSync(transcriptFilePath, "a");

  let buffer: string[] = [];
  let disposed = false;
  let eventCount = 0;

  // -------------------------------------------------------------------------
  // Buffer drain (uses shared DebouncedWriter for timer scheduling)
  // -------------------------------------------------------------------------

  function drainBuffer(): void {
    if (buffer.length === 0) return;
    const lines = buffer;
    buffer = [];

    try {
      const content = lines.map((line) => line + "\n").join("");
      fs.writeSync(fd, content);
    } catch {
      // Best-effort — don't crash on write failure (SubprocessLogger precedent)
    }
  }

  const debouncer = createDebouncedWriter<undefined>(async () => {
    drainBuffer();
  }, { intervalMs: debounceMs });

  // -------------------------------------------------------------------------
  // Internal flush (not on public interface)
  // -------------------------------------------------------------------------

  function flush(): void {
    debouncer.dispose();
    drainBuffer();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  function handleEvent(event: NDJSONEvent): void {
    if (disposed) return;
    if (!event.raw) return;

    buffer.push(event.raw);
    eventCount++;
    debouncer.schedule(undefined);
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    flush();

    try {
      fs.closeSync(fd);
    } catch {
      // Ignore close errors
    }
  }

  function getEventCount(): number {
    return eventCount;
  }

  return {
    handleEvent,
    dispose,
    getEventCount,
  };
}
