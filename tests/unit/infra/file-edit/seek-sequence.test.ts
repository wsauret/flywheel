import { describe, expect, it } from "bun:test";

import { applyIndentDelta, indentDelta, seekSequence, uniformIndentDelta } from "../../../../src/infra/file-edit/seek-sequence.js";

describe("seek sequence", () => {
  // The first four cases are the Codex CLI's own seek_sequence tests
  // that THIRD-PARTY-NOTICES.md credits.
  it("finds an exact sequence", () => {
    expect(seekSequence(["foo", "bar", "baz"], ["bar", "baz"], 0, false)).toEqual({ index: 1, kind: "exact", indentDelta: { kind: "none" } });
  });

  it("ignores trailing whitespace at the rstrip tier", () => {
    expect(seekSequence(["foo   ", "bar\t\t"], ["foo", "bar"], 0, false)).toMatchObject({ index: 0, kind: "rstrip" });
  });

  it("ignores both margins at the trim tier", () => {
    expect(seekSequence(["    foo   ", "   bar\t"], ["foo", "bar"], 0, false)).toMatchObject({ index: 0, kind: "trim" });
  });

  it("returns no match when the pattern is longer than the input", () => {
    expect(seekSequence(["just one line"], ["too", "many", "lines"], 0, false)).toBeUndefined();
  });

  it("folds typographic punctuation and spaces at the unicode tier", () => {
    expect(seekSequence(["say “hi” — now"], ["say \"hi\" - now"], 0, false)).toMatchObject({ index: 0, kind: "unicode" });
  });

  it("keeps blank lines exact inside a unique partial sequence", () => {
    expect(seekSequence(
      ["heading with details", "", "tail with details"],
      ["heading", "", "tail"],
      0,
      false,
    )).toMatchObject({ index: 0, kind: "substring" });
    expect(seekSequence(["heading with details", "not blank", "tail with details"], ["heading", "", "tail"], 0, false)).toBeUndefined();
  });

  it("takes the first match at the first tier that hits instead of refusing a repeated block", () => {
    const lines = ["a", "b", "c", "X", "a", "b", "c"];
    expect(seekSequence(lines, ["a", "b", "c"], 0, false)).toMatchObject({ index: 0, kind: "exact" });
    expect(seekSequence(lines, ["a", "b", "c"], 1, false)).toMatchObject({ index: 4, kind: "exact" });
    // An exact match later in the file beats a looser match earlier.
    expect(seekSequence(["  a", "a"], ["a"], 0, false)).toMatchObject({ index: 1, kind: "exact" });
  });

  it("runs every tier at end of file", () => {
    const lines = ["first", "second", "  tail  "];
    expect(seekSequence(lines, ["tail"], 0, true)).toMatchObject({ index: 2, kind: "trim" });
    expect(seekSequence(lines, ["first"], 0, true)).toBeUndefined();
    expect(seekSequence(lines, [], 5, true)).toEqual({ index: 3, kind: "exact", indentDelta: { kind: "none" } });
  });

  it("does not let a trim match swallow a byte order mark", () => {
    expect(seekSequence(["﻿one", "two"], ["one"], 0, false)).toBeUndefined();
  });

  it("reports a uniform indentation shift and none for a mixed one", () => {
    expect(uniformIndentDelta(["    if ready:", "        run()"], ["if ready:", "    run()"])).toEqual({ kind: "add", prefix: "    " });
    expect(uniformIndentDelta(["  one", "", "  two"], ["\t  one", "", "\t  two"])).toEqual({ kind: "remove", prefix: "\t" });
    expect(uniformIndentDelta(["\tone", " two"], ["one", "two"])).toEqual({ kind: "none" });
    expect(indentDelta("\t", "    ")).toBeUndefined();
  });

  it("re-indents non-blank replacement lines by the observed shift", () => {
    expect(applyIndentDelta(["uno", "", "dos"], { kind: "add", prefix: "\t" })).toEqual(["\tuno", "", "\tdos"]);
    expect(applyIndentDelta(["\t  uno", "\t  dos"], { kind: "remove", prefix: "\t" })).toEqual(["  uno", "  dos"]);
    expect(applyIndentDelta(["uno"], { kind: "none" })).toEqual(["uno"]);
  });
});
