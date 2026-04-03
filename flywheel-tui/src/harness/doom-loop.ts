/**
 * Doom loop detection for agent tool calls.
 *
 * Detects when the agent is stuck in a repetitive pattern of tool calls,
 * wasting tokens without making progress.
 */

const DEFAULT_THRESHOLD = 3;

/** Creates a stable fingerprint from a tool name and its input. */
export function extractToolSignature(name: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  const parts = keys.map((k) => `${k}=${JSON.stringify(input[k])}`);
  return `${name}(${parts.join(",")})`;
}

/**
 * Detects repetitive patterns in tool call sequences.
 *
 * Two detection strategies:
 * 1. Single-call repetition (AAA): same tool+signature N+ times in a row
 * 2. Multi-call cycle (ABCABC): pattern of 2-4 calls repeated N+ times
 */
export class DoomLoopDetector {
  private history: string[] = [];
  private readonly threshold: number;

  constructor(threshold = DEFAULT_THRESHOLD) {
    this.threshold = threshold;
  }

  /** Record a new tool call for pattern analysis. */
  recordToolCall(name: string, inputSignature: string): void {
    this.history.push(`${name}:${inputSignature}`);
  }

  /** Returns true if the recent history contains a repetitive pattern. */
  isLooping(): boolean {
    return this.detectPattern() !== undefined;
  }

  /** Returns a warning message if looping, otherwise undefined. */
  getWarning(): string | undefined {
    const pattern = this.detectPattern();
    if (!pattern) return undefined;
    return `Doom loop detected: the same ${pattern.length === 1 ? "tool call" : `sequence of ${pattern.length} tool calls`} has repeated ${this.threshold}+ times. Try a different approach.`;
  }

  /** Reset the detector state. */
  reset(): void {
    this.history = [];
  }

  private detectPattern(): string[] | undefined {
    const h = this.history;
    if (h.length < this.threshold) return undefined;

    // Check pattern lengths 1 through 4
    for (let patLen = 1; patLen <= 4; patLen++) {
      const needed = patLen * this.threshold;
      if (h.length < needed) continue;

      const tail = h.slice(-needed);
      const pattern = tail.slice(0, patLen);
      let matched = true;

      for (let rep = 1; rep < this.threshold; rep++) {
        for (let j = 0; j < patLen; j++) {
          if (tail[rep * patLen + j] !== pattern[j]) {
            matched = false;
            break;
          }
        }
        if (!matched) break;
      }

      if (matched) return pattern;
    }

    return undefined;
  }
}
