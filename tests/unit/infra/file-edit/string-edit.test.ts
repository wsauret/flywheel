import { describe, expect, it } from "bun:test";

import { FILE_EDIT_LIMITS, FileEditPlanError } from "../../../../src/infra/file-edit/contract.js";
import { finishStringEdit, matchStringEdit, planStringEdit, type StringEdit } from "../../../../src/infra/file-edit/string-edit.js";

function edit(oldString: string, newString: string, replaceAll = false): StringEdit {
  return replaceAll ? { oldString, newString, replaceAll } : { oldString, newString };
}

function refusal(contents: string, change: StringEdit, limits = FILE_EDIT_LIMITS): string {
  try {
    planStringEdit(contents, change, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(FileEditPlanError);
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a refusal");
}

describe("string edit planner", () => {
  it("matches before replacement-dependent validation and finishes from the selected tier", () => {
    const match = matchStringEdit("one\r\ntwo\r\n", "one\ntwo\n");
    expect(match.matchKind).toBe("line-ending");
    expect(finishStringEdit("one\r\ntwo\r\n", match, { newString: "uno\ndos\n" })).toEqual({
      content: "uno\r\ndos\r\n",
      spans: [{ start: 0, end: 10 }],
      matchKind: "line-ending",
    });
    expect(() => finishStringEdit("one\r\ntwo\r\n", match, { newString: "one\ntwo\n" })).toThrow("the replacement produced no change");
  });

  it("plans an exact match with UTF-8 byte spans", () => {
    expect(planStringEdit("one two", edit("two", "three"))).toEqual({ content: "one three", spans: [{ start: 4, end: 7 }], matchKind: "exact" });
    expect(planStringEdit("α two", edit("two", "three"))).toEqual({ content: "α three", spans: [{ start: 3, end: 6 }], matchKind: "exact" });
    expect(planStringEdit("one one", edit("one", "one"))).toEqual({ content: "one one", spans: [], matchKind: "exact" });
  });

  it("orders the recovery tiers and preserves source bytes around the match", () => {
    const source = "\uFEFFfirst\r\n  say \u201chello\u201d  \nlast\r";
    const result = planStringEdit(source, edit("say \"hello\"", "say goodbye"));
    expect(result.matchKind).toBe("unicode-typography");
    expect(result.content).toBe("\uFEFFfirst\r\n  say goodbye  \nlast\r");
    const bytes = Buffer.from(source, "utf8");
    expect(bytes.subarray(0, result.spans[0]?.start).toString()).toBe("\uFEFFfirst\r\n  ");
    expect(bytes.subarray(result.spans[0]?.end).toString()).toBe("  \nlast\r");
  });

  it("matches across line-ending styles and writes the source style", () => {
    expect(planStringEdit("one\r\ntwo\r\n", edit("one\ntwo\n", "uno\ndos\n"))).toMatchObject({ content: "uno\r\ndos\r\n", matchKind: "line-ending" });
  });

  it("accepts only active, fully proven display prefixes", () => {
    for (const oldString of ["1|alpha\n2|beta", "*1|alpha\n 2|beta"]) {
      expect(planStringEdit("alpha\nbeta\n", edit(oldString, "numbered new string literal"))).toMatchObject({ matchKind: "display-prefix", content: "numbered new string literal\n" });
    }
    expect(refusal("alpha\nbeta\n", edit("1aa|alpha\n2bb|beta", "no"))).toContain("no match after escape-normalized tier");
    expect(refusal("alpha\nbeta\n", edit("1|alpha\n*2|beta", "no"))).toContain("no match after escape-normalized tier");
    expect(refusal("alpha\nbeta\n", edit("1|alpha\n3|beta", "no"))).toContain("no match after escape-normalized tier");
  });

  it("uses every non-overlapping match from the first successful tier under replace_all", () => {
    expect(planStringEdit("x  \r\nx\t\n", edit("x", "y", true))).toEqual({ content: "y  \r\ny\t\n", spans: [{ start: 0, end: 1 }, { start: 5, end: 6 }], matchKind: "exact" });
    expect(planStringEdit("x\r\nx\nx\r", edit("x", "a\nb", true))).toEqual({
      content: "a\r\nb\r\na\nb\na\rb\r",
      spans: [{ start: 0, end: 1 }, { start: 3, end: 4 }, { start: 5, end: 6 }],
      matchKind: "exact",
    });
    expect(refusal("aaa", edit("aa", "x", true))).toBe("replacement spans overlap");
  });

  it("refuses ambiguity at the first successful tier and names the candidates", () => {
    expect(refusal("first\nalpha\nmiddle\nalpha\nlast\n", edit("alpha", "beta"))).toBe("string edit refused at exact tier: 2 matches; nearest lines: line 2: alpha; line 4: alpha");
  });

  it("re-indents through the uniform-indent tier", () => {
    expect(planStringEdit("fn main() {\r\n    one\r\n    two\r\n}\r\n", edit("one\ntwo", "uno\ndos"))).toMatchObject({ matchKind: "uniform-indent", content: "fn main() {\r\n    uno\r\n    dos\r\n}\r\n" });
    expect(planStringEdit("fn main() {\n\tone\n\ttwo\n}\n", edit("one\ntwo", "uno\ndos"))).toMatchObject({ matchKind: "uniform-indent", content: "fn main() {\n\tuno\n\tdos\n}\n" });
    expect(planStringEdit("  one\n  two\n", edit("\t  one\n\t  two", "\t  uno\n\t  dos"))).toMatchObject({ matchKind: "uniform-indent", content: "  uno\n  dos\n" });
  });

  it("refuses nonuniform indentation changes", () => {
    expect(refusal("\tone\n two\n", edit("one\ntwo", "uno\ndos"))).toContain("no match after escape-normalized tier");
  });

  it("restores the adjacent boundary style for multi-line replacements", () => {
    expect(planStringEdit("first\r\nsecond\nthird\r\n", edit("second", "changed\ncontinued")).content).toBe("first\r\nchanged\ncontinued\nthird\r\n");
    const cases: readonly [string, string, string][] = [
      ["first\nsecond\nthird\n", "changed\r\ncontinued", "first\nchanged\ncontinued\nthird\n"],
      ["first\r\nsecond\r\nthird\r\n", "changed\rcontinued", "first\r\nchanged\r\ncontinued\r\nthird\r\n"],
      ["first\r\nsecond\nthird\r\n", "changed\r\ncontinued", "first\r\nchanged\ncontinued\nthird\r\n"],
    ];
    for (const [source, replacement, expected] of cases) expect(planStringEdit(source, edit("second", replacement)).content).toBe(expected);
  });

  it("maps normalized matches back to source bytes across unicode and CRLF boundaries", () => {
    const typography = planStringEdit("α\r\nsay — hi\r\nω", edit("say - hi\n", "changed\n"));
    expect(typography).toEqual({ content: "α\r\nchanged\r\nω", spans: [{ start: Buffer.byteLength("α\r\n"), end: Buffer.byteLength("α\r\nsay — hi\r\n") }], matchKind: "unicode-typography" });
    const trailing = planStringEdit("é\r\nword  \r\n終", edit("word\n", "changed\n"));
    expect(trailing).toEqual({ content: "é\r\nchanged\r\n終", spans: [{ start: Buffer.byteLength("é\r\n"), end: Buffer.byteLength("é\r\nword  \r\n") }], matchKind: "trailing-whitespace" });
  });

  it("decodes literal escape sequences a serialized call carried, in both fields", () => {
    const result = planStringEdit("a\n\tb\nc\n", edit("a\\n\\tb", "x\\n\\ty"));
    expect(result).toMatchObject({ matchKind: "escape-normalized", content: "x\n\ty\nc\n", spans: [{ start: 0, end: 4 }] });
    // A file that really holds the literal sequence matches exactly and stays literal.
    expect(planStringEdit("sep = \"\\t\"\n", edit("\"\\t\"", "\"\\n\""))).toMatchObject({ matchKind: "exact", content: "sep = \"\\n\"\n" });
  });

  it("writes the replacement in the quote style of the text it matched", () => {
    const curly = planStringEdit("say \u201chello\u201d to \u2018them\u2019 and don\u2019t\n", edit("say \"hello\" to 'them' and don't", "say \"bye\" to 'you' (or 'us') and won't"));
    expect(curly).toMatchObject({ matchKind: "unicode-typography", content: "say \u201cbye\u201d to \u2018you\u2019 (or \u2018us\u2019) and won\u2019t\n" });
    // Only a quote kind that the match folded changes; the file's straight apostrophe stays straight.
    expect(planStringEdit("\u201ca\u201d it's\n", edit("\"a\" it's", "\"b\" it's")).content).toBe("\u201cb\u201d it's\n");
    // The reverse: the model wrote curly quotes that the file does not have.
    expect(planStringEdit("say \"hello\"\n", edit("say \u201chello\u201d", "say \u201cbye\u201d")).content).toBe("say \"bye\"\n");
  });

  it("matches characters that the file or the call wrote as \\uXXXX escapes, and keeps the file's form", () => {
    expect(planStringEdit("s = \"caf\\u00E9\"\n", edit("\"caf\u00e9\"", "\"na\u00efve caf\u00e9\""))).toMatchObject({ matchKind: "unicode-escape", content: "s = \"na\\u00EFve caf\\u00E9\"\n" });
    expect(planStringEdit("s = \"caf\u00e9\"\n", edit("\"caf\\u00e9\"", "\"caf\\u00e9s\""))).toMatchObject({ matchKind: "unicode-escape", content: "s = \"caf\u00e9s\"\n" });
    // An escaped backslash before `u` is no escape.
    expect(refusal("s = \"caf\\\\u00e9\"\n", edit("caf\u00e9", "cafe"))).toContain("no match after escape-normalized tier");
  });

  it("refuses literal differences within matching block boundaries", () => {
    const source = "function a() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n";
    expect(refusal(source, edit("function a() {\n  const x = 1;\n  const y = 22;\n  return x + y;\n}", "function a() {\n  return 3;\n}"))).toContain("no match after escape-normalized tier");
    const unalike = `function a() {\n  ${"Z".repeat(40)}\n  ${"Q".repeat(40)}\n  ${"W".repeat(40)}\n}`;
    expect(refusal(source, edit(unalike, "z"))).toContain("no match after escape-normalized tier");
    const twice = "if (a) {\n  one 1\n}\nif (a) {\n  one 2\n}\n";
    expect(refusal(twice, edit("if (a) {\n  one 3\n}", "gone"))).toBe("string edit refused: no match after escape-normalized tier; nearest lines: line 1: if (a) {; line 4: if (a) {");
    expect(refusal(twice, edit("if (a) {\n  three\n}", "gone"))).toContain("no match after escape-normalized tier");
  });

  it("refuses literal differences even when the indentation shift is uniform", () => {
    expect(refusal("  start\n  middle 1\n  end\n", edit("start\nmiddle 2\nend", "start\nchanged\nend"))).toContain("no match after escape-normalized tier");
  });

  it("rejects empty, binary, and oversized input", () => {
    const limits = { ...FILE_EDIT_LIMITS, maxOutputBytes: 2 };
    expect(refusal("a", edit("", "b"), limits)).toBe("old_string must not be empty");
    expect(refusal("a\0b", edit("a", "b"), limits)).toBe("binary content cannot be edited");
    expect(refusal("a", edit("a", "long"), limits)).toBe("operation exceeds string edit bytes limit");
    expect(refusal("abc", edit("abc", "de"), { ...FILE_EDIT_LIMITS, maxOutputBytes: 4 })).toBe("operation exceeds string edit bytes limit");
    expect(refusal("abcd", edit("abc", "de"), { ...FILE_EDIT_LIMITS, maxOutputBytes: 3 })).toBe("operation exceeds input bytes limit");
    expect(refusal("abc", edit("c", "de"), { ...FILE_EDIT_LIMITS, maxOutputBytes: 3 })).toBe("operation exceeds output bytes limit");
    expect(refusal("a  \n", edit("a\n", "a  \n"))).toBe("the replacement produced no change");
  });

  it("reports at most three deterministic nearest lines when nothing matches", () => {
    const diagnostic = refusal("header\nalpha one\nalpha two\nalpha three\nalpha four\nfooter\n", edit("alpha missing", "replacement"));
    expect(diagnostic).toStartWith("string edit refused: no match after escape-normalized tier; nearest lines: ");
    expect(diagnostic.match(/line /g)).toHaveLength(3);
    expect(diagnostic).toContain("line 2: alpha one");
    expect(diagnostic).toContain("line 3: alpha two");
    expect(diagnostic).toContain("line 4: alpha three");
    expect(diagnostic).not.toContain("alpha four");
    expect(refusal("nothing shared\n", edit("zzz", "y"))).toEndWith("nearest lines: none");
  });
});
