/**
 * Completion detection for worker output streams.
 *
 * Three signals indicate completion (any one is sufficient):
 *   1. `<promise>COMPLETE</promise>` marker in output text (legacy, prompt-injected)
 *   2. NDJSON `{"type":"result","subtype":"success"}` event (Claude Code stream-json)
 *   3. Clean exit (exit code 0) — the process ending successfully IS completion
 *
 * Signal 3 is checked in `categorizeFailure` (errors.ts), not here.
 * This class tracks signals 1 and 2 incrementally during streaming.
 */

/** Regex for the legacy completion marker. Case-insensitive, allows whitespace. */
export const COMPLETION_REGEX = /<promise>\s*COMPLETE\s*<\/promise>/i;

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
 * Checks both the legacy `<promise>COMPLETE</promise>` marker and
 * the NDJSON `{"type":"result","subtype":"success"}` event.
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
    if (COMPLETION_REGEX.test(chunk) || NDJSON_RESULT_REGEX.test(chunk)) {
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
    if (COMPLETION_REGEX.test(tail) || NDJSON_RESULT_REGEX.test(tail)) {
      this._hasSeenCompletion = true;
    }
    return this._hasSeenCompletion;
  }

  /** Reset state (for testing or re-use). */
  reset(): void {
    this._hasSeenCompletion = false;
  }
}

/**
 * Wraps a completion instruction into a prompt.
 */
export function wrapCompletionInstruction(prompt: string): string {
  return `${prompt}\n\nWhen you have finished, output the marker: <promise>COMPLETE</promise>`;
}
