import { describe, expect, test } from "bun:test";
import { parseToolArguments } from "../../../../src/infra/llm/json-parse.js";

describe("parseToolArguments", () => {
  test("parses bare valid JSON", () => {
    expect(parseToolArguments('{"a": 1, "b": "x"}')).toEqual({ input: { a: 1, b: "x" } });
  });

  test("returns empty input without parseError for empty input", () => {
    expect(parseToolArguments("")).toEqual({ input: {} });
    expect(parseToolArguments(undefined)).toEqual({ input: {} });
  });

  test("repairs raw control characters in string values", () => {
    expect(parseToolArguments('{"a": "line1\nline2"}')).toEqual({ input: { a: "line1\nline2" } });
  });

  describe("incomplete argument text", () => {
    // A buffer that is a prefix of a valid document is what an output-length
    // cut or a dropped stream leaves behind. Completing it would execute the
    // tool with a silently shortened value, so it is refused, not salvaged.
    test("refuses a truncated object instead of completing it", () => {
      const result = parseToolArguments('{"a": 1, "b": "incomplete');
      expect(result.input).toEqual({});
      expect(result.parseError).toContain("incomplete JSON");
      expect(result.parseError).toContain("cut off");
      expect(result.parseError).toContain('{"a": 1, "b": "incomplete');
    });

    test("refuses a write whose content string was cut mid-value", () => {
      const cut = '{"path": "a.ts", "content": "export const a = 1;\nexport const b = ';
      const result = parseToolArguments(cut);
      expect(result.input).toEqual({});
      expect(result.parseError).toContain("incomplete JSON");
    });

    test("refuses an object cut between members", () => {
      const result = parseToolArguments('{"a": 1,');
      expect(result.input).toEqual({});
      expect(result.parseError).toContain("incomplete JSON");
    });

    test("shows the end of a long truncated text, where the cut is", () => {
      const cut = `{"summary": "${"x".repeat(900)} the last words before the cut`;
      const result = parseToolArguments(cut);
      expect(result.parseError).toContain("cut off");
      expect(result.parseError).toContain(`${cut.length} characters`);
      expect(result.parseError).toContain("the last words before the cut");
      expect((result.parseError ?? "").length).toBeLessThan(500);
    });
  });

  describe("complete but invalid argument text", () => {
    // A closed text with a syntax error is not a cut call. The message names
    // the position of the error and shows the text on each side of it, so the
    // model can correct the error instead of re-sending the same text.
    function invalidAt(raw: string, character: number): string {
      const result = parseToolArguments(raw);
      expect(result.input).toEqual({});
      expect(result.parseError).toContain(`not valid JSON at character ${character} of ${raw.length}`);
      expect(result.parseError).not.toContain("incomplete");
      expect(result.parseError).not.toContain("cut off");
      return result.parseError ?? "";
    }

    test("locates an unescaped quote after the first 600 characters", () => {
      const raw = `{"summary": "${"x".repeat(700)}", "evidence": ["the user saw "Doom loop detected" after the wait"]}`;
      const message = invalidAt(raw, raw.indexOf('"Doom') + 1);
      expect(message).toContain("unescaped quote inside a string");
      expect(message).toContain('the user saw <<HERE>>"Doom loop detected" after the wait');
      expect(message.length).toBeLessThan(500);
    });

    test("reports a trailing comma", () => {
      expect(invalidAt('{"a": 1,}', 8)).toContain("trailing comma");
      expect(invalidAt('{"a": [1, 2,]}', 12)).toContain("trailing comma");
    });

    test("reports text after the closing brace", () => {
      expect(invalidAt('{"a": "x"}}', 11)).toContain("after the end of the JSON value");
    });

    test("reports NaN as an invalid value", () => {
      expect(invalidAt('{"a": NaN}', 7)).toContain("expected a JSON value");
    });

    test("reports single-quoted strings", () => {
      expect(invalidAt("{'a': 1}", 2)).toContain("double quotes");
    });

    test("locates the error inside a stripped envelope in the original text", () => {
      const raw = 'Here is the result:\n{"a": "say "hi" now"}';
      expect(invalidAt(raw, raw.indexOf('"hi') + 1)).toContain("unescaped quote inside a string");
    });
  });

  describe("envelope stripping", () => {
    test("strips a json-tagged markdown code fence", () => {
      const fenced = '```json\n{"a": 1, "b": "x"}\n```';
      expect(parseToolArguments(fenced)).toEqual({ input: { a: 1, b: "x" } });
    });

    test("strips a bare markdown code fence", () => {
      const fenced = '```\n{"a": 1}\n```';
      expect(parseToolArguments(fenced)).toEqual({ input: { a: 1 } });
    });

    test("strips trailing prose after a complete object", () => {
      const trailing = '{"a": 1}\n\nNote: I have completed the task.';
      expect(parseToolArguments(trailing)).toEqual({ input: { a: 1 } });
    });

    test("strips leading prose before a complete object", () => {
      const leading = 'Here is the result:\n{"a": 1}';
      expect(parseToolArguments(leading)).toEqual({ input: { a: 1 } });
    });

    test("does not reshape bare JSON whose string values contain brackets", () => {
      expect(parseToolArguments('{"a": "} not the end {"}')).toEqual({ input: { a: "} not the end {" } });
    });
  });

  describe("parse failure feedback", () => {
    test("flags text that is not JSON and echoes the raw text", () => {
      const result = parseToolArguments("not json at all");
      expect(result.input).toEqual({});
      expect(result.parseError).toContain("not valid JSON at character 1 of 15");
      expect(result.parseError).toContain("<<HERE>>not json at all");
    });

    test("flags a non-object payload", () => {
      const result = parseToolArguments('```json\n[{"a": 1}]\n```');
      expect(result.input).toEqual({});
      expect(result.parseError).toContain("a JSON array");
    });

    test("bounds the raw snippet for huge argument text", () => {
      const result = parseToolArguments(`garbage ${"x".repeat(2000)}`);
      expect(result.parseError).toContain("of 2008");
      expect((result.parseError ?? "").length).toBeLessThan(400);
    });

    test("an unsalvageable provider string yields a typed parseError, never a raw SyntaxError", () => {
      // Fails strict parse and repair alike: the helper must surface the
      // module's typed parseError rather than letting JSON.parse's
      // SyntaxError escape the pure parser.
      expect(() => parseToolArguments("}{")).not.toThrow();
      const result = parseToolArguments("}{");
      expect(result.input).toEqual({});
      expect(result.parseError).toContain("not valid JSON at character 1 of 2");
    });
  });
});