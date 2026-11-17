import { describe, expect, it } from "bun:test";
import { provisionalDiffDisplayPaths } from "../../../../src/infra/output/display-paths.js";

describe("tool display paths", () => {
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
  });
});
