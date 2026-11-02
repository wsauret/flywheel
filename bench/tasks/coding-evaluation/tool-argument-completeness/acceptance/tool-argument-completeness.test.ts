import { describe, expect, test } from "bun:test";
import { parseToolArguments } from "../src/orchestration/agent-runtime/llm/json-parse";

function expectRefused(raw: string): void {
  const result = parseToolArguments(raw);
  expect(result.input).toEqual({});
  expect(typeof result.parseError).toBe("string");
  expect(result.parseError?.length).toBeGreaterThan(0);
}

function expectAccepted(raw: string | undefined, input: Record<string, unknown>): void {
  const result = parseToolArguments(raw);
  expect(result.input).toEqual(input);
  expect(result.parseError).toBeUndefined();
}

describe("tool argument completeness", () => {
  test("rejects a string cut before its closing quote", () => {
    expectRefused('{"path":"a.ts","content":"export const a = 1;');
  });

  test("rejects a cut between fields", () => {
    expectRefused('{"path":"a.ts",');
  });

  test("rejects partial enveloped JSON", () => {
    expectRefused('```json\n{"path":"a.ts","content":"cut\n```');
    expectRefused('Here are the arguments:\n{"path":"a.ts","content":"cut');
  });

  test("rejects unparseable text", () => {
    expectRefused("this is not JSON");
    expectRefused('{"path": @}');
  });

  test("rejects non-object roots", () => {
    for (const raw of ["null", "false", "42", '"text"', "[]", '[{"path":"a.ts"}]']) {
      expectRefused(raw);
    }
  });

  test("preserves complete strict JSON and escaped characters", () => {
    const input = {
      path: "a.ts",
      content: 'export const a = "quoted";\n\\tail\t',
      nested: { enabled: true, count: 0, missing: null, list: [1, "two"] },
      unicode: "\u263a",
    };
    expectAccepted(JSON.stringify(input), input);
  });

  test("repairs complete raw control characters", () => {
    const content = "line1\nline2\tcolumn\rreturn\bback\fform\u0000zero\u001fend";
    expectAccepted(`{"path":"a.ts","content":"${content}"}`, { path: "a.ts", content });
  });

  test("repairs complete invalid escapes", () => {
    expectAccepted(String.raw`{"path":"a.ts","content":"\q \x20"}`, {
      path: "a.ts", content: String.raw`\q \x20`,
    });
  });

  test("accepts complete fenced and prose-enveloped JSON", () => {
    const raw = '{"path":"a.ts","content":"whole"}';
    const input = { path: "a.ts", content: "whole" };
    expectAccepted(`\`\`\`json\n${raw}\n\`\`\``, input);
    expectAccepted(`Here are the arguments:\n${raw}\nDone.`, input);
    expectAccepted(`\`\`\`json\n{"content":"line1\nline2"}\n\`\`\``, { content: "line1\nline2" });
  });

  test("accepts absent and empty argument buffers", () => {
    for (const raw of [undefined, "", " \t\r\n"]) expectAccepted(raw, {});
  });
});
