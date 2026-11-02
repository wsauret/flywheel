import { expect, test } from "bun:test";
import { truncateField } from "../src/infra/truncate-field";

const bytes = (text: string) => Buffer.byteLength(text, "utf-8");

test("truncate-field: keeps multi-byte text within the byte budget", () => {
  for (const [text, budget] of [["é".repeat(50), 100], ["\u{1F600}".repeat(20), 64], ["中".repeat(30), 60]] as const) {
    const result = truncateField(text, budget);
    expect(bytes(result)).toBeLessThanOrEqual(budget);
    expect(bytes(result)).toBeGreaterThan(budget - 4);
    expect(result).not.toContain("�");
    expect(JSON.stringify(text).startsWith(result)).toBe(true);
  }
});

test("truncate-field: passes values that fit the budget through unchanged", () => {
  expect(truncateField("é".repeat(49), 100)).toBe(JSON.stringify("é".repeat(49)));
  expect(truncateField("x".repeat(98), 100)).toBe(JSON.stringify("x".repeat(98)));
  expect(truncateField({ name: "café" })).toBe('{"name":"café"}');
  expect(truncateField(undefined)).toBe("null");
});
