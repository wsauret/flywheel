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
import { TRACES_DIR, resolveTranscriptFile } from "../../infra/paths";
import { createBufferedFileWriter, DEFAULT_DEBOUNCE_MS } from "./buffered-file-writer";
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

export function createTranscriptWriter(deps: TranscriptWriterDeps): TranscriptWriter {
  const { sessionId, baseDir, debounceMs = DEFAULT_DEBOUNCE_MS } = deps;

  // Ensure traces directory exists
  const tracesDir = path.resolve(baseDir, TRACES_DIR);
  fs.mkdirSync(tracesDir, { recursive: true });

  // Buffered line writer (fd-append + debounce)
  const writer = createBufferedFileWriter<string>({
    filePath: resolveTranscriptFile(sessionId, baseDir),
    serialize: (lines) => lines.map((line) => line + "\n").join(""),
    debounceMs,
  });

  let eventCount = 0;

  function handleEvent(event: NDJSONEvent): void {
    if (!event.raw) return;
    writer.push(event.raw);
    eventCount++;
  }

  function dispose(): void {
    writer.dispose();
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
