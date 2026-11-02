/**
 * Shared termination detection for tool batches.
 *
 * The runtime uses identical rules:
 * - A successful handoff terminates regardless of other results in the batch.
 * - Otherwise, all tools must return terminate:true without errors for the batch to terminate.
 */
import type { ToolOutcome } from "../../../infra/tool-outcome.js";

interface ToolBatchEntry {
  name: string;
  outcome: ToolOutcome;
  terminate?: boolean;
}

export function shouldTerminateToolBatch(results: ReadonlyArray<ToolBatchEntry>): boolean {
  if (results.length === 0) return false;

  const handoffSucceeded = results.some(
    (entry) => entry.name === "handoff" && entry.terminate === true && entry.outcome === "ok",
  );
  if (handoffSucceeded) return true;

  return results.every((entry) => entry.terminate === true && entry.outcome === "ok");
}
