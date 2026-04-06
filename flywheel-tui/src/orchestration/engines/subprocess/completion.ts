/**
 * Completion detection for worker output streams.
 *
 * Three signals indicate completion (any one is sufficient):
 *   1. NDJSON `{"type":"result","subtype":"success"}` event (Claude Code stream-json)
 *   2. NDJSON `{"type":"completion"}` event (Droid stream-json)
 *   3. Clean exit (exit code 0) — the process ending successfully IS completion
 *
 * Signal 3 is checked in `categorizeFailure` (errors.ts), not here.
 * This class tracks signals 1 and 2 incrementally during streaming.
 */

import * as fs from "node:fs";
import { SubprocessHandoffSchema } from "../../../infra/handoff-schemas";

/**
 * Regex for NDJSON result event indicating successful completion.
 * Matches either:
 *   - Claude: `"type":"result"` with `"subtype":"success"` on the same line
 *   - Droid:  `"type":"completion"` on the same line
 */
const NDJSON_RESULT_REGEX = /"type"\s*:\s*"result"[^}]*"subtype"\s*:\s*"success"|"type"\s*:\s*"completion"/;

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
   * Check if a handoff file exists and already contains a valid worker handoff.
   * Returns true only when the file parses and satisfies the handoff schema,
   * including the required summary field.
   */
  checkHandoffFile(handoffPath: string): boolean {
    if (!handoffPath) return false;
    try {
      if (!fs.existsSync(handoffPath)) {
        return false;
      }

      const text = fs.readFileSync(handoffPath, "utf-8");
      if (text.trim().length === 0) {
        return false;
      }

      const parsed = JSON.parse(text) as unknown;
      return SubprocessHandoffSchema.safeParse(parsed).success;
    } catch {
      return false;
    }
  }

  /** Reset state (for testing or re-use). */
  reset(): void {
    this._hasSeenCompletion = false;
  }
}
