/**
 * Completion detection for worker output streams.
 *
 * Two signals indicate completion (either one is sufficient):
 *   1. NDJSON `{"type":"result","subtype":"success"}` event (Claude Code stream-json)
 *   2. Clean exit (exit code 0) — the process ending successfully IS completion
 *
 * Signal 2 is checked in `categorizeFailure` (errors.ts), not here.
 * This class tracks signal 1 incrementally during streaming.
 */

import * as fs from "node:fs";

/**
 * Regex for NDJSON result event indicating successful completion.
 * Matches `"type":"result"` with `"subtype":"success"` on the same line.
 */
const NDJSON_RESULT_REGEX = /"type"\s*:\s*"result"[^}]*"subtype"\s*:\s*"success"/;

/** Size of the fallback check window (last 32KB of stdout). */
export const FALLBACK_CHECK_SIZE = 32_768;

/**
 * Tracks completion detection incrementally during streaming.
 *
 * Checks the NDJSON `{"type":"result","subtype":"success"}` event.
 */
export class CompletionDetector {
  private _hasSeenCompletion = false;

  /** Whether completion has been detected via any signal. */
  get hasSeenCompletion(): boolean {
    return this._hasSeenCompletion;
  }

  /**
   * Check a chunk of streaming output for completion signals.
   * Once detected, further calls are short-circuited.
   */
  check(chunk: string): boolean {
    if (this._hasSeenCompletion) return true;
    if (NDJSON_RESULT_REGEX.test(chunk)) {
      this._hasSeenCompletion = true;
    }
    return this._hasSeenCompletion;
  }

  /**
   * Fallback: check the tail of the full output buffer.
   * Only performs the check if completion hasn't been seen yet.
   */
  checkFallback(fullOutput: string): boolean {
    if (this._hasSeenCompletion) return true;
    const tail = fullOutput.slice(-FALLBACK_CHECK_SIZE);
    if (NDJSON_RESULT_REGEX.test(tail)) {
      this._hasSeenCompletion = true;
    }
    return this._hasSeenCompletion;
  }

  /**
   * Check if a handoff file exists at the given path.
   * Returns true if the file exists, false otherwise.
   */
  checkHandoffFile(handoffPath: string): boolean {
    if (!handoffPath) return false;
    try {
      return fs.existsSync(handoffPath);
    } catch {
      return false;
    }
  }

  /** Reset state (for testing or re-use). */
  reset(): void {
    this._hasSeenCompletion = false;
  }
}
