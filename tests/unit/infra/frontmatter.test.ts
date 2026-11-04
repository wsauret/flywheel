import { describe, it, expect } from "bun:test";
import { parseFrontmatter } from "../../../src/infra/frontmatter";

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
  it("parses valid frontmatter and body", () => {
    const content = [
      "---",
      "title: Hello",
      "tags: [a, b]",
      "---",
      "Body content here.",
    ].join("\n");

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe("Hello");
    expect(result!.frontmatter.tags).toEqual(["a", "b"]);
    expect(result!.body).toBe("Body content here.");
  });

  it("returns null for malformed YAML", () => {
    const content = [
      "---",
      "broken: [yaml: {{{",
      "---",
      "Body content.",
    ].join("\n");

    expect(parseFrontmatter(content)).toBeNull();
  });

  it("reads an unquoted colon in a value as other agent clients do", () => {
    const content = [
      "---",
      "name: pdf-processing",
      "description: Use this skill when: the user asks about PDFs",
      "---",
      "Body content.",
    ].join("\n");

    expect(parseFrontmatter(content)).toEqual({
      frontmatter: { name: "pdf-processing", description: "Use this skill when: the user asks about PDFs" },
      body: "Body content.",
    });
  });

  it("keeps inline comments out of the values it recovers", () => {
    const content = [
      "---",
      "description: Use when: the user asks about PDFs # trigger note",
      "user-invocable: false # reason: hidden",
      "---",
      "Body content.",
    ].join("\n");

    expect(parseFrontmatter(content)?.frontmatter).toEqual({
      description: "Use when: the user asks about PDFs",
      "user-invocable": false,
    });
  });

  it("returns empty body when frontmatter only (no trailing content)", () => {
    const content = ["---", "title: Only FM", "---"].join("\n");

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe("Only FM");
    expect(result!.body).toBe("");
  });

  it("handles frontmatter followed by a blank line then body", () => {
    const content = [
      "---",
      "title: Spaced",
      "---",
      "",
      "Body after blank line.",
    ].join("\n");

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe("Spaced");
    expect(result!.body).toBe("\nBody after blank line.");
  });

  it("returns null when YAML parses to null", () => {
    const content = ["---", "", "---", "Body"].join("\n");
    expect(parseFrontmatter(content)).toBeNull();
  });

  it("reads a date-like value as its text", () => {
    const content = [
      "---",
      "date_val: 2026-03-14",
      "---",
      "Body",
    ].join("\n");

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.date_val).toBe("2026-03-14");
  });

  it("reads frontmatter written for js-yaml 4: a flow line below its key, a merge key, and a sequence key", () => {
    const content = [
      "---",
      "tags: [one,",
      "two]",
      "base: &base { disable-model-invocation: true, dependencies: [research] }",
      "<<: *base",
      "? [joined, key]",
      ": value",
      "---",
      "Body",
    ].join("\n");

    expect(parseFrontmatter(content)?.frontmatter).toEqual({
      tags: ["one", "two"],
      base: { "disable-model-invocation": true, dependencies: ["research"] },
      "disable-model-invocation": true,
      dependencies: ["research"],
      "joined,key": "value",
    });
  });

  it("does not match --- that is not at the start of the string", () => {
    const content = "Some preamble\n---\ntitle: Nope\n---\nBody";
    expect(parseFrontmatter(content)).toBeNull();
  });

  it("handles Windows-style line endings (CRLF)", () => {
    const content = "---\r\ntitle: CRLF\r\n---\r\nBody";
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe("CRLF");
    expect(result!.body).toBe("Body");
  });
});
