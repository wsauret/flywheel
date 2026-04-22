import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { getToolDetail, extractToolDiff } from "../src/infra/output/output-formatter";
import * as path from "node:path";
import * as fs from "node:fs";

describe("output-formatter", () => {
  describe("getToolDetail", () => {
    it("Read shows relative file path", () => {
      const filePath = path.join(process.cwd(), "src/index.ts");
      expect(getToolDetail("Read", { file_path: filePath })).toBe("src/index.ts");
    });

    it("Read keeps relative paths as-is", () => {
      expect(getToolDetail("Read", { file_path: "src/index.ts" })).toBe("src/index.ts");
    });

    it("Write shows relative file path", () => {
      expect(getToolDetail("Write", { file_path: "out.txt" })).toBe("out.txt");
    });

    it("Edit shows relative file path", () => {
      expect(getToolDetail("Edit", { file_path: "config.json" })).toBe(
        "config.json",
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

  describe("extractToolDiff — hashline edits", () => {
    const tmpDir = path.join("/tmp", `flywheel-test-${process.pid}`);
    const testFile = path.join(tmpDir, "test.ts");

    beforeEach(() => {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(testFile, "line one\nline two\nline three\nline four\n");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("produces a diff for a replace edit", () => {
      const result = extractToolDiff("edit", {
        file_path: testFile,
        edits: [{ op: "replace", start: "2#XX", end: "2#XX", lines: ["line TWO"] }],
      });
      expect(result).toBeDefined();
      expect(result!.diff).toContain("-line two");
      expect(result!.diff).toContain("+line TWO");
      expect(result!.filetype).toBe("typescript");
    });

    it("produces a diff for a delete edit", () => {
      const result = extractToolDiff("edit", {
        file_path: testFile,
        edits: [{ op: "delete", start: "2#XX", end: "3#XX" }],
      });
      expect(result).toBeDefined();
      expect(result!.diff).toContain("-line two");
      expect(result!.diff).toContain("-line three");
    });

    it("produces a diff for an insert_before edit", () => {
      const result = extractToolDiff("edit", {
        file_path: testFile,
        edits: [{ op: "insert_before", target: "2#XX", lines: ["inserted"] }],
      });
      expect(result).toBeDefined();
      expect(result!.diff).toContain("+inserted");
    });

    it("produces a diff for an insert_after edit", () => {
      const result = extractToolDiff("edit", {
        file_path: testFile,
        edits: [{ op: "insert_after", target: "2#XX", lines: ["inserted"] }],
      });
      expect(result).toBeDefined();
      expect(result!.diff).toContain("+inserted");
    });

    it("handles multiple edits in a single batch", () => {
      const result = extractToolDiff("edit", {
        file_path: testFile,
        edits: [
          { op: "replace", start: "1#XX", end: "1#XX", lines: ["LINE ONE"] },
          { op: "delete", start: "4#XX", end: "4#XX" },
        ],
      });
      expect(result).toBeDefined();
      expect(result!.diff).toContain("-line one");
      expect(result!.diff).toContain("+LINE ONE");
      expect(result!.diff).toContain("-line four");
    });

    it("returns content for a create edit", () => {
      const result = extractToolDiff("edit", {
        file_path: path.join(tmpDir, "new.ts"),
        edits: [{ op: "create", lines: ["new content", "second line"] }],
      });
      expect(result).toBeDefined();
      expect(result!.content).toBe("new content\nsecond line");
      expect(result!.diff).toBeUndefined();
    });

    it("produces a diff for replace_all", () => {
      const result = extractToolDiff("edit", {
        file_path: testFile,
        edits: [{ op: "replace_all", lines: ["completely new"] }],
      });
      expect(result).toBeDefined();
      expect(result!.diff).toContain("-line one");
      expect(result!.diff).toContain("+completely new");
    });

    it("returns undefined when file does not exist for non-create ops", () => {
      const result = extractToolDiff("edit", {
        file_path: path.join(tmpDir, "nonexistent.ts"),
        edits: [{ op: "replace", start: "1#XX", end: "1#XX", lines: ["x"] }],
      });
      expect(result).toBeUndefined();
    });

    it("returns undefined when edits array is empty", () => {
      const result = extractToolDiff("edit", {
        file_path: testFile,
        edits: [],
      });
      expect(result).toBeUndefined();
    });

    it("still handles old_string/new_string format", () => {
      const result = extractToolDiff("edit", {
        file_path: testFile,
        old_string: "line two",
        new_string: "line TWO",
      });
      expect(result).toBeDefined();
      expect(result!.diff).toContain("-line two");
      expect(result!.diff).toContain("+line TWO");
    });
  });
});