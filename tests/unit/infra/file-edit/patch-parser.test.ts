import { describe, expect, it } from "bun:test";

import { FILE_EDIT_LIMITS, FileEditPlanError } from "../../../../src/infra/file-edit/contract.js";
import { PatchOperationParser, preparePatch } from "../../../../src/infra/file-edit/patch-parser.js";

describe("patch parser", () => {
  it("exposes completed operations without treating EOF as an operation boundary", () => {
    const parser = new PatchOperationParser();
    expect(parser.append("*** Update File: a.txt", 2)).toEqual([]);
    expect(parser.append("@@", 3)).toEqual([]);
    expect(parser.append("-old", 4)).toEqual([]);
    expect(parser.append("+new", 5)).toEqual([]);
    expect(parser.append("*** End of File", 6)).toEqual([]);
    expect(parser.append("*** Add File: b.txt", 7)).toEqual([{
      kind: "update",
      path: "a.txt",
      chunks: [{ oldLines: ["old"], newLines: ["new"], contextLineIndices: [], isEndOfFile: true }],
    }]);
    expect(parser.append("+added", 8)).toEqual([]);
    expect(parser.finish(9).operations).toEqual([{ kind: "add", path: "b.txt", contents: "added\n" }]);
  });

  it("prepares update, add, delete, and move operations with sorted unique paths", () => {
    const prepared = preparePatch([
      "*** Begin Patch",
      "*** Update File: z.txt",
      "*** Move to: a.txt",
      "@@ fn main",
      " keep",
      "-old",
      "+new",
      "*** Add File: m.txt",
      "+one",
      "+two",
      "*** Delete File: b.txt",
      "*** End Patch",
    ].join("\n"));
    expect(prepared.paths).toEqual(["a.txt", "b.txt", "m.txt", "z.txt"]);
    expect(prepared.environmentId).toBeUndefined();
    expect(prepared.operations).toEqual([
      { kind: "update", path: "z.txt", movePath: "a.txt", chunks: [{ changeContext: "fn main", oldLines: ["keep", "old"], newLines: ["keep", "new"], contextLineIndices: [[0, 0]], isEndOfFile: false }] },
      { kind: "add", path: "m.txt", contents: "one\ntwo\n" },
      { kind: "delete", path: "b.txt" },
    ]);
  });

  it("accepts a heredoc wrapper, CRLF envelope lines, whitespace-padded markers, and an environment id", () => {
    const prepared = preparePatch("<<'EOF'\r\n  *** Begin Patch  \r\n*** Environment ID: env-1\r\n  *** Update File: unicode.txt\r\n@@\r\n-old é\r\n+new é\r\n*** End of File\r\n  *** End Patch\r\nEOF\r\n");
    expect(prepared.environmentId).toBe("env-1");
    const [operation] = prepared.operations;
    expect(operation?.kind === "update" ? operation.chunks : undefined).toEqual([{ oldLines: ["old é"], newLines: ["new é"], contextLineIndices: [], isEndOfFile: true }]);
  });

  it("stops at the first end marker and accepts an environment id after delete", () => {
    expect(preparePatch("*** Begin Patch\n*** Add File: a\n+x\n*** End Patch\n*** Delete File: b\n*** End Patch").operations).toEqual([
      { kind: "add", path: "a", contents: "x\n" },
    ]);
    expect(preparePatch("*** Begin Patch\n*** Delete File: a\n*** Environment ID: env-1\n*** End Patch")).toEqual({
      operations: [{ kind: "delete", path: "a" }],
      paths: ["a"],
      environmentId: "env-1",
    });
  });

  it("pairs each context line with its position on both sides of a deletion", () => {
    const prepared = preparePatch("*** Begin Patch\n*** Update File: a.txt\n@@\n one\n-two\n-three\n four\n*** End Patch");
    const [operation] = prepared.operations;
    expect(operation?.kind === "update" ? operation.chunks[0]?.contextLineIndices : undefined).toEqual([[0, 0], [3, 1]]);
  });

  it("fails closed at every byte and count bound", () => {
    const patch = `*** Begin Patch\n*** Add File: a.txt\n+${"x".repeat(4 * 1024 * 1024)}\n*** End Patch`;
    expect(() => preparePatch(patch)).toThrow(/patch bytes limit/);
    const tiny = { ...FILE_EDIT_LIMITS, maxPatchBytes: 8 };
    expect(() => preparePatch("*** Begin Patch\n*** End Patch", tiny)).toThrow("patch exceeds patch bytes limit");
    expect(preparePatch("*** Begin Patch\n*** End Patch").operations).toEqual([]);
    expect(() => preparePatch("*** Begin Patch\n*** Delete File: a.txt\n*** Delete File: b.txt\n*** End Patch", { ...FILE_EDIT_LIMITS, maxHunks: 1 })).toThrow("patch exceeds hunks limit");
    expect(() => preparePatch("*** Begin Patch\n*** Delete File: abcdef\n*** End Patch", { ...FILE_EDIT_LIMITS, maxPathBytes: 3 })).toThrow("operation exceeds path bytes limit");
    expect(() => preparePatch("*** Begin Patch\n*** Add File: a.txt\n+abcdef\n*** End Patch", { ...FILE_EDIT_LIMITS, maxOutputBytes: 3 })).toThrow("operation exceeds output bytes limit");
  });

  it("names the malformed line in plain words without a machine prefix", () => {
    const cases: readonly [string, string][] = [
      ["not a patch", "invalid patch: The first line of the patch must be '*** Begin Patch'"],
      ["*** Begin Patch\n*** Add File: a.txt\n+x", "invalid patch: The last line of the patch must be '*** End Patch'"],
      ["*** Begin Patch\n*** Frobnicate File: foo\n*** End Patch", "invalid hunk at line 2, '*** Frobnicate File: foo' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'"],
      ["*** Begin Patch\n*** Update File: foo.txt\n@@\nbare\n*** End Patch", "invalid hunk at line 4, Expected update hunk to start with a @@ context marker, got: 'bare'"],
      ["*** Begin Patch\n*** Add File: \n*** End Patch", "invalid hunk at line 2, '*** Add File:' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'"],
      ["*** Begin Patch\n*** Environment ID: a\n*** Environment ID: b\n*** End Patch", "invalid patch: apply_patch environment_id cannot be specified more than once"],
      ["*** Begin Patch\n*** Environment ID:   \n*** End Patch", "invalid patch: apply_patch environment_id cannot be empty"],
    ];
    for (const [patch, message] of cases) {
      let caught: unknown;
      try {
        preparePatch(patch);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FileEditPlanError);
      expect(caught instanceof Error ? caught.message : undefined).toBe(message);
    }
  });

  it("drops empty update sections and chunks while retaining executable changes and their paths", () => {
    const prepared = preparePatch("*** Begin Patch\n*** Update File: absent.txt\n*** Update File: a.txt\n@@\n@@ again\n-old\n+new\n@@\n*** End Patch");
    expect(prepared.paths).toEqual(["a.txt"]);
    expect(prepared.operations).toEqual([{
      kind: "update", path: "a.txt", chunks: [{ changeContext: "again", oldLines: ["old"], newLines: ["new"], contextLineIndices: [], isEndOfFile: false }],
    }]);
  });
});
