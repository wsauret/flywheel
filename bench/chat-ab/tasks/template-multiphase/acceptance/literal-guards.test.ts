/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { render } from "../render.js";
import { tokenize } from "../tokenizer.js";
import { TemplateError } from "../types.js";

describe("literal templates", () => {
  test("renders plain text unchanged", () => {
    expect(render("Hello, world!")).toBe("Hello, world!");
  });

  test("renders an empty template", () => {
    expect(render("")).toBe("");
  });

  test("preserves whitespace and line breaks", () => {
    expect(render(" first\n  second ")).toBe(" first\n  second ");
  });

  test("tokenizes literal text with its source position", () => {
    expect(tokenize("abc")).toEqual([{ kind: "text", value: "abc", position: 0 }]);
  });
});

describe("template errors", () => {
  test("exports an error with its detail and source position", () => {
    const error = new TemplateError("Unexpected closing tag", 4);
    expect(error.name).toBe("TemplateError");
    expect(error.message).toContain("Unexpected closing tag");
    expect(error.message).toContain("position 4");
  });
});
