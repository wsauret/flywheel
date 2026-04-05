import { describe, it, expect } from "bun:test";
import { parseFrontmatter } from "../src/orchestration/utils/frontmatter";
import type { ParsedDoc } from "../src/orchestration/utils/frontmatter";

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

  it("returns null when there is no frontmatter", () => {
    const content = "Just a plain markdown file.\nNo frontmatter here.";
    expect(parseFrontmatter(content)).toBeNull();
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

  it("returns empty body when frontmatter only (no trailing content)", () => {
    const content = ["---", "title: Only FM", "---"].join("\n");

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe("Only FM");
    expect(result!.body).toBe("");
  });

  it("handles frontmatter with no trailing newline after closing ---", () => {
    const content = "---\ntitle: NoTrail\n---\nBody";
    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe("NoTrail");
    expect(result!.body).toBe("Body");
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

  it("returns null when YAML parses to a non-object (scalar)", () => {
    const content = ["---", "just a string", "---", "Body"].join("\n");
    expect(parseFrontmatter(content)).toBeNull();
  });

  it("returns null when YAML parses to null", () => {
    const content = ["---", "", "---", "Body"].join("\n");
    expect(parseFrontmatter(content)).toBeNull();
  });

  it("handles complex YAML values", () => {
    const content = [
      "---",
      "title: Complex",
      "nested:",
      "  key: value",
      "  list:",
      "    - one",
      "    - two",
      "---",
      "Body content.",
    ].join("\n");

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe("Complex");
    expect((result!.frontmatter.nested as any).key).toBe("value");
    expect((result!.frontmatter.nested as any).list).toEqual(["one", "two"]);
  });

  it("accepts optional yaml schema option (JSON_SCHEMA)", async () => {
    // With JSON_SCHEMA, "yes" stays as string "yes" instead of boolean true
    const yaml = await import("js-yaml");
    const content = [
      "---",
      "status: yes",
      "plan: true.md",
      "---",
      "Body",
    ].join("\n");

    const result = parseFrontmatter(content, { schema: yaml.JSON_SCHEMA });
    expect(result).not.toBeNull();
    expect(result!.frontmatter.status).toBe("yes");
    expect(typeof result!.frontmatter.status).toBe("string");
    expect(result!.frontmatter.plan).toBe("true.md");
  });

  it("uses default schema when no options provided (coerces dates)", () => {
    const content = [
      "---",
      "date_val: 2026-03-14",
      "---",
      "Body",
    ].join("\n");

    const result = parseFrontmatter(content);
    expect(result).not.toBeNull();
    // Default schema coerces date-like strings to Date objects
    expect(result!.frontmatter.date_val).toBeInstanceOf(Date);
  });

  it("JSON_SCHEMA prevents date coercion", async () => {
    const yaml = await import("js-yaml");
    const content = [
      "---",
      "date_val: 2026-03-14",
      "---",
      "Body",
    ].join("\n");

    const result = parseFrontmatter(content, { schema: yaml.JSON_SCHEMA });
    expect(result).not.toBeNull();
    // JSON_SCHEMA keeps date-like strings as strings
    expect(result!.frontmatter.date_val).toBe("2026-03-14");
    expect(typeof result!.frontmatter.date_val).toBe("string");
  });

  it("uses index-based split (not regex) — handles large body efficiently", () => {
    // Build a content string with small frontmatter and large body
    const largebody = "x".repeat(100_000);
    const content = `---\ntitle: Perf\n---\n${largebody}`;

    const start = performance.now();
    const result = parseFrontmatter(content);
    const elapsed = performance.now() - start;

    expect(result).not.toBeNull();
    expect(result!.frontmatter.title).toBe("Perf");
    expect(result!.body).toBe(largebody);
    // Should complete very quickly — index-based approach is O(frontmatter size)
    expect(elapsed).toBeLessThan(50);
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
