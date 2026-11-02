import { describe, expect, it } from "bun:test";
import { JsonSyntaxError, parseJsonSource } from "../../../src/infra/json-source.js";

const DOCUMENT = [
  "{",
  '  "schema_version": 1,',
  '  "phases": [',
  "    {",
  '      "id": "p1",',
  '      "tasks": [',
  '        { "id": "t1" }',
  "      ]",
  "    }",
  "  ],",
  '  "context": { "constraints": [] }',
  "}",
].join("\n");

function failure(text: string): JsonSyntaxError {
  try {
    parseJsonSource(text);
  } catch (error) {
    if (error instanceof JsonSyntaxError) return error;
    throw error;
  }
  throw new Error("expected a JsonSyntaxError");
}

describe("parseJsonSource", () => {
  it("locates content after the end of the document", () => {
    const error = failure(`${DOCUMENT}\n{}`);
    expect(error.line).toBe(13);
    expect(error.reason).toBe("unexpected content after the end of the JSON document");
  });

  it("locates a raw line break inside a string", () => {
    const error = failure(DOCUMENT.replace('"p1"', '"p\n1"'));
    expect(error.line).toBe(5);
    expect(error.reason).toContain("unterminated string");
  });

  it("locates a trailing comma at the closing bracket that follows it", () => {
    const error = failure(DOCUMENT.replace('{ "id": "t1" }', '{ "id": "t1" },'));
    expect(error.line).toBe(8);
    expect(error.reason).toBe("expected a value");
  });

  it("rejects an empty document at its first line", () => {
    expect(failure("").line).toBe(1);
  });

});
