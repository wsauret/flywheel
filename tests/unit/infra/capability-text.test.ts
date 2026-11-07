import { describe, expect, test } from "bun:test";
import { renderCapabilityText, type CapabilityCheck } from "../../../src/infra/capability-text.js";

const holding = (...terms: string[]): CapabilityCheck => (term) => terms.includes(term);

describe("renderCapabilityText", () => {
  test("keeps a text with no markers byte for byte", () => {
    const text = "first line\n\n  indented {{ref:x}}\ntrailing\n";
    expect(renderCapabilityText(text, holding())).toBe(text);
  });

  test("keeps the first branch when any listed term holds", () => {
    const text = "a\n{{if:subagent|workflow}}\ndelegate\n{{else}}\ndo it yourself\n{{end}}\nb";
    expect(renderCapabilityText(text, holding("workflow"))).toBe("a\ndelegate\nb");
  });

  test("keeps the else branch when no listed term holds", () => {
    const text = "a\n{{if:subagent|workflow}}\ndelegate\n{{else}}\ndo it yourself\n{{end}}\nb";
    expect(renderCapabilityText(text, holding("bash"))).toBe("a\ndo it yourself\nb");
  });

  test("drops a block without an else when no listed term holds", () => {
    const text = "a\n{{if:skill:design}}\nload design\n{{end}}\nb";
    expect(renderCapabilityText(text, holding())).toBe("a\nb");
    expect(renderCapabilityText(text, holding("skill:design"))).toBe("a\nload design\nb");
  });

  test.each([
    ["a nested block", "{{if:a}}\n{{if:b}}\n{{end}}\n{{end}}", /line 2 opens a block inside the block opened at line 1/],
    ["an unclosed block", "x\n{{if:a}}\ny", /opened at line 2 has no \{\{end\}\}/],
    ["an end outside a block", "x\n{{end}}", /\{\{end\}\} at line 2 is outside a block/],
    ["an else outside a block", "{{else}}", /\{\{else\}\} at line 1 is outside a block/],
    ["a second else", "{{if:a}}\n{{else}}\n{{else}}\n{{end}}", /line 3 repeats the else/],
    ["an empty term", "{{if:a|}}\n{{end}}", /line 1 names an empty term/],
  ])("throws on %s", (_name, text, message) => {
    expect(() => renderCapabilityText(text, holding("a"))).toThrow(message);
  });
});
