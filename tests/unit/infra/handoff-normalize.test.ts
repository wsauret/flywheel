import { describe, expect, test } from "bun:test";

import { collapsedMarkup, splitCollapsedValue } from "../../../src/infra/handoff-normalize.js";

describe("splitCollapsedValue", () => {
  test("splits closed element fragments after the field's own closer", () => {
    expect(splitCollapsedValue("summary", 'Done.</summary>\n<artifacts>{"files_created": []}</artifacts>\n</invoke>\n')).toEqual({
      value: "Done.",
      fragments: [{ name: "artifacts", body: '{"files_created": []}' }],
    });
  });

  test("keeps a prose body as written, so a string field reads as text", () => {
    const cause =
      "The loop bound used <= instead of <.</cause>\n" +
      "<red_result>FAIL tests/range.test.ts > range > counts the last item\nexpected 3, received 4</red_result>\n" +
      '<findings>[{"file": "src/range.ts", "issue": "inclusive bound"}]</findings>\n' +
      "</invoke>";

    expect(splitCollapsedValue("cause", cause)).toEqual({
      value: "The loop bound used <= instead of <.",
      fragments: [
        { name: "red_result", body: "FAIL tests/range.test.ts > range > counts the last item\nexpected 3, received 4" },
        { name: "findings", body: '[{"file": "src/range.ts", "issue": "inclusive bound"}]' },
      ],
    });
  });

  test("splits wire-format parameter fragments after a wire-format prose boundary", () => {
    const redResult =
      "FAIL tests/range.test.ts: expected 3, received 4</parameter>\n" +
      '<parameter name="cause">The loop bound used <= instead of <.</parameter>\n' +
      '<parameter name="commands_run">[{"call_id": "toolu_01", "exit_code": 1}]</parameter>\n' +
      "</invoke>\n</function_calls>";

    expect(splitCollapsedValue("red_result", redResult)).toEqual({
      value: "FAIL tests/range.test.ts: expected 3, received 4",
      fragments: [
        { name: "cause", body: "The loop bound used <= instead of <." },
        { name: "commands_run", body: '[{"call_id": "toolu_01", "exit_code": 1}]' },
      ],
    });
  });

  test("reads a trailing unclosed fragment to the end, without its leaked scaffolding", () => {
    expect(splitCollapsedValue("summary", 'Implemented all phases.</summary>\n<artifacts>{"files_created": ["a.ts"]}')).toEqual({
      value: "Implemented all phases.",
      fragments: [{ name: "artifacts", body: '{"files_created": ["a.ts"]}' }],
    });
    expect(splitCollapsedValue("summary", 'Done.</summary>\n<artifacts>{"files_created": []}\n</invoke>\n</function_calls>')).toEqual({
      value: "Done.",
      fragments: [{ name: "artifacts", body: '{"files_created": []}' }],
    });
    expect(splitCollapsedValue("summary", 'Done.</summary>\n<parameter name="artifacts">{"files_created": ["a.ts"]}')).toEqual({
      value: "Done.",
      fragments: [{ name: "artifacts", body: '{"files_created": ["a.ts"]}' }],
    });
  });

  test("reads a trailing unclosed fragment whose open tag is mangled", () => {
    expect(splitCollapsedValue("summary", 'Done.</summary>\n<artifacts">{"files_modified": ["b.ts"]}')).toEqual({
      value: "Done.",
      fragments: [{ name: "artifacts", body: '{"files_modified": ["b.ts"]}' }],
    });
  });

  test("drops empty fragments and bare tool-call scaffolding", () => {
    expect(splitCollapsedValue("summary", 'Elegance review prose.</summary>\n<parameter name="files_modified">')).toEqual({ value: "Elegance review prose.", fragments: [] });
    expect(splitCollapsedValue("summary", 'Done.</summary>\n<invoke name="handoff">\n<parameter name="artifacts">\n</parameter>\n</invoke>\n</function_calls>')).toEqual({ value: "Done.", fragments: [] });
    expect(splitCollapsedValue("summary", "Reviewed the change. No findings.</parameter>\n</invoke>\n")).toEqual({ value: "Reviewed the change. No findings.", fragments: [] });
    expect(splitCollapsedValue("summary", "A valid summary.</summary>\n")).toEqual({ value: "A valid summary.", fragments: [] });
  });

  test("finds no split when text that is not a fragment follows the boundary", () => {
    expect(splitCollapsedValue("summary", 'Done.</summary>\n<artifacts>{"files_created": []}</artifacts>\n trailing prose\n</invoke>\n')).toBeUndefined();
    expect(splitCollapsedValue("summary", "I removed the </summary> mention from the docs but kept everything else.")).toBeUndefined();
    expect(splitCollapsedValue("summary", "The validator rejects </parameter> tags embedded in argument values.")).toBeUndefined();
  });

  test("finds no split in prose that only ends with a quoted wire closer or has no tag", () => {
    expect(splitCollapsedValue("summary", "The fix strips the trailing terminator, for example </invoke>")).toBeUndefined();
    expect(splitCollapsedValue("summary", "Refactored the comparator so a < b and b > c evaluate correctly.")).toBeUndefined();
  });
});

describe("collapsedMarkup", () => {
  test("finds the seam where one serialized argument ends and the next begins", () => {
    expect(collapsedMarkup("summary", 'Done.</summary>\n<artifacts>{"files_created": []}</artifacts>\n</invoke>\n')).toBe("</artifacts>");
    expect(collapsedMarkup("summary", "Done.</summary>\n<artifacts>not json")).toBe("</summary>");
    expect(collapsedMarkup("summary", 'Done.</parameter>\n<parameter name="blockers">[]')).toBe("</parameter>");
  });

  test("finds none in prose that quotes a tag or ends with one", () => {
    expect(collapsedMarkup("summary", "Wraps it as `<summary>...</summary>` before sending.")).toBeUndefined();
    expect(collapsedMarkup("summary", "The validator rejects </parameter> tags in values.")).toBeUndefined();
    expect(collapsedMarkup("summary", "Done.</summary>")).toBeUndefined();
    // Another field's closer before an ordinary tag is quoted markup, not a seam.
    expect(collapsedMarkup("summary", "Renders </b> <i>text</i> inline.")).toBeUndefined();
  });
});
