import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBenchmarkCatalog } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const catalog = createBenchmarkCatalog(process.cwd());
const directory = temporaryDirectories();

/** The prompt the catalog gives one synthetic fixture that records no `prompt.md`. */
async function fixturePrompt(artifact: "diff.patch" | "plan.md", source: "project" | "commit"): Promise<string> {
  const fixtures = createBenchmarkCatalog(directory("review-fixture-prompt-"));
  const fixtureDir = join(fixtures.reviewFixturesDir, "fixture");
  mkdirSync(join(fixtureDir, "project"), { recursive: true });
  writeFileSync(join(fixtureDir, "manifest.json"), JSON.stringify({ title: "Fixture", review_prompt_hint: "hint", defects: [] }));
  writeFileSync(join(fixtureDir, artifact), "diff --git a/a.ts b/a.ts\n");
  if (source === "commit") writeFileSync(join(fixtureDir, "source.json"), JSON.stringify({ commit: "a".repeat(40) }));
  const [task] = await fixtures.reviewTasks("reviewer-code-quality");
  if (!task) throw new Error("expected the synthetic review fixture");
  return task.prompt;
}

describe("review prompt", () => {
  test("a diff artifact gets the code-review prompt", async () => {
    const prompt = await fixturePrompt("diff.patch", "project");
    expect(prompt).toContain("Review the change in diff.patch");
    expect(prompt).toContain("hint");
  });

  test("a plan artifact gets the plan-review prompt", async () => {
    const prompt = await fixturePrompt("plan.md", "project");
    expect(prompt).toContain("Review the implementation plan in plan.md");
    expect(prompt).toContain("Verify every claim");
  });

  test("a diff applied to a commit source is read through git diff", async () => {
    const prompt = await fixturePrompt("diff.patch", "commit");
    expect(prompt).toContain("git diff");
    expect(prompt).not.toContain("diff.patch");
  });
});

describe("checked-in review fixtures", () => {
  test("every fixture loads with a consistent artifact and manifest", async () => {
    const shared = await catalog.reviewTasks("reviewer-code-quality");
    expect(shared.length).toBeGreaterThanOrEqual(5);
    const tasks = [...shared, ...await catalog.reviewTasks("reviewer-code-elegance"), ...await catalog.reviewTasks("reviewer-mechanism")];
    for (const task of tasks) {
      expect(["diff.patch", "plan.md"]).toContain(task.artifact);
      // A commit source applies the diff to the working tree instead of copying the artifact.
      if (task.source.kind === "project") expect(task.prompt).toContain(task.artifact);
    }
  });
});
