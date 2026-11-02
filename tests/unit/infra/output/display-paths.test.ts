import { describe, expect, it } from "bun:test";
import { mutationDisplayPaths, provisionalDiffDisplayPaths } from "../../../../src/infra/output/display-paths.js";

describe("tool display paths", () => {
  it("projects mutation files and omissions without changing their other evidence", () => {
    expect(mutationDisplayPaths({
      version: 1,
      files: [{ path: "/workspace/src/file.ts", change: "modified", unifiedDiff: "patch" }],
      omissions: [{ path: "/workspace/private.txt", reason: "sensitive" }],
    }, "/workspace")).toEqual({
      version: 1,
      files: [{ path: "src/file.ts", change: "modified", unifiedDiff: "patch" }],
      omissions: [{ path: "private.txt", reason: "sensitive" }],
    });
  });

  it("projects proposal source and move paths while preserving stable ids", () => {
    expect(provisionalDiffDisplayPaths({
      files: [{
        id: "/workspace/src/old.ts",
        path: "/workspace/src/old.ts",
        movePath: "/workspace/src/new.ts",
        action: "update",
        hunks: [],
      }],
    }, "/workspace")).toEqual({
      files: [{
        id: "/workspace/src/old.ts",
        path: "src/old.ts",
        movePath: "src/new.ts",
        action: "update",
        hunks: [],
      }],
    });
  });

  it("keeps session JSON paths as relative filesystem paths", () => {
    const path = "/workspace/.flywheel/sessions/session-1/handoff.json";

    expect(provisionalDiffDisplayPaths({
      files: [{ id: path, path, action: "add", hunks: [] }],
    }, "/workspace").files[0]?.path).toBe(".flywheel/sessions/session-1/handoff.json");
    expect(mutationDisplayPaths({
      version: 1,
      files: [{ path, change: "added", unifiedDiff: "patch" }],
      omissions: [],
    }, "/workspace").files[0]?.path).toBe(".flywheel/sessions/session-1/handoff.json");
  });
});
