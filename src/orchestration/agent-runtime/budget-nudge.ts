/**
 * Soft budget steering for a capped handoff run (subagent or workflow
 * worker), ahead of the hard cap in budget-exhaust.ts:
 *
 *   1. Nudge (80% of the cap used): the turn's last tool result gets a
 *      trailing budget line so the model consolidates remaining work and
 *      heads for handoff. In-band tool-result text on purpose: an injected
 *      user message reads as a fresh instruction and draws a reply of its
 *      own, which would itself burn turns.
 *   2. Closure (95% used): only `handoff` executes - plus `process`, so a
 *      run with pending dispatched work can still park for it - and every
 *      other call is denied at the tool-policy seam with a message naming
 *      handoff.
 *
 * A run without a cap, or without a handoff (chat), gets neither stage.
 */

import type { ToolResultEntry } from "./agent-state.js";
import type { ExecutionWhitelist } from "./tools/tool-policy.js";

const NUDGE_RATIO = 0.8;
const CLOSURE_RATIO = 0.95;
const CLOSURE_TOOLS: ReadonlySet<string> = new Set(["handoff", "process"]);

export interface BudgetNudge {
  /** The results with the budget trailer appended to the last entry once the
   *  nudge stage is reached; the input unchanged before it. `turnsUsed`
   *  counts the turn whose results these are. */
  applyTrailer(results: ReadonlyArray<ToolResultEntry>, turnsUsed: number): ReadonlyArray<ToolResultEntry>;
  /** Handoff-only execution whitelist once the closure stage is reached,
   *  undefined before it. `turn` is the ordinal of the turn being dispatched. */
  closureWhitelist(turn: number): ExecutionWhitelist | undefined;
}

const INACTIVE: BudgetNudge = {
  applyTrailer: (results) => results,
  closureWhitelist: () => undefined,
};

export function createBudgetNudge(maxLLMCalls: number | undefined, handoffConfigured: boolean): BudgetNudge {
  if (maxLLMCalls === undefined || !handoffConfigured) return INACTIVE;
  const max = maxLLMCalls;
  const nudgeAt = Math.ceil(max * NUDGE_RATIO);
  const closureAt = Math.ceil(max * CLOSURE_RATIO);
  return {
    applyTrailer(results, turnsUsed) {
      const last = results[results.length - 1];
      if (!last || turnsUsed < nudgeAt) return results;
      const remaining = max - turnsUsed;
      const trailer = `[budget: ${remaining} of ${max} turns remain. Consolidate: batch every remaining independent tool call into your next turns and call handoff before the cap.]`;
      return [...results.slice(0, -1), { ...last, content: [...last.content, { type: "text", text: trailer }] }];
    },
    closureWhitelist(turn) {
      if (turn < closureAt) return undefined;
      return {
        tools: CLOSURE_TOOLS,
        deniedReason: (toolName) =>
          `Tool '${toolName}' denied: ${Math.max(0, max - turn)} of this run's ${max}-turn budget remains. Call handoff now with your completed work and report what is unfinished in it; process { action: "wait" } stays available for pending dispatched work.`,
      };
    },
  };
}
