import { describe, it, expect } from "bun:test";
import {
  extractDisplayText,
  formatToolUse,
  getToolDetail,
  truncate,
} from "../src/tui/adapters/output-formatter";

describe("output-formatter", () => {
  // ── extractDisplayText ──

  describe("extractDisplayText", () => {
    it("returns raw text + newline for non-JSON input", () => {
      expect(extractDisplayText("hello world")).toBe("hello world\n");
    });

    it("extracts text from assistant message", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "text", text: "Hello from Claude" }],
        },
      });
      expect(extractDisplayText(line)).toBe("Hello from Claude");
    });

    it("extracts multiple text blocks from assistant message", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "First " },
            { type: "text", text: "Second" },
          ],
        },
      });
      expect(extractDisplayText(line)).toBe("First Second");
    });

    it("formats tool_use blocks in assistant messages", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "foo.ts" } },
          ],
        },
      });
      const result = extractDisplayText(line);
      expect(result).toContain("▸ Read");
      expect(result).toContain("foo.ts");
    });

    it("handles mixed text and tool_use blocks", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Let me read the file.\n" },
            { type: "tool_use", name: "Read", input: { file_path: "bar.ts" } },
          ],
        },
      });
      const result = extractDisplayText(line);
      expect(result).toContain("Let me read the file.");
      expect(result).toContain("▸ Read");
    });

    it("extracts result text", () => {
      const line = JSON.stringify({
        type: "result",
        result: "Task completed successfully",
      });
      expect(extractDisplayText(line)).toBe("Task completed successfully\n");
    });

    it("returns null for empty result", () => {
      const line = JSON.stringify({ type: "result", result: "" });
      expect(extractDisplayText(line)).toBeNull();
    });

    it("returns null for system messages", () => {
      const line = JSON.stringify({ type: "system", data: "init" });
      expect(extractDisplayText(line)).toBeNull();
    });

    it("returns null for tool_result messages", () => {
      const line = JSON.stringify({ type: "tool_result", content: "..." });
      expect(extractDisplayText(line)).toBeNull();
    });

    it("returns null for assistant message with empty content", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: { content: [] },
      });
      expect(extractDisplayText(line)).toBeNull();
    });

    it("returns null for assistant message with no text blocks", () => {
      const line = JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "unknown_block" }],
        },
      });
      expect(extractDisplayText(line)).toBeNull();
    });
  });

  // ── formatToolUse ──

  describe("formatToolUse", () => {
    it("returns empty string for block without name", () => {
      expect(formatToolUse({})).toBe("");
    });

    it("returns name only when no input", () => {
      expect(formatToolUse({ name: "Read" })).toBe("  ▸ Read\n");
    });

    it("returns name + detail for known tool", () => {
      const result = formatToolUse({
        name: "Bash",
        input: { command: "ls -la" },
      });
      expect(result).toBe("  ▸ Bash: ls -la\n");
    });
  });

  // ── getToolDetail ──

  describe("getToolDetail", () => {
    it("Read shows file_path", () => {
      expect(getToolDetail("Read", { file_path: "/src/index.ts" })).toBe(
        "/src/index.ts",
      );
    });

    it("Write shows file_path", () => {
      expect(getToolDetail("Write", { file_path: "out.txt" })).toBe("out.txt");
    });

    it("Edit shows file_path", () => {
      expect(getToolDetail("Edit", { file_path: "config.json" })).toBe(
        "config.json",
      );
    });

    it("Bash shows command", () => {
      expect(getToolDetail("Bash", { command: "npm test" })).toBe("npm test");
    });

    it("Glob shows pattern", () => {
      expect(getToolDetail("Glob", { pattern: "**/*.ts" })).toBe("**/*.ts");
    });

    it("Grep shows pattern", () => {
      expect(getToolDetail("Grep", { pattern: "TODO" })).toBe("TODO");
    });

    it("Task shows description over prompt", () => {
      expect(
        getToolDetail("Task", {
          description: "Find errors",
          prompt: "fallback",
        }),
      ).toBe("Find errors");
    });

    it("Task falls back to prompt if no description", () => {
      expect(getToolDetail("Task", { prompt: "fallback prompt" })).toBe(
        "fallback prompt",
      );
    });

    it("WebFetch shows url", () => {
      expect(
        getToolDetail("WebFetch", { url: "https://example.com" }),
      ).toBe("https://example.com");
    });

    it("TodoWrite returns null", () => {
      expect(getToolDetail("TodoWrite", { todos: [] })).toBeNull();
    });

    it("unknown tool shows first string value", () => {
      expect(
        getToolDetail("CustomTool", { query: "hello", count: 5 }),
      ).toBe("hello");
    });

    it("unknown tool with no string values returns null", () => {
      expect(getToolDetail("CustomTool", { count: 5 })).toBeNull();
    });
  });

  // ── truncate ──

  describe("truncate", () => {
    it("returns null for null/undefined", () => {
      expect(truncate(null, 80)).toBeNull();
      expect(truncate(undefined, 80)).toBeNull();
    });

    it("returns short string as-is", () => {
      expect(truncate("hello", 80)).toBe("hello");
    });

    it("truncates long string with ellipsis", () => {
      const long = "a".repeat(100);
      const result = truncate(long, 80)!;
      expect(result.length).toBe(80);
      expect(result.endsWith("…")).toBe(true);
    });

    it("collapses newlines to spaces", () => {
      expect(truncate("line1\nline2\nline3", 80)).toBe("line1 line2 line3");
    });

    it("trims whitespace", () => {
      expect(truncate("  hello  ", 80)).toBe("hello");
    });
  });
});
