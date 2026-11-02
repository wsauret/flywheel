import { describe, expect, it } from "bun:test";

import { createBudgetNudge } from "../../../../src/orchestration/agent-runtime/budget-nudge.js";
import type { ToolResultEntry } from "../../../../src/orchestration/agent-runtime/agent-state.js";
import { toTextParts } from "../../../../src/infra/llm/tool-output-part-schema.js";

function entry(id: string, text: string): ToolResultEntry {
  return { toolUseId: id, content: toTextParts(text), outcome: "ok" };
}

describe("createBudgetNudge", () => {
  it("is inactive without a cap or without a handoff", () => {
    const results = [entry("tc_1", "ok")];
    for (const nudge of [createBudgetNudge(undefined, true), createBudgetNudge(10, false)]) {
      expect(nudge.applyTrailer(results, 10)).toBe(results);
      expect(nudge.closureWhitelist(10)).toBeUndefined();
    }
  });

  it("appends the trailer to the last result only, from 80% of the cap", () => {
    const nudge = createBudgetNudge(150, true);
    const results = [entry("tc_1", "a"), entry("tc_2", "b")];
    // ceil(150 * 0.8) = 120: turn 119 is below the stage, turn 120 is in it.
    expect(nudge.applyTrailer(results, 119)).toBe(results);
    const nudged = nudge.applyTrailer(results, 120);
    expect(nudged[0]).toBe(results[0]);
    const last = JSON.stringify(nudged[1]);
    expect(last).toContain("[budget: 30 of 150 turns remain");
    expect(last).toContain("handoff");
    // The input entries stay unmutated.
    expect(JSON.stringify(results[1])).not.toContain("[budget:");
  });

  it("preserves image parts in the last result and appends the trailer after them", () => {
    const nudge = createBudgetNudge(10, true);
    const imageBearing: ToolResultEntry = {
      toolUseId: "tc_img",
      content: [{ type: "text", text: "screenshot follows" }, { type: "image", mediaType: "image/png", data: "aGk=" }],
      outcome: "ok",
    };
    const nudged = nudge.applyTrailer([imageBearing], 9);
    const parts = nudged[0]!.content;
    expect(parts).toHaveLength(3);
    expect(parts[0]).toEqual({ type: "text", text: "screenshot follows" });
    expect(parts[1]).toEqual({ type: "image", mediaType: "image/png", data: "aGk=" });
    expect(parts[2]?.type).toBe("text");
    expect(JSON.stringify(parts[2])).toContain("[budget: 1 of 10 turns remain");
  });

  it("leaves an empty batch alone even past the threshold", () => {
    const nudge = createBudgetNudge(10, true);
    expect(nudge.applyTrailer([], 9)).toEqual([]);
  });

  it("opens the closure whitelist at 95% of the cap, allowing handoff and background only", () => {
    const nudge = createBudgetNudge(150, true);
    // ceil(150 * 0.95) = 143.
    expect(nudge.closureWhitelist(142)).toBeUndefined();
    const gate = nudge.closureWhitelist(143);
    expect(gate).toBeDefined();
    expect(gate?.tools.has("handoff")).toBe(true);
    expect(gate?.tools.has("process")).toBe(true);
    expect(gate?.tools.has("bash")).toBe(false);
    expect(gate?.deniedReason("bash")).toContain("Tool 'bash' denied");
    expect(gate?.deniedReason("bash")).toContain("Call handoff now");
  });

  it("never reports negative remaining turns", () => {
    const nudge = createBudgetNudge(10, true);
    expect(nudge.closureWhitelist(12)?.deniedReason("read")).toContain("0 of this run's 10-turn budget");
  });
});
