import { describe, expect, it } from "bun:test";

import { resolveSyntaxLanguage } from "@tui/adapters/syntax-language.js";

describe("resolveSyntaxLanguage", () => {
  it("normalizes common fence aliases for OpenTUI", () => {
    expect(resolveSyntaxLanguage("ts")).toEqual({
      kind: "opentui",
      openTui: "typescript",
      highlightJs: "typescript",
    });
    expect(resolveSyntaxLanguage("jsx")).toEqual({
      kind: "opentui",
      openTui: "javascriptreact",
      highlightJs: "javascript",
    });
  });

  it("routes TSX and broad language coverage through highlight.js", () => {
    expect(resolveSyntaxLanguage("tsx title=demo")).toEqual({
      kind: "highlight-js",
      highlightJs: "typescript",
    });
    expect(resolveSyntaxLanguage("python3")).toEqual({
      kind: "highlight-js",
      highlightJs: "python",
    });
    expect(resolveSyntaxLanguage("zsh")).toEqual({
      kind: "highlight-js",
      highlightJs: "bash",
    });
  });

  it("preserves unknown languages for the plain fallback", () => {
    expect(resolveSyntaxLanguage("obscurelang")).toEqual({
      kind: "highlight-js",
      highlightJs: "obscurelang",
    });
    expect(resolveSyntaxLanguage(undefined)).toBeNull();
  });
});
