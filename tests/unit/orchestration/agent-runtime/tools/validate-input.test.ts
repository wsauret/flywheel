import { describe, expect, it } from "bun:test";

import {
  formatToolInputProblems,
  validateToolInput,
} from "../../../../../src/orchestration/agent-runtime/tools/validate-input.js";

const SCHEMA = {
  type: "object",
  properties: {
    path: { type: "string" },
    limit: { type: "number" },
    depth: { type: "integer" },
    raw: { type: "boolean" },
    include: { type: "string", enum: ["all", "files", "directories"] },
    todos: {
      type: "array",
      items: {
        type: "object",
        properties: {
          content: { type: "string" },
          status: { type: "string", enum: ["pending", "completed"] },
        },
        required: ["content", "status"],
      },
    },
    bounded: { type: "array", maxItems: 2, items: { type: "string" } },
  },
  required: ["path"],
};

describe("validateToolInput", () => {
  it("reports unexpected parameters without a suggestion when nothing is close", () => {
    const problems = validateToolInput({ path: ".", verbose: true }, SCHEMA);
    expect(problems).toEqual(["An unexpected parameter `verbose` was provided"]);
  });

  it("reports prototype-chain key names as unexpected (own-property semantics)", () => {
    const input = JSON.parse('{"path": ".", "toString": "x", "__proto__": {"polluted": true}}');
    const problems = validateToolInput(input, SCHEMA);
    expect(problems).toContain("An unexpected parameter `toString` was provided");
    expect(problems).toContain("An unexpected parameter `__proto__` was provided");
  });

  it("rejects floats where an integer is declared", () => {
    expect(validateToolInput({ path: ".", depth: 1.5 }, SCHEMA)).toEqual([
      "The parameter `depth` type is expected as `integer` but provided as `number`",
    ]);
  });

  it("reports null as null, not object", () => {
    expect(validateToolInput({ path: null }, SCHEMA)).toEqual([
      "The parameter `path` type is expected as `string` but provided as `null`",
    ]);
  });

  it("recurses into array items with indexed paths", () => {
    const problems = validateToolInput(
      { path: ".", todos: [{ content: "a", status: "pending" }, { content: "b" }, { status: 3, content: "c" }] },
      SCHEMA,
    );
    expect(problems).toEqual([
      "The required parameter `todos[1].status` is missing",
      'The parameter `todos[2].status` is expected as one of "pending", "completed" but provided as 3',
    ]);
  });

  it("rejects an oversized array before validating its items", () => {
    expect(validateToolInput({ path: ".", bounded: ["ok", "ok", 3] }, SCHEMA)).toEqual([
      "The parameter `bounded` has 3 items but allows at most 2",
    ]);
  });

  it("skips unknown-key checks when the schema opts out with additionalProperties", () => {
    const open = {
      type: "object",
      properties: { summary: { type: "string" } },
      additionalProperties: true,
    };
    expect(validateToolInput({ summary: "done", extra: 1, injectedMetadata: "preserved" }, open)).toEqual([]);
  });

  it("leaves untyped schema nodes unconstrained", () => {
    const open = { type: "object", properties: { anything: {} }, additionalProperties: true };
    expect(validateToolInput({ anything: ["mixed", 1, null] }, open)).toEqual([]);
  });

  it("validates unions, type arrays, constants, and open-map values", () => {
    for (const value of [
      { anyOf: [{ type: "number" }, { type: "boolean" }] },
      { oneOf: [{ type: "number" }, { type: "boolean" }] },
      { type: ["number", "boolean"] },
    ]) {
      const schema = { type: "object", properties: { value } };
      expect(validateToolInput({ value: false }, schema)).toEqual([]);
      expect(validateToolInput({ value: "false" }, schema).length).toBeGreaterThan(0);
    }
    expect(validateToolInput({ values: { count: "2" }, tag: "other" }, { type: "object", properties: {
      values: { type: "object", additionalProperties: { type: "number" } }, tag: { const: "known" },
    } })).toEqual([
      "The parameter `values.count` type is expected as `number` but provided as `string`",
      'The parameter `tag` is expected as one of "known" but provided as "other"',
    ]);
  });

  it("reports the selected discriminated case rather than the other cases", () => {
    const schema = { type: "object", properties: { result: { anyOf: [
      { type: "object", properties: { kind: { const: "text" }, value: { type: "string" } }, required: ["kind", "value"] },
      { type: "object", properties: { kind: { enum: ["number"] }, value: { type: "number" } }, required: ["kind", "value"] },
    ] } } };
    expect(validateToolInput({ result: { kind: "number", value: "2" } }, schema)).toEqual([
      "The parameter `result.value` type is expected as `number` but provided as `string`",
    ]);
  });
});

describe("formatToolInputProblems", () => {
  it("uses plural phrasing for several issues", () => {
    const message = formatToolInputProblems("read", ["a", "b"]);
    expect(message).toContain("read failed due to the following issues:");
  });
});
