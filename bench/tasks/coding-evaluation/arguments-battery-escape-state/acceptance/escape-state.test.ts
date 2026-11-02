import { describe, expect, test } from "bun:test";
import { parseToolArguments } from "../src/orchestration/agent-runtime/llm/json-parse";

function accepted(raw: string | undefined, input: Record<string, unknown>): void {
  const result = parseToolArguments(raw);
  expect(result.input).toEqual(input);
  expect(result.parseError).toBeUndefined();
}

describe("escape state", () => {
  test("preserves escaped quotes beside raw control characters", () => {
    const input = { content: 'say "ready"\nnext\tcolumn', path: "a.ts" };
    const raw = JSON.stringify(input).replaceAll("\\n", "\n").replaceAll("\\t", "\t");
    accepted(raw, input);
  });

  test("preserves backslash parity and nested delimiter text", () => {
    const input = {
      content: '\\\\ "quoted } ]"\n\\path',
      nested: { content: 'before \\" after\tend', enabled: false },
    };
    const raw = JSON.stringify(input).replaceAll("\\n", "\n").replaceAll("\\t", "\t");
    accepted(raw, input);
    accepted(`\`\`\`json\n${raw}\n\`\`\``, input);
  });

  test("refuses unfinished repair candidates without shortened values", () => {
    for (const raw of [
      '{"content":"say \\"ready\\"\ncut',
      '{"content":"whole","nested":{"enabled":',
      'Arguments:\n{"content":"cut\n',
    ]) {
      const result = parseToolArguments(raw);
      expect(result.input).toEqual({});
      expect(typeof result.parseError).toBe("string");
      expect(result.parseError?.length).toBeGreaterThan(0);
    }
  });

  test("retains strict JSON unicode and empty buffer behavior", () => {
    const input = { content: '\\"quote"\\tail', nested: [0, false, null] };
    accepted(JSON.stringify(input), input);
    accepted(String.raw`{"content":"\u0041 \q"}`, { content: String.raw`A \q` });
    for (const raw of [undefined, "", " \r\n\t"]) accepted(raw, {});
  });
});
