/**
 * Completion marker detection for worker output streams.
 *
 * The completion marker `<promise>COMPLETE</promise>` is injected into prompts
 * and checked incrementally during streaming and as a final fallback.
 */

/** Regex for the completion marker. Case-insensitive, allows whitespace around COMPLETE. */
export const COMPLETION_REGEX = /<promise>\s*COMPLETE\s*<\/promise>/i;

/** Size of the fallback check window (last 32KB of stdout). */
export const FALLBACK_CHECK_SIZE = 32_768;

/**
 * Tracks completion marker detection incrementally during streaming.
 */
export class CompletionDetector {
  private _hasSeenCompletion = false;

  /** Whether the completion marker has been detected. */
  get hasSeenCompletion(): boolean {
    return this._hasSeenCompletion;
  }

  /**
   * Check a chunk of streaming output for the completion marker.
   * Once detected, further calls are short-circuited.
   */
  check(chunk: string): boolean {
    if (this._hasSeenCompletion) return true;
    if (COMPLETION_REGEX.test(chunk)) {
      this._hasSeenCompletion = true;
    }
    return this._hasSeenCompletion;
  }

  /**
   * Fallback: check the tail of the full output buffer.
   * Only performs the check if `hasSeenCompletion` is false (guards the slice).
   */
  checkFallback(fullOutput: string): boolean {
    if (this._hasSeenCompletion) return true;
    const tail = fullOutput.slice(-FALLBACK_CHECK_SIZE);
    if (COMPLETION_REGEX.test(tail)) {
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
