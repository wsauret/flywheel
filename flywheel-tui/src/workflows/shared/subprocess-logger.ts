/**
 * SubprocessLogger — persistent JSONL logging for subprocess output.
 *
 * Logs all subprocess output (worker, dispatcher, evaluator) to
 * `.flywheel/subprocess-logs/<YYYY-MM-DD>/<role>-<invocationId>.jsonl`
 *
 * Each line is a JSON object:
 *   {"ts":1711234567890,"stream":"stdout","data":"raw chunk text..."}
 *
 * Includes a static cleanup() method to prune date directories older than maxDays.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { SUBPROCESS_LOG_DIR, sessionDir } from "../../infra/paths.js";
import { Log } from "../../infra/log.js";
import { errorMessage } from "../../infra/error-message.js";

const log = Log.create({ service: "subprocess-logger" });

// Types

export type SubprocessRole = "worker" | "dispatcher" | "evaluator";

export interface SubprocessLoggerOptions {
  /** Base directory (project cwd) — logs go under <baseDir>/.flywheel/subprocess-logs/ */
  baseDir: string;
  /** Role of the subprocess being logged. */
  role: SubprocessRole;
  /** Unique invocation identifier. */
  invocationId: string;
  /** Session ID — when provided, logs are colocated under the session directory instead of the global date-based dir. */
  sessionId?: string;
}

// SubprocessLogger

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

  /**
   * Remove date directories older than maxDays.
   *
   * Scans `.flywheel/subprocess-logs/` for directories matching `YYYY-MM-DD`
   * and removes those older than the threshold. Best-effort: errors are logged
   * but do not propagate.
   */
  static cleanup(baseDir: string, maxDays = 7): void {
    const logsRoot = path.resolve(baseDir, SUBPROCESS_LOG_DIR);
    if (!fs.existsSync(logsRoot)) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - maxDays);
    cutoff.setHours(0, 0, 0, 0);

    try {
      const entries = fs.readdirSync(logsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        // Only process directories matching YYYY-MM-DD
        if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) continue;

        const dirDate = new Date(entry.name + "T00:00:00");
        if (isNaN(dirDate.getTime())) continue;

        if (dirDate < cutoff) {
          const dirPath = path.join(logsRoot, entry.name);
          try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            log.info("pruned old subprocess log directory", { dir: entry.name });
          } catch (err) {
            log.warn("failed to prune subprocess log directory", {
              dir: entry.name,
              error: errorMessage(err),
            });
          }
        }
      }
    } catch (err) {
      log.warn("subprocess log cleanup failed", {
        error: errorMessage(err),
      });
    }
  }
}

// Helper: createLoggedCallbacks

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
