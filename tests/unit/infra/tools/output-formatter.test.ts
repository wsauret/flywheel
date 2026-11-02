import { describe, it, expect } from "bun:test";
import { getToolDisplay, resolveToolPresentation } from "../../../../src/infra/tools/tool-display-registry";
import * as path from "node:path";

describe("output-formatter", () => {
  const executionCwd = process.cwd();

  describe("getDetail via contract", () => {
    it("unknown tool shows first string value", () => {
      expect(
        getToolDisplay("CustomTool").getDetail?.({ query: "hello", count: 5 }, executionCwd),
      ).toBe("hello");
    });

    it("unknown tool with no string values returns null", () => {
      expect(getToolDisplay("CustomTool").getDetail?.({ count: 5 }, executionCwd)).toBeNull();
    });
  });

  describe("extractDiff via contract", () => {
    it("returns the filetype for string edit input", () => {
      const result = getToolDisplay("edit").extractDiff?.(
        { path: "src/example.ts", old_string: "before", new_string: "after" },
        executionCwd,
      );
      expect(result).toEqual({ filetype: "typescript" });
    });

    it("extracts an update header from apply_patch input", () => {
      const input = "*** Begin Patch\n*** Update File: src/example.ts\n@@\n-before\n+after\n*** End Patch";
      expect(resolveToolPresentation("apply_patch", { input }, executionCwd)).toEqual({
        name: "Edit",
        detail: "src/example.ts",
      });
      expect(getToolDisplay("apply_patch").extractDiff?.({ input }, executionCwd)).toEqual({
        filetype: "typescript",
      });
    });

    it("recognizes only apply_patch file operation headers", () => {
      const input = [
        "*** Begin Patch",
        "*** Add File: src/new.ts",
        "*** Delete File: src/old.ts",
        "*** Update File: src/current.ts",
        "*** End Patch",
      ].join("\n");
      expect(resolveToolPresentation("apply_patch", { input }, executionCwd)).toEqual({
        name: "Edit",
        detail: "",
      });
      expect(getToolDisplay("apply_patch").extractDiff?.({ input: "not an apply_patch patch" }, executionCwd)).toBeUndefined();
    });

    it("returns undefined when edit path and patch headers are missing", () => {
      expect(getToolDisplay("edit").extractDiff?.({ edits: [] }, executionCwd)).toBeUndefined();
    });

    it("detects filetypes for curated additions and framework aliases", () => {
      const cases = [
        { filePath: path.join(executionCwd, "Dockerfile"), expected: "dockerfile" },
        { filePath: path.join(executionCwd, "Containerfile"), expected: "dockerfile" },
        { filePath: path.join(executionCwd, "build.PS1"), expected: "powershell" },
        { filePath: path.join(executionCwd, "schema.proto"), expected: "protobuf" },
        { filePath: path.join(executionCwd, "flake.nix"), expected: "nix" },
        { filePath: path.join(executionCwd, "main.dart"), expected: "dart" },
        { filePath: path.join(executionCwd, "app.exs"), expected: "elixir" },
        { filePath: path.join(executionCwd, "app.erl"), expected: "erlang" },
        { filePath: path.join(executionCwd, "core.cljc"), expected: "clojure" },
        { filePath: path.join(executionCwd, "build.gradle"), expected: "groovy" },
        { filePath: path.join(executionCwd, "types.mli"), expected: "ocaml" },
        { filePath: path.join(executionCwd, "paper.tex"), expected: "latex" },
        { filePath: path.join(executionCwd, "Component.vue"), expected: "vue" },
        { filePath: path.join(executionCwd, "Component.svelte"), expected: "svelte" },
        { filePath: path.join(executionCwd, "Makefile"), expected: "makefile" },
      ];

      for (const { filePath, expected } of cases) {
        const result = getToolDisplay("write").extractDiff?.(
          { path: filePath, content: "sample" },
          executionCwd,
        );
        expect(result?.filetype).toBe(expected);
      }
    });
  });
});
