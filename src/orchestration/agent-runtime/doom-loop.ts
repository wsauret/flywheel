import type { ToolCall } from "./llm/types.js";
import { formatRuntimeNotification } from "./runtime-notifications.js";

const THRESHOLD = 3;

const MAX_PATTERN_LENGTH = 4;

// History capacity: the longest window any detection pass reads (a
// max-length pattern repeated to the threshold), plus one slot of slack.
const MAX_HISTORY = MAX_PATTERN_LENGTH * THRESHOLD + 1;

function extractToolSignature(call: Pick<ToolCall, "name" | "input">): string {
  const keys = Object.keys(call.input).sort();
  // JSON for object values: String() would render every object as
  // "[object Object]", collapsing calls that differ only in nested args
  // into one signature (a false-positive repetition guard).
  const parts = keys.map((k) => {
    const value = call.input[k];
    const rendered = typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
    return `${k}=${rendered.slice(0, 100)}`;
  });
  return `${call.name}(${parts.join(",")})`;
}

interface HistoryEntry {
  readonly signature: string;
  readonly version: number;
}

interface DetectedPattern {
  readonly signatures: readonly string[];
  readonly version: number;
}

/**
 * The repeated-call observer of one agent loop (ARCH-TOOLS-007). The loop
 * shows it each tool batch when the batch settles; when the same call, or the
 * same short sequence of calls, has repeated THRESHOLD times, it returns a
 * private runtime notice that asks for a different approach. It reports each
 * pattern once, until a new call extends it.
 *
 * A wait that parked on live work is a wait by design, so the loop names it
 * in `parkedWaitIds` and it never enters the history. A wait that found
 * nothing to wait for stays in it as evidence of a real loop. The history
 * starts again at each person message or Resume (`reset`).
 */
class RepetitionGuard {
  private history: HistoryEntry[] = [];
  private version = 0;
  private lastReportedVersion = -1;

  reset(): void {
    this.history = [];
    this.version = 0;
    this.lastReportedVersion = -1;
  }

  observeBatch(calls: readonly Pick<ToolCall, "id" | "name" | "input">[], parkedWaitIds: ReadonlySet<string>): string | null {
    for (const call of calls) {
      if (parkedWaitIds.has(call.id)) continue;
      this.version++;
      this.history.push({ signature: extractToolSignature(call), version: this.version });
      if (this.history.length > MAX_HISTORY) this.history.shift();
    }
    const pattern = this.detectPattern();
    if (!pattern || this.lastReportedVersion === pattern.version) return null;
    this.lastReportedVersion = pattern.version;
    const repeated = pattern.signatures.length === 1 ? "tool call" : `sequence of ${pattern.signatures.length} tool calls`;
    return formatRuntimeNotification({
      tag: "repetition_notice",
      handling: `The same ${repeated} has repeated ${THRESHOLD} or more times with the same input. Do not repeat it again: try a different approach.`,
    });
  }

  private detectPattern(): DetectedPattern | undefined {
    const h = this.history;
    if (h.length < THRESHOLD) return undefined;

    for (let patLen = 1; patLen <= MAX_PATTERN_LENGTH; patLen++) {
      const needed = patLen * THRESHOLD;
      if (h.length < needed) continue;

      const tail = h.slice(-needed);
      const pattern = tail.slice(0, patLen);
      let matched = true;

      for (let rep = 1; rep < THRESHOLD; rep++) {
        for (let j = 0; j < patLen; j++) {
          if (tail[rep * patLen + j]?.signature !== pattern[j]?.signature) {
            matched = false;
            break;
          }
        }
        if (!matched) break;
      }

      if (matched) {
        return {
          signatures: pattern.map((entry) => entry.signature),
          version: tail.at(-1)!.version, // SAFETY: tail contains `needed`, and `needed` is at least THRESHOLD.
        };
      }
    }

    return undefined;
  }
}

export function createRepetitionGuard(): RepetitionGuard {
  return new RepetitionGuard();
}
