import { describe, it, expect } from "bun:test";
import { getToolDetail } from "../src/infra/output/output-formatter";
import * as path from "node:path";

describe("output-formatter", () => {
  describe("getToolDetail", () => {
    it("Read shows file_path with ./ prefix", () => {
      const filePath = path.join(process.cwd(), "src/index.ts");
      expect(getToolDetail("Read", { file_path: filePath })).toBe("./src/index.ts");
    });

    it("Read converts relative paths to ./ prefix", () => {
      expect(getToolDetail("Read", { file_path: "src/index.ts" })).toBe("./src/index.ts");
    });

    it("Write shows file_path with ./ prefix", () => {
      expect(getToolDetail("Write", { file_path: "out.txt" })).toBe("./out.txt");
    });

    it("Edit shows file_path with ./ prefix", () => {
      expect(getToolDetail("Edit", { file_path: "config.json" })).toBe(
        "./config.json",
      );
    });

    it("Bash shows command", () => {
      expect(getToolDetail("Bash", { command: "npm test" })).toBe("npm test");
    });

    it("Glob shows pattern", () => {
      expect(getToolDetail("Glob", { pattern: "**/*.ts" })).toBe('"**/*.ts"');
    });

    it("Grep shows pattern", () => {
      expect(getToolDetail("Grep", { pattern: "TODO" })).toBe('"TODO"');
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
});
