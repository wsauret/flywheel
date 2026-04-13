/**
 * Doom loop detection for agent tool calls.
 *
 * Detects when the agent is stuck in a repetitive pattern of tool calls,
 * wasting tokens without making progress.
 *
 * Moved from src-legacy/harness/doom-loop.ts and adapted to StreamObserver interface.
 */

import type { EngineEvent, StreamObserver } from "./stream-observers.js";

const DEFAULT_THRESHOLD = 3;

/** Maximum history entries to retain (prevents unbounded memory growth). */
const MAX_HISTORY = 13;

/** Creates a stable fingerprint from a tool name and its input.
 *  Uses key-names + shallow value hash (first 100 chars of stringified value).
 *  Internal — tested through the observer/factory interface. */
function extractToolSignature(name: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  const parts = keys.map((k) => `${k}=${String(input[k]).slice(0, 100)}`);
  return `${name}(${parts.join(",")})`;
}



/**
 * Detects repetitive patterns in tool call sequences.
 *
 * Two detection strategies:
 * 1. Single-call repetition (AAA): same tool+signature N+ times in a row
 * 2. Multi-call cycle (ABCABC): pattern of 2-4 calls repeated N+ times
 *
 * Uses a ring buffer for allocation-free recording in the hot path.
 * Pattern detection (called only at turn boundaries) reads the buffer into
 * a temporary ordered array.
 */
class DoomLoopDetector implements StreamObserver {
  private readonly history: (string | undefined)[];
  private head = 0;
  private size = 0;
  private readonly threshold: number;

  constructor(threshold = DEFAULT_THRESHOLD) {
    this.threshold = threshold;
    this.history = new Array(MAX_HISTORY);
  }

  /** Add a signature to the ring buffer (allocation-free hot path). */
  private addToHistory(sig: string): void {
    this.history[this.head] = sig;
    this.head = (this.head + 1) % MAX_HISTORY;
    if (this.size < MAX_HISTORY) this.size++;
  }

  /** Read the ring buffer into an ordered array for pattern analysis. */
  private getHistory(): string[] {
    const result: string[] = new Array(this.size);
    const start = (this.head - this.size + MAX_HISTORY) % MAX_HISTORY;
    for (let i = 0; i < this.size; i++) {
      result[i] = this.history[(start + i) % MAX_HISTORY]!;
    }
    return result;
  }

  /** Record a new tool call for pattern analysis. */
  recordToolCall(name: string, inputSignature: string): void {
    this.addToHistory(`${name}:${inputSignature}`);
  }

  /** Returns a warning message if looping, otherwise undefined. */
  getWarning(): string | undefined {
    const pattern = this.detectPattern();
    if (!pattern) return undefined;
    return `Doom loop detected: the same ${pattern.length === 1 ? "tool call" : `sequence of ${pattern.length} tool calls`} has repeated ${this.threshold}+ times. Try a different approach.`;
  }

  /** Reset the detector state. */
  reset(): void {
    this.history.fill(undefined);
    this.head = 0;
    this.size = 0;
  }

  // -- StreamObserver interface --

  /** StreamObserver: feed an engine event. */
  onEvent(event: EngineEvent): void {
    if (event.type === "tool_use" && event.toolName) {
      const sig = extractToolSignature(event.toolName, event.toolInput ?? {});
      this.recordToolCall(event.toolName, sig);
    }
  }

  /** StreamObserver: check for patterns at turn boundary. */
  onTurnComplete(): string | null {
    const pattern = this.detectPattern();
    if (!pattern) return null;
    return `Doom loop detected: the same ${pattern.length === 1 ? "tool call" : `sequence of ${pattern.length} tool calls`} has repeated ${this.threshold}+ times. Try a different approach.`;
  }

  private detectPattern(): string[] | undefined {
    const h = this.getHistory();
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDoomLoopObserver(
  opts?: { threshold?: number },
): StreamObserver {
  return new DoomLoopDetector(opts?.threshold);
}
