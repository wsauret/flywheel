/**
 * Cost Tracker
 *
 * Accumulates cost_usd from NDJSON step_finish events and persists
 * the running total to the session file with debounced writes.
 *
 * Usage:
 *   const tracker = createCostTracker({ sessionId, baseDir });
 *   parser.onEvent = tracker.handleEvent;
 *   // ... when session ends:
 *   tracker.dispose(); // flushes pending cost + cancels timers
 */

import { z } from "zod";
import type { NDJSONEvent } from "../worker/ndjson-parser";
import { updateSession } from "./persistence";

// ---------------------------------------------------------------------------
// Zod schema for safe cost extraction
// ---------------------------------------------------------------------------

/** Narrow schema to safely extract cost_usd from step_finish event data. */
const StepFinishCostSchema = z
  .object({
    usage: z
      .object({
        cost_usd: z.number(),
      })
      .passthrough(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CostTrackerDeps {
  sessionId: string;
  baseDir: string;
  /** Debounce interval in ms. Default: 100ms */
  debounceMs?: number;
}

export interface CostTracker {
  /** Handle an NDJSON event. Attach this to parser.onEvent. */
  handleEvent(event: NDJSONEvent): void;
  /** Get accumulated cost so far. */
  getTotalCost(): number;
  /** Force-write pending cost to session file. */
  flush(): void;
  /** Cancel timers and flush. */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_DEBOUNCE_MS = 100;

export function createCostTracker(deps: CostTrackerDeps): CostTracker {
  const { sessionId, baseDir, debounceMs = DEFAULT_DEBOUNCE_MS } = deps;

  let totalCost = 0;
  let pendingWrite = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  function writeCost(): void {
    if (!pendingWrite) return;
    pendingWrite = false;
    timerId = null;

    try {
      updateSession(sessionId, { totalCost }, baseDir);
    } catch {
      // Session may have been deleted or become corrupt.
      // Swallow — the cost is still tracked in-memory via getTotalCost().
    }
  }

  function scheduleWrite(): void {
    if (disposed) return;
    pendingWrite = true;

    // Reset the debounce timer
    if (timerId !== null) {
      clearTimeout(timerId);
    }
    timerId = setTimeout(writeCost, debounceMs);
  }

  function handleEvent(event: NDJSONEvent): void {
    if (event.type !== "step_finish") return;

    const parsed = StepFinishCostSchema.safeParse(event.data);
    if (!parsed.success) return;

    totalCost += parsed.data.usage.cost_usd;
    scheduleWrite();
  }

  function getTotalCost(): number {
    return totalCost;
  }

  function flush(): void {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    writeCost();
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    // Force-flush any pending cost before teardown
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
    // Write if there's a pending update
    if (pendingWrite) {
      writeCost();
    }
  }

  return { handleEvent, getTotalCost, flush, dispose };
}
