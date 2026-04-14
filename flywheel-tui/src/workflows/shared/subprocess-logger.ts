/**
 * SubprocessLogger — persistent JSONL logging for subprocess output.
 *
 * Logs all subprocess output (worker, dispatcher, evaluator) to
 * `.flywheel/subprocess-logs/<YYYY-MM-DD>/<role>-<invocationId>.jsonl`
 * or under the session directory when sessionId is provided.
 *
 * Each line is a JSON object:
 *   {"ts":1711234567890,"stream":"stdout","data":"raw chunk text..."}
 *
 * Single consumer (invoke-pooled), but owns its own fd lifecycle (open/write/close)
 * — a distinct responsibility from subprocess invocation orchestration.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SUBPROCESS_LOG_DIR, sessionDir } from "../../infra/paths.js";
export type SubprocessRole = "worker" | "dispatcher" | "evaluator";

interface SubprocessLoggerOptions {
  /** Base directory (project cwd) — logs go under <baseDir>/.flywheel/subprocess-logs/ */
  baseDir: string;
  /** Role of the subprocess being logged. */
  role: SubprocessRole;
  /** Unique invocation identifier. */
  invocationId: string;
  /** Session ID — when provided, logs are colocated under the session directory instead of the global date-based dir. */
  sessionId?: string;
}

export class SubprocessLogger {
  private readonly fd: number;
  private closed = false;

  constructor(options: SubprocessLoggerOptions) {
    const logDir = options.sessionId
      ? path.resolve(options.baseDir, sessionDir(options.sessionId), "logs/subprocess")
      : path.resolve(options.baseDir, SUBPROCESS_LOG_DIR, new Date().toISOString().slice(0, 10));
    fs.mkdirSync(logDir, { recursive: true });

    const logFile = path.join(logDir, `${options.role}-${options.invocationId}.jsonl`);
    this.fd = fs.openSync(logFile, "a");
  }

  /**
   * Append a JSON line for a subprocess output chunk.
   */
  logChunk(stream: "stdout" | "stderr", data: string): void {
    if (this.closed) return;
    try {
      const line = JSON.stringify({ ts: Date.now(), stream, data }) + "\n";
      fs.writeSync(this.fd, line);
    } catch {
      // Best-effort — don't crash the subprocess on log failure
    }
  }

  /**
   * Close the underlying file descriptor.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      fs.closeSync(this.fd);
    } catch {
      // Ignore close errors
    }
  }

}

/**
 * Wrap onStdout/onStderr callbacks to log AND forward to upstream callbacks.
 *
 * Returns a pair of callbacks suitable for passing to subprocess spawn options.
 * If the upstream callback is undefined, only logging occurs.
 */
export function createLoggedCallbacks(
  logger: SubprocessLogger,
  upstream?: {
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  },
): {
  onStdout: (chunk: string) => void;
  onStderr: (chunk: string) => void;
} {
  return {
    onStdout: (chunk: string) => {
      logger.logChunk("stdout", chunk);
      upstream?.onStdout?.(chunk);
    },
    onStderr: (chunk: string) => {
      logger.logChunk("stderr", chunk);
      upstream?.onStderr?.(chunk);
    },
  };
}
