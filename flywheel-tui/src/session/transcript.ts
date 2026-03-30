// ---------------------------------------------------------------------------
// Transcript Logger — append-only JSONL per session
// ---------------------------------------------------------------------------
//
// The transcript is the persistent, complete record of everything that happens
// in a session. It survives stage transitions, pause/resume, and is only
// cleaned up when the session is deleted.
//
// Each line is a JSON object with:
//   { ts: ISO string, type: string, ...payload }
//
// Event sources:
//   1. EventBus catch-all — all FlywheelEvents (worker output, dispatcher,
//      evaluator, queue lifecycle, approvals, questions, budget)
//   2. Direct logEntry() calls — assembled prompts, handoff data, eval
//      results, and other non-bus events
//
// File: .flywheel/sessions/<sessionId>.transcript.jsonl
//
// The transcript is append-only. It uses buffered writes (flush every 1s or
// on dispose) to avoid excessive I/O during high-throughput worker output.
// ---------------------------------------------------------------------------

import * as fs from "node:fs";
import type { FlywheelEvent } from "../events/types.js";
import type { EventBus, Unsubscribe } from "../events/event-bus.js";
import { resolveSessionFile, ensureSessionDir } from "../config/paths.js";
import { Log } from "../utils/log.js";

const log = Log.create({ service: "transcript" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A transcript entry. All fields beyond ts/type are event-specific. */
export interface TranscriptEntry {
  /** ISO-8601 timestamp */
  ts: string;
  /** Event type (FlywheelEvent.type or custom like "prompt:assembled") */
  type: string;
  /** Arbitrary payload */
  [key: string]: unknown;
}

export interface TranscriptLoggerOptions {
  /** Session ID — determines the file path */
  sessionId: string;
  /** Base directory (defaults to cwd) */
  baseDir?: string;
  /** Flush interval in ms (default: 1000) */
  flushIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// TranscriptLogger
// ---------------------------------------------------------------------------

export class TranscriptLogger {
  private filePath: string;
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeBus: Unsubscribe | null = null;
  private disposed = false;
  private fd: number | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(private options: TranscriptLoggerOptions) {
    const baseDir = options.baseDir ?? process.cwd();
    this.filePath = resolveSessionFile(options.sessionId, "transcript", baseDir);

    // Ensure session directory exists
    try {
      ensureSessionDir(options.sessionId, baseDir);
    } catch {
      // Best effort
    }

    // Open file in append mode
    try {
      this.fd = fs.openSync(this.filePath, "a");
    } catch (err) {
      log.error("failed to open transcript file", {
        path: this.filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Start flush timer
    const intervalMs = options.flushIntervalMs ?? 1000;
    this.flushTimer = setInterval(() => this.flush(), intervalMs);

    log.info("transcript started", {
      session: options.sessionId,
      path: this.filePath,
    });
  }

  /**
   * Subscribe to an EventBus and log all events.
   * Returns the unsubscribe function (also called on dispose).
   */
  subscribeTo(bus: EventBus): Unsubscribe {
    this.unsubscribeBus = bus.subscribe((event: FlywheelEvent) => {
      this.logEvent(event);
    });
    return this.unsubscribeBus;
  }

  /**
   * Log a FlywheelEvent from the event bus.
   */
  logEvent(event: FlywheelEvent): void {
    if (this.disposed) return;

    // Extract timestamp from the event (various formats across event types)
    const ts = extractTimestamp(event);

    // Serialize the full event — spread all fields
    const entry: TranscriptEntry = {
      ts,
      ...event,
    };

    this.appendLine(entry);
  }

  /**
   * Log a custom entry not from the event bus.
   * Use for prompts, handoff data, eval results, etc.
   */
  logEntry(type: string, payload: Record<string, unknown>): void {
    if (this.disposed) return;

    const entry: TranscriptEntry = {
      ts: new Date().toISOString(),
      type,
      ...payload,
    };

    this.appendLine(entry);
  }

  /**
   * Flush buffered lines to disk synchronously.
   */
  flush(): void {
    if (this.buffer.length === 0 || this.fd === null) return;

    const lines = this.buffer.join("");
    this.buffer = [];

    try {
      fs.writeSync(this.fd, lines);
    } catch (err) {
      log.warn("transcript write failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Stop the logger and flush remaining data.
   * The file remains on disk for the session's lifetime.
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Unsubscribe from event bus
    if (this.unsubscribeBus) {
      this.unsubscribeBus();
      this.unsubscribeBus = null;
    }

    // Stop flush timer
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush (must happen before closing fd)
    this.flush();

    // Close file descriptor
    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // Best effort
      }
      this.fd = null;
    }

    log.info("transcript stopped", { session: this.options.sessionId });
  }

  /**
   * Get the file path of the transcript.
   */
  getFilePath(): string {
    return this.filePath;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private appendLine(entry: TranscriptEntry): void {
    try {
      const line = JSON.stringify(entry) + "\n";
      this.buffer.push(line);
    } catch {
      // JSON serialization failure — skip this entry
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract a timestamp from a FlywheelEvent.
 * Events use inconsistent timestamp formats (ISO string vs epoch number).
 */
function extractTimestamp(event: FlywheelEvent): string {
  const ts = (event as unknown as Record<string, unknown>).timestamp;
  if (typeof ts === "string") return ts;
  if (typeof ts === "number") return new Date(ts).toISOString();
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a TranscriptLogger for a session.
 */
export function createTranscriptLogger(
  options: TranscriptLoggerOptions,
): TranscriptLogger {
  return new TranscriptLogger(options);
}

// ---------------------------------------------------------------------------
// Cleanup — called when a session is deleted/trashed
// ---------------------------------------------------------------------------

/**
 * Delete the transcript file for a session.
 * Called when the session is permanently deleted.
 */
export function deleteTranscript(sessionId: string, baseDir?: string): void {
  const dir = baseDir ?? process.cwd();
  const filePath = resolveSessionFile(sessionId, "transcript", dir);
  try {
    fs.unlinkSync(filePath);
    log.info("transcript deleted", { session: sessionId });
  } catch {
    // File may not exist — that's fine
  }
}
