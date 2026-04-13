import type { EngineEvent, StreamObserver } from "./stream-observers.js";

const DEFAULT_THRESHOLD = 3;

const MAX_HISTORY = 13;

function extractToolSignature(name: string, input: Record<string, unknown>): string {
  const keys = Object.keys(input).sort();
  const parts = keys.map((k) => `${k}=${String(input[k]).slice(0, 100)}`);
  return `${name}(${parts.join(",")})`;
}

class DoomLoopDetector implements StreamObserver {
  private readonly history: (string | undefined)[];
  private head = 0;
  private size = 0;
  private readonly threshold: number;

  constructor(threshold = DEFAULT_THRESHOLD) {
    this.threshold = threshold;
    this.history = new Array(MAX_HISTORY);
  }

  private addToHistory(sig: string) {
    this.history[this.head] = sig;
    this.head = (this.head + 1) % MAX_HISTORY;
    if (this.size < MAX_HISTORY) this.size++;
  }

  private getHistory(): string[] {
    const result: string[] = new Array(this.size);
    const start = (this.head - this.size + MAX_HISTORY) % MAX_HISTORY;
    for (let i = 0; i < this.size; i++) {
      result[i] = this.history[(start + i) % MAX_HISTORY]!;
    }
    return result;
  }

  private recordToolCall(name: string, inputSignature: string) {
    this.addToHistory(`${name}:${inputSignature}`);
  }

  reset(): void {
    this.history.fill(undefined);
    this.head = 0;
    this.size = 0;
  }

  onEvent(event: EngineEvent): void {
    if (event.type === "tool_use") {
      const sig = extractToolSignature(event.toolName, event.toolInput);
      this.recordToolCall(event.toolName, sig);
    }
  }

  onTurnComplete(): string | null {
    const pattern = this.detectPattern();
    if (!pattern) return null;
    return `Doom loop detected: the same ${pattern.length === 1 ? "tool call" : `sequence of ${pattern.length} tool calls`} has repeated ${this.threshold}+ times. Try a different approach.`;
  }

  private detectPattern(): string[] | undefined {
    const h = this.getHistory();
    if (h.length < this.threshold) return undefined;

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

export function createDoomLoopObserver(
  opts?: { threshold?: number },
): StreamObserver {
  return new DoomLoopDetector(opts?.threshold);
}
