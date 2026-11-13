import { describe, expect, test } from "bun:test";
import type { ToolInputRepair } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { coerceToolInput } from "../../../../../src/orchestration/agent-runtime/tools/coerce-input.js";
import { createEditDefinition } from "../../../../../src/orchestration/agent-runtime/tools/edit.js";
import { compileOutput } from "../../../../../src/workflows/output-contract/compile.js";

describe("coerceToolInput", () => {
  test("returns input unchanged when schema has no properties", () => {
    const input = { foo: "bar" };
    const out = coerceToolInput(input, { type: "object" });
    expect(out).toBe(input);
  });

  test("returns the same reference when nothing needs coercing", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const input = { name: "ada" };
    const out = coerceToolInput(input, schema);
    expect(out).toBe(input);
  });

  test("does not coerce keys absent from the input", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "number" }, name: { type: "string" } },
    };
    const out = coerceToolInput({ name: "ada" }, schema);
    expect(out).toEqual({ name: "ada" });
    expect("count" in out).toBe(false);
  });

  test("passes through unknown extra keys untouched", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const input = { name: "ada", extra: 42 };
    const out = coerceToolInput(input, schema);
    expect(out.extra).toBe(42);
    const inputWithPrototypeKey = JSON.parse('{"name": 42, "__proto__": {"injected": true}}');
    const repaired = coerceToolInput(inputWithPrototypeKey, schema);
    expect(Object.hasOwn(repaired, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(repaired)).toBe(Object.prototype);
  });

  // Every Anthropic route shows the model each key and enum value without its format characters
  // (tool-definition-text.ts), so the model writes them in that form.
  describe("a key or value in the text form that the model saw", () => {
    const schema = {
      type: "object",
      properties: {
        "k\u200Bey": { type: "string", enum: ["a\u2066b\u2069", "plain"] },
        nested: { type: "object", properties: { "i\uFEFFd": { const: "Ａ" } } },
      },
    };

    test("reads it as the declared key and value", () => {
      expect(coerceToolInput({ key: "ab", nested: { id: "A" } }, schema)).toEqual({ "k\u200Bey": "a\u2066b\u2069", nested: { "i\uFEFFd": "Ａ" } });
    });

    test("keeps the declared key when the input holds both", () => {
      expect(coerceToolInput({ "k\u200Bey": "plain", key: "ab" }, schema)).toEqual({ "k\u200Bey": "plain", key: "ab" });
    });

    test("keeps a value that is no declared value in any form", () => {
      expect(coerceToolInput({ key: "other" }, schema)).toEqual({ "k\u200Bey": "other" });
    });
  });

  describe("argument repair before validation", () => {
    const editSchema = {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
        nested: { type: "object", properties: { limit: { type: "number" } } },
        note: { type: ["string", "null"] },
      },
      required: ["path", "old_string", "new_string"],
    };
    const repairsOf = (input: { [key: string]: unknown }, schema: { [key: string]: unknown } = editSchema) => {
      const repairs: ToolInputRepair[] = [];
      return { output: coerceToolInput(input, schema, (repair) => repairs.push(repair)), repairs };
    };

    test("drops null for an optional field whose type excludes null, and records it", () => {
      expect(repairsOf({ path: "a.ts", old_string: "x", new_string: "y", replace_all: null, nested: { limit: null } })).toEqual({
        output: { path: "a.ts", old_string: "x", new_string: "y", nested: {} },
        repairs: [{ kind: "dropped_null", path: "replace_all" }, { kind: "dropped_null", path: "nested.limit" }],
      });
    });

    test("keeps null for a required field or a nullable one, for validation to judge", () => {
      const input = { path: "a.ts", old_string: null, new_string: "y", note: null };
      expect(repairsOf(input)).toEqual({ output: input, repairs: [] });
    });

    test("maps a synonym with the identical meaning onto the declared key", () => {
      expect(repairsOf({ file_path: "a.ts", old_text: "x", new_text: "y" })).toEqual({
        output: { path: "a.ts", old_string: "x", new_string: "y" },
        repairs: [
          { kind: "renamed_key", path: "path", from: "file_path" },
          { kind: "renamed_key", path: "old_string", from: "old_text" },
          { kind: "renamed_key", path: "new_string", from: "new_text" },
        ],
      });
      // The declared key wins; the synonym stays for validation to refuse.
      expect(repairsOf({ path: "a.ts", file_path: "b.ts", old_string: "x", new_string: "y" }).repairs).toEqual([]);
    });

    test("reads unambiguous enum values across spelling and scalar types", () => {
      const searchSchema = { type: "object", properties: { output_mode: { type: "string", enum: ["matching_files", "content", "count"] } } };
      expect(repairsOf({ output_mode: "files_with_matches" }, searchSchema)).toEqual({
        output: { output_mode: "matching_files" },
        repairs: [{ kind: "renamed_value", path: "output_mode", from: "files_with_matches", to: "matching_files" }],
      });
      expect(repairsOf({ output_mode: "files" }, searchSchema).output).toEqual({ output_mode: "matching_files" });
      // A tool whose own enum declares `files` keeps it.
      const listSchema = { type: "object", properties: { include: { type: "string", enum: ["all", "files", "directories"] } } };
      expect(repairsOf({ include: "files" }, listSchema).repairs).toEqual([]);
      const mixed = compileOutput({ fields: { state: { type: "enum", values: [1, "unknown"] } } }).toolInput;
      expect(repairsOf({ summary: "done", state: "1" }, mixed)).toEqual({
        output: { summary: "done", state: 1 },
        repairs: [{ kind: "parsed_value", path: "state", type: "number" }],
      });
      const text = compileOutput({ fields: { state: { type: "enum", values: [1, "2"] } } }).toolInput;
      expect(repairsOf({ summary: "done", state: 2 }, text)).toEqual({
        output: { summary: "done", state: "2" },
        repairs: [{ kind: "stringified_value", path: "state" }],
      });
      for (const state of [1, "unknown"]) {
        const input = { summary: "done", state };
        expect(coerceToolInput(input, mixed)).toBe(input);
      }
      const ambiguous = compileOutput({ fields: { state: { type: "enum", values: [1, "1_"] } } }).toolInput;
      const input = { summary: "done", state: "1 " };
      expect(repairsOf(input, ambiguous)).toEqual({ output: input, repairs: [] });
    });

    test("drops a top-level windowsHide that the schema does not declare", () => {
      const bashSchema = { type: "object", properties: { command: { type: "string" } }, required: ["command"] };
      expect(repairsOf({ command: "ls", windowsHide: true }, bashSchema)).toEqual({
        output: { command: "ls" },
        repairs: [{ kind: "dropped_key", path: "windowsHide" }],
      });
    });

    test("parses a text value into the declared type only when the parse yields that type, and records it", () => {
      const schema = {
        type: "object",
        properties: {
          limit: { type: "number" },
          count: { type: "integer" },
          all: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          options: { type: "object", properties: { depth: { type: "integer" } } },
        },
      };
      expect(repairsOf({ limit: " +2.5 ", count: "3", all: "TRUE", tags: "[\"a\"]", options: "{\"depth\": \"2\"}" }, schema)).toEqual({
        output: { limit: 2.5, count: 3, all: true, tags: ["a"], options: { depth: 2 } },
        repairs: [
          { kind: "parsed_value", path: "limit", type: "number" },
          { kind: "parsed_value", path: "count", type: "integer" },
          { kind: "parsed_value", path: "all", type: "boolean" },
          { kind: "parsed_value", path: "tags", type: "array" },
          { kind: "parsed_value", path: "options", type: "object" },
          { kind: "parsed_value", path: "options.depth", type: "integer" },
        ],
      });
      const unparsed = { limit: "0x10", count: "3.5", all: "yes", options: "[1]" };
      expect(repairsOf(unparsed, schema)).toEqual({ output: unparsed, repairs: [] });
      // A model that writes a list of edits as JSON text often leaves raw line breaks and
      // regex backslashes unescaped in it; the text reads with the tool-argument repair tier.
      const editInput = coerceToolInput({ path: "a.ts", edits: "[{\"old_string\": \"a\n\tb\", \"new_string\": \"\\d+\"}]" }, createEditDefinition().inputSchema);
      expect(editInput).toEqual({ path: "a.ts", edits: [{ old_string: "a\n\tb", new_string: "\\d+" }] });
    });

    // Claude Haiku 5.5 sent this `edits` text in a terminal-bench trial: its own parameter syntax opens the
    // entry, old_string follows raw, and new_string follows as one JSON string with no closing `}]`.
    test("reads a one-entry list whose first value is raw text in mixed parameter syntax, and records it", () => {
      const edits = "[{\"old_string\">  // hyperprior (improper in the flat sense, proper enough given the data)\n  target += -2.5 * log(alpha + beta);, \"new_string\": \"  // hyperprior p(alpha, beta) proportional to (alpha + beta)^(-5/2)\\n  target += -2.5 * log(alpha + beta);\"";
      const schema = createEditDefinition().inputSchema;
      expect(repairsOf({ path: "/app/hierarchical_model.stan", edits }, schema)).toEqual({
        output: {
          path: "/app/hierarchical_model.stan",
          edits: [{
            old_string: "  // hyperprior (improper in the flat sense, proper enough given the data)\n  target += -2.5 * log(alpha + beta);",
            new_string: "  // hyperprior p(alpha, beta) proportional to (alpha + beta)^(-5/2)\n  target += -2.5 * log(alpha + beta);",
          }],
        },
        repairs: [{ kind: "read_mixed_entry", path: "edits", raw: "old_string", encoded: "new_string" }],
      });
      // A separator that occurs twice, an entry closed with `}]`, or a JSON key opening stays as written.
      for (const nearMiss of [
        "[{\"old_string\">a, \"new_string\": \"b, \"new_string\": \"c\"",
        "[{\"old_string\">a, \"new_string\": \"b\"}]",
        "[{\"old_string\": a, \"new_string\": \"b\"",
      ]) {
        expect(repairsOf({ path: "a.ts", edits: nearMiss }, schema)).toEqual({ output: { path: "a.ts", edits: nearMiss }, repairs: [] });
      }
    });

    test("decodes double-escaped non-ASCII \\uXXXX escapes in a text value, and records it", () => {
      const schema = { type: "object", properties: { content: { type: "string" }, lines: { type: "array", items: { type: "string" } } } };
      expect(repairsOf({ content: "caf\\u00e9 \\ud83d\\ude00", lines: ["na\\u00EFve"] }, schema)).toEqual({
        output: { content: "caf\u00e9 \ud83d\ude00", lines: ["na\u00efve"] },
        repairs: [{ kind: "decoded_escapes", path: "content" }, { kind: "decoded_escapes", path: "lines.0" }],
      });
      // ASCII and control escapes, an escaped backslash, a lone surrogate, and a Windows path stay as written.
      for (const content of ["\\u0041\\u001b", "\\\\u00e9", "\\ud83d alone", "C:\\Users\\u00e9"]) {
        expect(repairsOf({ content }, schema)).toEqual({ output: { content }, repairs: [] });
      }
      // A raw-text tool's arguments are file text, so they stay as written.
      const repairs: ToolInputRepair[] = [];
      expect(coerceToolInput({ content: "caf\\u00e9" }, schema, (repair) => repairs.push(repair), { verbatimText: true })).toEqual({ content: "caf\\u00e9" });
      expect(repairs).toEqual([]);
      for (const union of [
        { type: ["string", "null"] },
        { anyOf: [{ type: "string" }, { type: "number" }] },
        { oneOf: [{ type: "string" }, { type: "boolean" }] },
      ]) {
        const unionSchema = { type: "object", properties: { content: union } };
        expect(repairsOf({ content: "caf\\u00e9" }, unionSchema)).toEqual({
          output: { content: "café" },
          repairs: [{ kind: "decoded_escapes", path: "content" }],
        });
        expect(coerceToolInput({ content: "caf\\u00e9" }, unionSchema, undefined, { verbatimText: true })).toEqual({ content: "caf\\u00e9" });
      }
      const objectUnion = { type: "object", properties: { nested: { anyOf: [
        { type: "object", properties: { text: { type: "string" }, literal: { type: ["string", "object"] } } },
        { type: "null" },
      ] } } };
      expect(repairsOf({ nested: { text: "caf\\u00e9", literal: '{"count":1}' } }, objectUnion)).toEqual({
        output: { nested: { text: "café", literal: '{"count":1}' } },
        repairs: [{ kind: "decoded_escapes", path: "nested.text" }],
      });
    });

    test("keeps any other unknown key, which could change the call's meaning", () => {
      const input = { path: "a.ts", old_string: "x", new_string: "y", literal: true, count: true };
      expect(repairsOf(input)).toEqual({ output: input, repairs: [] });
    });
  });

  describe("number", () => {
    const schema = { type: "object", properties: { n: { type: "number" } } };

    test("coerces numeric string to number", () => {
      expect(coerceToolInput({ n: "42" }, schema)).toEqual({ n: 42 });
    });

    test("trims whitespace before parsing", () => {
      expect(coerceToolInput({ n: "  42 " }, schema)).toEqual({ n: 42 });
    });

    test("leaves non-numeric string unchanged", () => {
      expect(coerceToolInput({ n: "abc" }, schema)).toEqual({ n: "abc" });
    });

    test("leaves empty string unchanged", () => {
      expect(coerceToolInput({ n: "" }, schema)).toEqual({ n: "" });
    });

    test("does not coerce a number that arrived as a non-string", () => {
      const input = { n: 42 };
      const out = coerceToolInput(input, schema);
      expect(out).toBe(input);
    });

    test("preserves NaN/Infinity strings as-is", () => {
      expect(coerceToolInput({ n: "NaN" }, schema)).toEqual({ n: "NaN" });
      expect(coerceToolInput({ n: "Infinity" }, schema)).toEqual({ n: "Infinity" });
    });
  });

  describe("integer", () => {
    const schema = { type: "object", properties: { n: { type: "integer" } } };

    test("coerces integer string to integer", () => {
      expect(coerceToolInput({ n: "42" }, schema)).toEqual({ n: 42 });
    });

    test("leaves fractional string unchanged (integer rejects floats)", () => {
      expect(coerceToolInput({ n: "3.9" }, schema)).toEqual({ n: "3.9" });
    });

    test("leaves fractional number unchanged", () => {
      const input = { n: 3.9 };
      const out = coerceToolInput(input, schema);
      expect(out).toBe(input);
    });

  });

  describe("boolean", () => {
    const schema = { type: "object", properties: { flag: { type: "boolean" } } };

    test("coerces 'true' to true", () => {
      expect(coerceToolInput({ flag: "true" }, schema)).toEqual({ flag: true });
    });

    test("is case-insensitive", () => {
      expect(coerceToolInput({ flag: "TRUE" }, schema)).toEqual({ flag: true });
      expect(coerceToolInput({ flag: "False" }, schema)).toEqual({ flag: false });
    });

    test("trims whitespace", () => {
      expect(coerceToolInput({ flag: "  true  " }, schema)).toEqual({ flag: true });
    });

    test("does not coerce '1' / '0' / 'yes' / 'no' — too ambiguous", () => {
      expect(coerceToolInput({ flag: "1" }, schema)).toEqual({ flag: "1" });
      expect(coerceToolInput({ flag: "yes" }, schema)).toEqual({ flag: "yes" });
    });

  });

  describe("string", () => {
    const schema = { type: "object", properties: { name: { type: "string" } } };

    test("reads numbers, booleans, and a one-item list as a string", () => {
      expect(coerceToolInput({ name: 42 }, schema)).toEqual({ name: "42" });
      expect(coerceToolInput({ name: false }, schema)).toEqual({ name: "false" });
      expect(coerceToolInput({ name: ["ada"] }, schema)).toEqual({ name: "ada" });
    });

  });

  describe("array", () => {
    test("wraps a bare scalar into a single-element array when the items kind matches", () => {
      const schema = {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" } } },
      };
      expect(coerceToolInput({ tags: "alpha" }, schema)).toEqual({ tags: ["alpha"] });
    });

    test("reports each wrap through the observer with the field path", () => {
      const schema = {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
          counts: { type: "array", items: { type: "number" } },
        },
      };
      const repairs: ToolInputRepair[] = [];
      const out = coerceToolInput({ tags: "alpha", counts: 5 }, schema, (repair) => repairs.push(repair));
      expect(out).toEqual({ tags: ["alpha"], counts: [5] });
      expect(repairs).toEqual([{ kind: "wrapped_in_array", path: "tags" }, { kind: "wrapped_in_array", path: "counts" }]);
    });

    test("does not wrap when the scalar's kind mismatches the items type", () => {
      const schema = {
        type: "object",
        properties: { counts: { type: "array", items: { type: "number" } } },
      };
      const repairs: ToolInputRepair[] = [];
      // A string for number items is a genuine type mismatch: stay loud.
      expect(coerceToolInput({ counts: "alpha" }, schema, (repair) => repairs.push(repair))).toEqual({ counts: "alpha" });
      expect(repairs).toEqual([]);
    });

    // A workflow step compiles a nullable list field to `type: ["array", "null"]`, and the Anthropic reader hands an
    // unquoted single item as the model's text. The step's own check refuses a bare string for a list.
    test("wraps a bare item of a nullable list as for a list, and keeps null", () => {
      const schema = {
        type: "object",
        properties: { evidence: { type: ["array", "null"], items: { type: ["string", "null"] } } },
      };
      const repairs: ToolInputRepair[] = [];
      expect(coerceToolInput({ evidence: 'one fact, with "quotes"' }, schema, (repair) => repairs.push(repair))).toEqual({ evidence: ['one fact, with "quotes"'] });
      expect(repairs).toEqual([{ kind: "wrapped_in_array", path: "evidence" }]);
      const empty = { evidence: null };
      expect(coerceToolInput(empty, schema)).toBe(empty);
    });

    test("does not wrap a value of a union that admits a type besides the list", () => {
      const schema = {
        type: "object",
        properties: { target: { type: ["array", "string"], items: { type: "string" } } },
      };
      const input = { target: "alpha" };
      expect(coerceToolInput(input, schema)).toBe(input);
    });

    test("does not wrap when the schema declares no items type", () => {
      const schema = {
        type: "object",
        properties: { anything: { type: "array" } },
      };
      expect(coerceToolInput({ anything: "alpha" }, schema)).toEqual({ anything: "alpha" });
    });

    test("leaves arrays unchanged when items already match", () => {
      const schema = {
        type: "object",
        properties: { tags: { type: "array", items: { type: "string" } } },
      };
      const input = { tags: ["alpha", "beta"] };
      const out = coerceToolInput(input, schema);
      expect(out).toBe(input);
    });

    test("coerces primitive items inside an array", () => {
      const schema = {
        type: "object",
        properties: { nums: { type: "array", items: { type: "number" } } },
      };
      expect(coerceToolInput({ nums: ["1", "2", "3"] }, schema)).toEqual({ nums: [1, 2, 3] });
    });

    test("parses JSON-array string and coerces items", () => {
      const schema = {
        type: "object",
        properties: { nums: { type: "array", items: { type: "number" } } },
      };
      expect(coerceToolInput({ nums: "[\"1\", \"2\", \"3\"]" }, schema)).toEqual({ nums: [1, 2, 3] });
    });

    test("recurses into object items", () => {
      const schema = {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                priority: { type: "number" },
                content: { type: "string" },
              },
            },
          },
        },
      };
      const out = coerceToolInput(
        { entries: [{ priority: "1", content: "ada" }, { priority: "2", content: "lovelace" }] },
        schema,
      );
      expect(out).toEqual({
        entries: [{ priority: 1, content: "ada" }, { priority: 2, content: "lovelace" }],
      });
    });
  });

  describe("object", () => {
    test("recurses into nested object properties", () => {
      const schema = {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: {
              retries: { type: "number" },
              verbose: { type: "boolean" },
            },
          },
        },
      };
      const out = coerceToolInput({ config: { retries: "3", verbose: "true" } }, schema);
      expect(out).toEqual({ config: { retries: 3, verbose: true } });
    });

    test("parses JSON-object string and recurses", () => {
      const schema = {
        type: "object",
        properties: {
          config: {
            type: "object",
            properties: { retries: { type: "number" } },
          },
        },
      };
      const out = coerceToolInput({ config: "{\"retries\": \"3\"}" }, schema);
      expect(out).toEqual({ config: { retries: 3 } });
    });

    test("leaves invalid JSON-object string unchanged", () => {
      const schema = {
        type: "object",
        properties: { config: { type: "object", properties: {} } },
      };
      expect(coerceToolInput({ config: "not json" }, schema)).toEqual({ config: "not json" });
    });
  });

  describe("realistic tool schemas", () => {
    test("reads Linear MCP id keys and uniquely normalized names", () => {
      const schema = { type: "object", properties: { project: { type: "string" }, team: { type: "string" }, output_mode: { enum: ["matching_files", "content"] } } };
      expect(coerceToolInput({ projectId: "p", team_id: "t", "Output-Mode": "Matching Files" }, schema)).toEqual({ project: "p", team: "t", output_mode: "matching_files" });
      const ambiguous = { type: "object", properties: { project: { type: "string" }, project_id: { type: "string" } } };
      expect(coerceToolInput({ ProjectId: "p" }, ambiguous)).toEqual({ ProjectId: "p" });
      expect(coerceToolInput({ projectId: "p", PROJECT: "q" }, schema)).toEqual({ projectId: "p", PROJECT: "q" });
      expect(coerceToolInput({ mode: "A B" }, { type: "object", properties: { mode: { enum: ["a_b", "a-b"] } } })).toEqual({ mode: "A B" });
    });

    test("unwraps exec parameters and converts open-map values", () => {
      const schema = { type: "object", properties: { command: { type: "string" }, flags: { type: "object", additionalProperties: { type: "boolean" } } } };
      expect(coerceToolInput({ parameters: { command: "pwd", flags: { verbose: "true" } } }, schema)).toEqual({ command: "pwd", flags: { verbose: true } });
      const open = { type: "object", properties: { project: { type: "string" } }, additionalProperties: true };
      const valid = { projectId: "p", windowsHide: true };
      expect(coerceToolInput(valid, open)).toBe(valid);
    });

    test("keeps valid union members and repairs only one possible member", () => {
      for (const union of [
        { anyOf: [{ type: "number" }, { type: "boolean" }] },
        { oneOf: [{ type: "number" }, { type: "boolean" }] },
        { type: ["number", "boolean"] },
      ]) {
        const schema = { type: "object", properties: { value: union } };
        expect(coerceToolInput({ value: "true" }, schema)).toEqual({ value: true });
        const input = { value: 1 };
        expect(coerceToolInput(input, schema)).toBe(input);
      }
      const ambiguous = { type: "object", properties: { value: { anyOf: [{ type: "number" }, { type: "integer" }] } } };
      const input = { value: "1" };
      expect(coerceToolInput(input, ambiguous)).toBe(input);
      const text = { type: "object", properties: { value: { anyOf: [{ type: "object" }, { type: "string" }] } } };
      const valid = { value: '{"count":1}' };
      expect(coerceToolInput(valid, text)).toBe(valid);
    });

    test("selects discriminated cases before converting their shared fields", () => {
      const variant = { oneOf: [
        { type: "object", properties: { kind: { const: "structured" }, value: { type: "object", additionalProperties: { type: "number" } } }, required: ["kind", "value"] },
        { type: "object", properties: { kind: { enum: ["text"] }, value: { type: "string" } }, required: ["kind", "value"] },
      ] };
      const schema = { type: "object", properties: { result: variant } };
      expect(coerceToolInput({ result: { kind: "structured", value: '{"count":"2"}' } }, schema)).toEqual({ result: { kind: "structured", value: { count: 2 } } });
      const text = { result: { kind: "text", value: '{"count":"2"}' } };
      expect(coerceToolInput(text, schema)).toBe(text);
    });
    

    

    test("repairs a stringified JSON array of objects", () => {
      const schema = {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                content: { type: "string" },
                status: { type: "string" },
              },
            },
          },
        },
      };
      const out = coerceToolInput(
        { entries: "[{\"content\": \"a\", \"status\": \"pending\"}]" },
        schema,
      );
      expect(out).toEqual({ entries: [{ content: "a", status: "pending" }] });
    });
  });

  describe("single-wrapper unwrap", () => {
    const schema = {
      type: "object",
      properties: { summary: { type: "string" }, count: { type: "number" } },
    };

    test("unwraps the whole argument object nested under a known wrapper key", () => {
      const out = coerceToolInput({ payload: { summary: "done", count: "3" } }, schema);
      expect(out).toEqual({ summary: "done", count: 3 });
    });

    test("unwraps and coerces a stringified wrapped object", () => {
      const out = coerceToolInput({ task_content: '{"summary": "done", "count": "3"}' }, schema);
      expect(out).toEqual({ summary: "done", count: 3 });
    });

    test("does not unwrap when the wrapper name is a declared property", () => {
      const inputSchema = { type: "object", properties: { content: { type: "object" } } };
      const input = { content: { summary: "x" } };
      expect(coerceToolInput(input, inputSchema)).toBe(input);
    });

    test("does not unwrap when there is more than one key", () => {
      const input = { payload: { summary: "x" }, extra: 1 };
      expect(coerceToolInput(input, schema)).toBe(input);
    });

    test("does not unwrap an unknown single key", () => {
      const input = { summary: "x" };
      expect(coerceToolInput(input, schema)).toBe(input);
    });
  });
});
