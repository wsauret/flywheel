import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";

import { hoistToolResults } from "../src/orchestration/engines/providers/harness/llm/anthropic.js";

type Block = Anthropic.ContentBlockParam;

const text = (t: string): Block => ({ type: "text", text: t });
const toolResult = (id: string, content = "ok"): Block => ({
  type: "tool_result",
  tool_use_id: id,
  content,
});

describe("hoistToolResults", () => {
  test("leaves blocks untouched when no tool_result is present", () => {
    const blocks: Block[] = [text("a"), text("b")];
    expect(hoistToolResults(blocks)).toBe(blocks);
  });

  test("leaves blocks untouched when every block is a tool_result", () => {
    const blocks: Block[] = [toolResult("t1"), toolResult("t2")];
    expect(hoistToolResults(blocks)).toEqual(blocks);
  });

  test("moves tool_result before preceding text block (the 400 regression)", () => {
    const nudge = text("<system-reminder>todo state</system-reminder>");
    const tr = toolResult("toolu_1");
    const budget = text("<system-reminder>budget</system-reminder>");

    expect(hoistToolResults([nudge, tr, budget])).toEqual([tr, nudge, budget]);
  });

  test("preserves the relative order among tool_results and among non-tool_results", () => {
    const tr1 = toolResult("a");
    const tr2 = toolResult("b");
    const t1 = text("first");
    const t2 = text("second");

    expect(hoistToolResults([t1, tr1, t2, tr2])).toEqual([tr1, tr2, t1, t2]);
  });
});
