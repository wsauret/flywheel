import { describe, expect, test } from "bun:test";
import { createBenchmarkCatalog, reviewPrompt } from "../../../src/orchestration/modules/development/benchmark/catalog.js";

const catalog = createBenchmarkCatalog(process.cwd());

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

  test("a diff applied to a commit source is read through git diff", () => {
    const prompt = reviewPrompt("diff.patch", "hint", "commit");
    expect(prompt).toContain("git diff");
    expect(prompt).not.toContain("diff.patch");
  });
});

describe("checked-in review fixtures", () => {
  test("every fixture loads with a consistent artifact and manifest", async () => {
    const tasks = await catalog.reviewTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    const ids = tasks.map((task) => task.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const task of tasks) {
      expect(["diff.patch", "plan.md"]).toContain(task.artifact);
      // A commit source applies the diff to the working tree instead of copying the artifact.
      if (task.source.kind === "project") expect(task.prompt).toContain(task.artifact);
    }
  });
});
