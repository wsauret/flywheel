import { describe, expect, test } from "bun:test";
import { createBenchmarkCatalog, optionalSnapshot, reviewPrompt } from "../../../src/orchestration/modules/development/benchmark/catalog.js";

const catalog = createBenchmarkCatalog(process.cwd());

describe("optionalSnapshot", () => {
  test("returns undefined when the manifest has no commit", () => {
    expect(optionalSnapshot({ title: "t" }, "fixture")).toBeUndefined();
  });

  test("returns the commit and paths when both are present", () => {
    expect(optionalSnapshot({ commit: "abc123", paths: ["src", "tests"] }, "fixture")).toEqual({
      commit: "abc123",
      paths: ["src", "tests"],
    });
  });

  test("rejects an empty commit", () => {
    expect(() => optionalSnapshot({ commit: "" }, "fixture")).toThrow("commit must be a non-empty string");
  });

  test("rejects a commit without paths", () => {
    expect(() => optionalSnapshot({ commit: "abc123" }, "fixture")).toThrow("requires a non-empty string paths array");
    expect(() => optionalSnapshot({ commit: "abc123", paths: [] }, "fixture")).toThrow("requires a non-empty string paths array");
  });
});

describe("reviewPrompt", () => {
  test("a diff artifact gets the code-review prompt", () => {
    const prompt = reviewPrompt("diff.patch", "hint");
    expect(prompt).toContain("Review the change in diff.patch");
    expect(prompt).toContain("hint");
  });

  test("a plan artifact gets the plan-review prompt", () => {
    const prompt = reviewPrompt("plan.md", "hint");
    expect(prompt).toContain("Review the implementation plan in plan.md");
    expect(prompt).toContain("Verify every claim");
  });
});

describe("checked-in review fixtures", () => {
  test("every fixture loads with a consistent artifact, snapshot, and manifest", async () => {
    const tasks = await catalog.reviewTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(7);
    const ids = tasks.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of tasks) {
      expect(["diff.patch", "plan.md"]).toContain(task.artifact);
      expect(task.manifest.defects.length).toBeGreaterThan(0);
      expect(task.prompt).toContain(task.artifact);
      // A plan fixture reviews a real codebase snapshot; it must be commit-pinned.
      if (task.artifact === "plan.md") expect(task.snapshot).toBeDefined();
      if (task.snapshot) {
        expect(task.snapshot.paths.length).toBeGreaterThan(0);
      } else {
        expect(await Bun.file(`${task.fixtureDir}/project`).exists()).toBe(false); // directory, not file
      }
      expect(await Bun.file(`${task.fixtureDir}/${task.artifact}`).exists()).toBe(true);
    }
  });
});
