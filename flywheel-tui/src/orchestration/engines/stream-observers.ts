/**
 * Stream Observers — engine-agnostic observers that watch EngineEvents
 * and produce injection messages at turn boundaries.
 *
 * Wired into workflow mode only (chat mode deferred).
 */

export type EngineEvent =
  | { type: "tool_use"; toolName: string; toolInput: Record<string, unknown> }
  | { type: "tool_result"; isError: boolean }
  | { type: "text" }
  | { type: "result" }
  | { type: "other" };

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
