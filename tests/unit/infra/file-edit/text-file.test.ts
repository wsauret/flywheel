import { describe, expect, it } from "bun:test";

import { LineEndingRestorer, preferredLineEnding, scanSourceLines, SourceFile, utf8ByteOffsets } from "../../../../src/infra/file-edit/text-file.js";

describe("text file model", () => {
  it("scans every ending style and keeps an unterminated tail and a BOM as text", () => {
    expect(scanSourceLines("﻿one\r\ntwo\nthree\rlast")).toEqual([
      { text: "﻿one", ending: "\r\n" },
      { text: "two", ending: "\n" },
      { text: "three", ending: "\r" },
      { text: "last", ending: undefined },
    ]);
    expect(scanSourceLines("")).toEqual([]);
  });

  it("prefers the most frequent ending and breaks ties toward the ending seen first", () => {
    expect(preferredLineEnding(scanSourceLines("a\nb\r\nc\r\n"))).toBe("\r\n");
    expect(preferredLineEnding(scanSourceLines("a\rb\nc"))).toBe("\r");
    expect(preferredLineEnding(scanSourceLines("a\nb\r\n"))).toBe("\n");
    expect(preferredLineEnding(scanSourceLines("plain"))).toBe("\n");
  });

  it("reports line spans as cumulative UTF-8 byte offsets across mixed endings and the file end", () => {
    const file = SourceFile.parse("α\r\nb\nc\rlast");
    expect(file.byteSpan(0, 0)).toEqual({ start: 0, end: 0 });
    expect(file.byteSpan(1, 2)).toEqual({ start: 4, end: 8 });
    expect(file.byteSpan(4, 0)).toEqual({ start: 12, end: 12 });
    expect(() => file.byteSpan(4, 1)).toThrow("operation exceeds line span limit");
  });

  it("refuses overlapping or out-of-range replacements", () => {
    const file = SourceFile.parse("a\nb\nc\n");
    expect(() => file.applyReplacements([{ start: 0, oldLength: 2, lines: [] }, { start: 1, oldLength: 1, lines: [] }])).toThrow("replacement spans overlap");
    expect(() => file.applyReplacements([{ start: 2, oldLength: 2, lines: [] }])).toThrow("operation exceeds replacement span limit");
  });

  it("converts ascending UTF-16 offsets to UTF-8 byte offsets in one pass", () => {
    const text = "aé€😀z";
    expect(utf8ByteOffsets(text, [0, 1, 2, 3, 5, 6])).toEqual([0, 1, 3, 6, 10, 11]);
    expect(() => utf8ByteOffsets(text, [2, 1])).toThrow("ascending");
  });

  it("gives replacement boundaries the endings of the span they replace, in order", () => {
    const restorer = new LineEndingRestorer("x\r\nx\nx\r");
    expect(restorer.restore("a\nb", { start: 0, end: 1 })).toBe("a\r\nb");
    expect(restorer.restore("a\nb", { start: 3, end: 4 })).toBe("a\nb");
    expect(restorer.restore("a\nb", { start: 5, end: 6 })).toBe("a\rb");
  });

});
