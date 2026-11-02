import { expect, test } from "bun:test";
import { parseToolArguments } from "../src/orchestration/agent-runtime/llm/json-parse";

test("unwraps nested objects without dropping trailing fields", () => {
  const input = { nested: { flag: false }, items: [{ name: "one" }], final: "last" };
  for (const raw of [`Result: ${JSON.stringify(input)} done`, `\u0060\u0060\u0060json\n${JSON.stringify(input)}\n\u0060\u0060\u0060`]) {
    expect(parseToolArguments(raw)).toEqual({ input });
  }
});
test("refuses complete array envelopes as arrays", () => {
  const result = parseToolArguments('Arguments: [[1,2],[3,4]] end');
  expect(result.input).toEqual({});
  expect(result.parseError).toContain("array");
  expect(result.parseError).toContain("instead of an object");
});
test("retains strict bare objects and repairs enveloped controls", () => {
  const input = { nested: { content: "a\nb" }, last: 9 };
  expect(parseToolArguments(JSON.stringify(input))).toEqual({ input });
  expect(parseToolArguments('Result: '+JSON.stringify(input).replace('\\n','\n')+' end')).toEqual({ input });
  expect(parseToolArguments('  ')).toEqual({ input: {} });
});
test("does not complete a truncated nested document", () => {
  const result = parseToolArguments('{"nested":{"value":');
  expect(result.input).toEqual({});
  expect(result.parseError).toContain("incomplete");
});
