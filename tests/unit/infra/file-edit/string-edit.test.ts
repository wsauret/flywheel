import { describe, expect, it } from "bun:test";

import { FILE_EDIT_LIMITS, FileEditPlanError } from "../../../../src/infra/file-edit/contract.js";
import { planStringEdits, type StringEdit } from "../../../../src/infra/file-edit/string-edit.js";

function edit(oldString: string, newString: string, replaceAll = false): StringEdit {
  return replaceAll ? { oldString, newString, replaceAll } : { oldString, newString };
}

function plan(contents: string, change: StringEdit, limits = FILE_EDIT_LIMITS) {
  return planStringEdits(contents, [change], limits);
}

function refusal(contents: string, change: StringEdit | readonly StringEdit[], limits = FILE_EDIT_LIMITS): string {
  try {
    planStringEdits(contents, "oldString" in change ? [change] : change, limits);
  } catch (error) {
    expect(error).toBeInstanceOf(FileEditPlanError);
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected a refusal");
}

describe("string edit planner", () => {
  it("plans every edit against the text before the call, in any entry order, and reports spans in file order", () => {
    const source = "alpha beta gamma\r\ndelta\r\n";
    expect(planStringEdits(source, [edit("gamma\ndelta", "G\nD"), edit("alpha", "beta alpha"), edit("beta", "B")])).toEqual({
      content: "beta alpha B G\r\nD\r\n",
      spans: [{ start: 0, end: 5 }, { start: 6, end: 10 }, { start: 11, end: 23 }],
      matchKinds: ["line-ending", "exact", "exact"],
    });
    const mixed = "head\r\nmiddle\r\ntail\n";
    const entries = [edit("tail\n", "TAIL\n"), edit("head\n", "HEAD\n")];
    expect(planStringEdits(mixed, entries).content).toBe("HEAD\r\nmiddle\r\nTAIL\n");
    expect(planStringEdits(mixed, entries.toReversed()).content).toBe("HEAD\r\nmiddle\r\nTAIL\n");
  });

  it("refuses the whole call and names the failing entry", () => {
    const source = "one two one three\n";
    expect(refusal(source, [edit("two", "2"), edit("four", "4")])).toBe("edits[1]: string edit refused: no match after escape-normalized tier; nearest lines: none");
    expect(refusal(source, [edit("one", "1"), edit("two", "2")])).toBe("edits[0]: string edit refused at exact tier: 2 matches; nearest lines: line 1: one two one three; line 1: one two one three");
    expect(refusal(source, [edit("one two", "x"), edit("two one", "y")])).toBe("edits[0] and edits[1] overlap, so no entry was applied. Each old_string matches the file as it was before this call; merge overlapping entries into one.");
    expect(refusal(source, [edit("three", "3"), edit("aaa", "x", true)])).toContain("edits[1]: string edit refused: no match");
    expect(refusal("aaab", [edit("b", "b"), edit("aa", "b", true)])).toBe("edits[1]: replacement spans overlap");
  });

  it("checks an entry whose text is unchanged like any other but writes nothing for it", () => {
    const source = "one two one three\n";
    expect(refusal(source, [edit("two", "2"), edit("four", "four")])).toBe("edits[1]: string edit refused: no match after escape-normalized tier; nearest lines: none");
    expect(refusal(source, [edit("two", "2"), edit("one", "one")])).toContain("edits[1]: string edit refused at exact tier: 2 matches");
    expect(refusal(source, [edit("one two", "x"), edit("two", "two")])).toBe("edits[0] and edits[1] overlap, so no entry was applied. Each old_string matches the file as it was before this call; merge overlapping entries into one.");
    expect(planStringEdits(source, [edit("three", "three"), edit("two", "2")])).toEqual({ content: "one 2 one three\n", spans: [{ start: 4, end: 7 }], matchKinds: ["exact", "exact"] });
    expect(plan("one two", edit("one", "one"))).toEqual({ content: "one two", spans: [], matchKinds: ["exact"] });
  });

  it("plans an exact match with UTF-8 byte spans", () => {
    expect(plan("one two", edit("two", "three"))).toEqual({ content: "one three", spans: [{ start: 4, end: 7 }], matchKinds: ["exact"] });
    expect(plan("α two", edit("two", "three"))).toEqual({ content: "α three", spans: [{ start: 3, end: 6 }], matchKinds: ["exact"] });
  });

  it("orders the recovery tiers and preserves source bytes around the match", () => {
    const source = "\uFEFFfirst\r\n  say \u201chello\u201d  \nlast\r";
    const result = plan(source, edit("say \"hello\"", "say goodbye"));
    expect(result.matchKinds).toEqual(["unicode-typography"]);
    expect(result.content).toBe("\uFEFFfirst\r\n  say goodbye  \nlast\r");
    const bytes = Buffer.from(source, "utf8");
    expect(bytes.subarray(0, result.spans[0]?.start).toString()).toBe("\uFEFFfirst\r\n  ");
    expect(bytes.subarray(result.spans[0]?.end).toString()).toBe("  \nlast\r");
  });

  it("matches across line-ending styles and writes the source style", () => {
    expect(plan("one\r\ntwo\r\n", edit("one\ntwo\n", "uno\ndos\n"))).toMatchObject({ content: "uno\r\ndos\r\n", matchKinds: ["line-ending"] });
  });

  it("accepts only active, fully proven display prefixes", () => {
    for (const oldString of ["1|alpha\n2|beta", "*1|alpha\n 2|beta"]) {
      expect(plan("alpha\nbeta\n", edit(oldString, "numbered new string literal"))).toMatchObject({ matchKinds: ["display-prefix"], content: "numbered new string literal\n" });
    }
    expect(refusal("alpha\nbeta\n", edit("1aa|alpha\n2bb|beta", "no"))).toContain("no match after escape-normalized tier");
    expect(refusal("alpha\nbeta\n", edit("1|alpha\n*2|beta", "no"))).toContain("no match after escape-normalized tier");
    expect(refusal("alpha\nbeta\n", edit("1|alpha\n3|beta", "no"))).toContain("no match after escape-normalized tier");
  });

  it("uses every non-overlapping match from the first successful tier under replace_all", () => {
    expect(plan("x  \r\nx\t\n", edit("x", "y", true))).toEqual({ content: "y  \r\ny\t\n", spans: [{ start: 0, end: 1 }, { start: 5, end: 6 }], matchKinds: ["exact"] });
    expect(plan("x\r\nx\nx\r", edit("x", "a\nb", true))).toEqual({
      content: "a\r\nb\r\na\nb\na\rb\r",
      spans: [{ start: 0, end: 1 }, { start: 3, end: 4 }, { start: 5, end: 6 }],
      matchKinds: ["exact"],
    });
    expect(refusal("aaa", edit("aa", "x", true))).toBe("edits[0]: replacement spans overlap");
  });

  it("refuses ambiguity at the first successful tier and names the candidates", () => {
    expect(refusal("first\nalpha\nmiddle\nalpha\nlast\n", edit("alpha", "beta"))).toBe("edits[0]: string edit refused at exact tier: 2 matches; nearest lines: line 2: alpha; line 4: alpha");
  });

  it("re-indents through the uniform-indent tier", () => {
    expect(plan("fn main() {\r\n    one\r\n    two\r\n}\r\n", edit("one\ntwo", "uno\ndos"))).toMatchObject({ matchKinds: ["uniform-indent"], content: "fn main() {\r\n    uno\r\n    dos\r\n}\r\n" });
    expect(plan("fn main() {\n\tone\n\ttwo\n}\n", edit("one\ntwo", "uno\ndos"))).toMatchObject({ matchKinds: ["uniform-indent"], content: "fn main() {\n\tuno\n\tdos\n}\n" });
    expect(plan("  one\n  two\n", edit("\t  one\n\t  two", "\t  uno\n\t  dos"))).toMatchObject({ matchKinds: ["uniform-indent"], content: "  uno\n  dos\n" });
  });

  it("refuses nonuniform indentation changes", () => {
    expect(refusal("\tone\n two\n", edit("one\ntwo", "uno\ndos"))).toContain("no match after escape-normalized tier");
  });

  it("restores the adjacent boundary style for multi-line replacements", () => {
    expect(plan("first\r\nsecond\nthird\r\n", edit("second", "changed\ncontinued")).content).toBe("first\r\nchanged\ncontinued\nthird\r\n");
    const cases: readonly [string, string, string][] = [
      ["first\nsecond\nthird\n", "changed\r\ncontinued", "first\nchanged\ncontinued\nthird\n"],
      ["first\r\nsecond\r\nthird\r\n", "changed\rcontinued", "first\r\nchanged\r\ncontinued\r\nthird\r\n"],
      ["first\r\nsecond\nthird\r\n", "changed\r\ncontinued", "first\r\nchanged\ncontinued\nthird\r\n"],
    ];
    for (const [source, replacement, expected] of cases) expect(plan(source, edit("second", replacement)).content).toBe(expected);
  });

  it("maps normalized matches back to source bytes across unicode and CRLF boundaries", () => {
    const typography = plan("α\r\nsay — hi\r\nω", edit("say - hi\n", "changed\n"));
    expect(typography).toEqual({ content: "α\r\nchanged\r\nω", spans: [{ start: Buffer.byteLength("α\r\n"), end: Buffer.byteLength("α\r\nsay — hi\r\n") }], matchKinds: ["unicode-typography"] });
    const trailing = plan("é\r\nword  \r\n終", edit("word\n", "changed\n"));
    expect(trailing).toEqual({ content: "é\r\nchanged\r\n終", spans: [{ start: Buffer.byteLength("é\r\n"), end: Buffer.byteLength("é\r\nword  \r\n") }], matchKinds: ["trailing-whitespace"] });
  });

  it("decodes literal escape sequences a serialized call carried, in both fields", () => {
    const result = plan("a\n\tb\nc\n", edit("a\\n\\tb", "x\\n\\ty"));
    expect(result).toMatchObject({ matchKinds: ["escape-normalized"], content: "x\n\ty\nc\n", spans: [{ start: 0, end: 4 }] });
    // A file that really holds the literal sequence matches exactly and stays literal.
    expect(plan("sep = \"\\t\"\n", edit("\"\\t\"", "\"\\n\""))).toMatchObject({ matchKinds: ["exact"], content: "sep = \"\\n\"\n" });
  });

  it("writes the replacement in the quote style of the text it matched", () => {
    const curly = plan("say \u201chello\u201d to \u2018them\u2019 and don\u2019t\n", edit("say \"hello\" to 'them' and don't", "say \"bye\" to 'you' (or 'us') and won't"));
    expect(curly).toMatchObject({ matchKinds: ["unicode-typography"], content: "say \u201cbye\u201d to \u2018you\u2019 (or \u2018us\u2019) and won\u2019t\n" });
    // Only a quote kind that the match folded changes; the file's straight apostrophe stays straight.
    expect(plan("\u201ca\u201d it's\n", edit("\"a\" it's", "\"b\" it's")).content).toBe("\u201cb\u201d it's\n");
    // The reverse: the model wrote curly quotes that the file does not have.
    expect(plan("say \"hello\"\n", edit("say \u201chello\u201d", "say \u201cbye\u201d")).content).toBe("say \"bye\"\n");
  });

  it("matches characters that the file or the call wrote as \\uXXXX escapes, and keeps the file's form", () => {
    expect(plan("s = \"caf\\u00E9\"\n", edit("\"caf\u00e9\"", "\"na\u00efve caf\u00e9\""))).toMatchObject({ matchKinds: ["unicode-escape"], content: "s = \"na\\u00EFve caf\\u00E9\"\n" });
    expect(plan("s = \"caf\u00e9\"\n", edit("\"caf\\u00e9\"", "\"caf\\u00e9s\""))).toMatchObject({ matchKinds: ["unicode-escape"], content: "s = \"caf\u00e9s\"\n" });
    // An escaped backslash before `u` is no escape.
    expect(refusal("s = \"caf\\\\u00e9\"\n", edit("caf\u00e9", "cafe"))).toContain("no match after escape-normalized tier");
  });

  it("refuses literal differences within matching block boundaries", () => {
    const source = "function a() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}\n";
    expect(refusal(source, edit("function a() {\n  const x = 1;\n  const y = 22;\n  return x + y;\n}", "function a() {\n  return 3;\n}"))).toContain("no match after escape-normalized tier");
    const unalike = `function a() {\n  ${"Z".repeat(40)}\n  ${"Q".repeat(40)}\n  ${"W".repeat(40)}\n}`;
    expect(refusal(source, edit(unalike, "z"))).toContain("no match after escape-normalized tier");
    const twice = "if (a) {\n  one 1\n}\nif (a) {\n  one 2\n}\n";
    expect(refusal(twice, edit("if (a) {\n  one 3\n}", "gone"))).toBe("edits[0]: string edit refused: no match after escape-normalized tier; nearest lines: line 1: if (a) {; line 4: if (a) {");
    expect(refusal(twice, edit("if (a) {\n  three\n}", "gone"))).toContain("no match after escape-normalized tier");
  });

  it("refuses literal differences even when the indentation shift is uniform", () => {
    expect(refusal("  start\n  middle 1\n  end\n", edit("start\nmiddle 2\nend", "start\nchanged\nend"))).toContain("no match after escape-normalized tier");
  });

  it("rejects empty, binary, and oversized input", () => {
    const limits = { ...FILE_EDIT_LIMITS, maxOutputBytes: 2 };
    expect(refusal("a", edit("", "b"), limits)).toBe("edits[0]: old_string must not be empty");
    expect(refusal("a\0b", edit("a", "b"), limits)).toBe("binary content cannot be edited");
    expect(refusal("a", edit("a", "long"), limits)).toBe("edits[0]: operation exceeds string edit bytes limit");
    expect(refusal("abc", edit("abc", "de"), { ...FILE_EDIT_LIMITS, maxOutputBytes: 4 })).toBe("edits[0]: operation exceeds string edit bytes limit");
    expect(refusal("abcd", edit("abc", "de"), { ...FILE_EDIT_LIMITS, maxOutputBytes: 3 })).toBe("operation exceeds input bytes limit");
    expect(refusal("abc", edit("c", "de"), { ...FILE_EDIT_LIMITS, maxOutputBytes: 3 })).toBe("operation exceeds output bytes limit");
    expect(refusal("a  \n", edit("a\n", "a  \n"))).toBe("the replacement produced no change");
  });

  it("reports at most three deterministic nearest lines when nothing matches", () => {
    const diagnostic = refusal("header\nalpha one\nalpha two\nalpha three\nalpha four\nfooter\n", edit("alpha missing", "replacement"));
    expect(diagnostic).toStartWith("edits[0]: string edit refused: no match after escape-normalized tier; nearest lines: ");
    expect(diagnostic.match(/line /g)).toHaveLength(3);
    expect(diagnostic).toContain("line 2: alpha one");
    expect(diagnostic).toContain("line 3: alpha two");
    expect(diagnostic).toContain("line 4: alpha three");
    expect(diagnostic).not.toContain("alpha four");
    expect(refusal("nothing shared\n", edit("zzz", "y"))).toEndWith("nearest lines: none");
  });
});
