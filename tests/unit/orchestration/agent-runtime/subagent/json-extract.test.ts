import { describe, expect, it } from "bun:test";

import { tryParseJsonFromText } from "../../../../../src/orchestration/modules/subagents/execution/json-extract.js";

describe("tryParseJsonFromText", () => {
  it("parses raw JSON directly", () => {
    expect(tryParseJsonFromText(`{"summary":"ok"}`)).toEqual({ summary: "ok" });
  });

  it("extracts JSON from an unlabeled fenced block", () => {
    const text = "```\n{\"summary\":\"unlabeled\"}\n```";
    expect(tryParseJsonFromText(text)).toEqual({ summary: "unlabeled" });
  });

  it("recovers JSON by scanning from first { to last }", () => {
    const text = "Sure! { \"summary\": \"scanned\" } -- hope that helps.";
    expect(tryParseJsonFromText(text)).toEqual({ summary: "scanned" });
  });

  it("throws when stray braces in prose surround the real JSON object", () => {
    // The extractor uses first-`{` to last-`}`,
    // so stray braces in prose poison the substring and the parse fails.
    // Callers should fall back to a deterministic summary instead.
    const text = "Comment with { and a } then real { \"summary\": \"big\" } trailing.";
    expect(() => tryParseJsonFromText(text)).toThrow();
  });

});
