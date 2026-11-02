import { describe, expect, test } from "bun:test";
import { parseToolArguments } from "../src/orchestration/agent-runtime/llm/json-parse";

function rejected(raw: string): string {
  const result = parseToolArguments(raw);
  expect(result.input).toEqual({});
  expect(typeof result.parseError).toBe("string");
  expect(result.parseError?.length).toBeGreaterThan(0);
  return result.parseError ?? "";
}

function boundedEvidence(raw: string): string {
  const message = rejected(raw);
  expect(message).toContain(raw.slice(0, 600));
  expect(message).not.toContain(raw.slice(0, 601));
  expect(message).not.toContain("TAIL_SENTINEL");
  expect(message.length).toBeLessThan(1000);
  return message;
}

describe("error evidence", () => {
  test("bounds incomplete argument evidence while retaining the raw prefix", () => {
    const raw = '```json\n{"content":"' + "a".repeat(900) + "TAIL_SENTINEL\n```";
    const message = boundedEvidence(raw);
    expect(message).toContain("incomplete");
  });

  test("bounds nonobject evidence without changing the root diagnosis", () => {
    const raw = JSON.stringify(["x".repeat(950) + "TAIL_SENTINEL"]);
    const message = boundedEvidence(raw);
    expect(message).toContain("array");
    expect(message).toContain("instead of an object");
  });

  test("retains all raw evidence through the exact snippet boundary", () => {
    for (const length of [599, 600]) {
      const raw = '{"content":"' + "z".repeat(length - 13) + "!";
      expect(raw.length).toBe(length);
      expect(rejected(raw)).toContain(raw);
    }
    const raw = '{"content":"' + "w".repeat(590);
    expect(raw.length).toBe(602);
    const message = rejected(raw);
    expect(message).toContain(raw.slice(0, 600));
    expect(message).not.toContain(raw.slice(0, 601));
  });

  test("returns full successful inputs and preserves short failures", () => {
    const input = { content: "whole".repeat(250), nested: { enabled: true } };
    const result = parseToolArguments(JSON.stringify(input));
    expect(result.input).toEqual(input);
    expect(result.parseError).toBeUndefined();
    expect(rejected('{"value": @}')).toContain('{"value": @}');
    expect(rejected("false")).toContain("boolean");
    for (const raw of [undefined, "", "\n "]) {
      expect(parseToolArguments(raw)).toEqual({ input: {} });
    }
  });
});
