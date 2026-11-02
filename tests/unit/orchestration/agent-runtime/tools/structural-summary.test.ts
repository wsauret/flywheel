import { describe, expect, it } from "bun:test";

import { renderStructuralSummary, summarizeStructure } from "../../../../../src/orchestration/agent-runtime/tools/structural-summary.js";

describe("structural summary", () => {
  it("counts a terminal empty row", async () => {
    const body = Array.from({ length: 98 }, (_, index) => `const p${index} = ${index};`);
    const text = ["function value() {", "  const x = 1;", "  return x;", "}", ...body, ""].join("\n");
    const summary = await summarizeStructure({ path: "terminal.ts", text });
    expect(summary?.totalLines).toBe(103);
  });

  it("folds large Python bodies while retaining signatures and exact recovery ranges", async () => {
    const body = Array.from({ length: 120 }, (_, index) => `        value${index} = ${index}`);
    const text = ["from pathlib import Path", "", "class Card:", "    @staticmethod", "    def _split(value):",
      '        """Split the card."""', ...body, "        return value", "", "LIMIT = 5"].join("\n");
    const summary = await summarizeStructure({ path: "card.py", text });
    expect(summary).not.toBeNull();
    const rendered = renderStructuralSummary(summary!, "card.py");
    expect(rendered.text).toContain("3|class Card:");
    expect(rendered.text).toContain("4|    @staticmethod");
    expect(rendered.text).toContain("5|    def _split(value):");
    expect(rendered.text).toContain('6|        """Split the card."""');
    expect(rendered.text).not.toContain("value60 = 60");
    expect(rendered.text).toContain("card.py:6-127");
    expect(rendered.text).toContain("129|LIMIT = 5");
  });
});
