import type { EngineEvent } from "./core/types.js";

export interface StreamObserver {
  onEvent(event: EngineEvent): void;
  onTurnComplete(): string | null;
  reset(): void;
}

export function createObserverChain(observers: StreamObserver[]): {
  onEvent(event: EngineEvent): void;
  onTurnComplete(): string[];
  reset(): void;
} {
  return {
    onEvent(event: EngineEvent): void {
      for (const obs of observers) {
        obs.onEvent(event);
      }
    },
    onTurnComplete(): string[] {
      const messages: string[] = [];
      for (const obs of observers) {
        const msg = obs.onTurnComplete();
        if (msg !== null) {
          messages.push(msg);
        }
      }
      return messages;
    },
    reset(): void {
      for (const obs of observers) {
        obs.reset();
      }
    },
  };
}

export function createToolFailureObserver(
  opts?: { maxConsecutive?: number },
): StreamObserver {
  const maxConsecutive = opts?.maxConsecutive ?? 3;
  let consecutiveErrors = 0;

  return {
    onEvent(event: EngineEvent): void {
      if (event.type !== "tool_result") return;
      if (event.isError) {
        consecutiveErrors++;
      } else {
        consecutiveErrors = 0;
      }
    },
    onTurnComplete(): string | null {
      if (consecutiveErrors >= maxConsecutive) {
        return "Multiple tool calls are failing. Try a different approach.";
      }
      return null;
    },
    reset(): void {
      consecutiveErrors = 0;
    },
  };
}

export interface BudgetInfo {
  remainingCalls: number;
  remainingTokens: number;
}

export function createBudgetAwarenessObserver(
  getBudgetInfo: () => BudgetInfo | null,
): StreamObserver {
  return {
    onEvent(): void {},
    onTurnComplete(): string | null {
      const info = getBudgetInfo();
      if (!info) return null;
      if (info.remainingCalls < 5 || info.remainingTokens < 10_000) {
        return `Budget running low: ${info.remainingCalls} API calls remaining, ${info.remainingTokens} tokens remaining. Prioritize completing the task efficiently.`;
      }
      return null;
    },
    reset(): void {},
  };
}

export function createContextPressureObserver(
  getContextPercent: () => number,
): StreamObserver {
  let hasFired = false;

  return {
    onEvent(): void {},
    onTurnComplete(): string | null {
      if (hasFired) return null;
      const percent = getContextPercent();
      if (percent > 60) {
        hasFired = true;
        return "Context is filling up. Be concise in your responses and tool usage to preserve context space.";
      }
      return null;
    },
    reset(): void {
      hasFired = false;
    },
  };
}

export function createNoActionObserver(): StreamObserver {
  let sawToolUse = false;

  return {
    onEvent(event: EngineEvent): void {
      if (event.type === "tool_use") {
        sawToolUse = true;
      }
    },
    onTurnComplete(): string | null {
      const hadTools = sawToolUse;
      // Reset for next turn within the same step (multi-turn stdin pipe mode).
      // Per-step reset is handled by observerChain.reset() between steps.
      sawToolUse = false;
      return hadTools ? null : "No tool calls were made. Take action to make progress on the task.";
    },
    reset(): void {
      sawToolUse = false;
    },
  };
}
