import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import { createBenchmarkCatalog } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { planPersonaBenchmark, runPersonaBenchmark } from "../../../src/orchestration/modules/development/benchmark/persona-benchmark.js";
import { parseVariant } from "../../../src/orchestration/modules/development/benchmark/variant.js";
import { benchmarkDeps, fakeRuntime, REVIEWER_DEFINITION } from "../../unit/bench/_persona-benchmark-fixtures.js";

const run: OwnedCommandRunner = async (command, options = {}) => {
  if (options.stdin !== undefined) throw new Error("integration runner does not accept stdin");
  const subprocess = Bun.spawn([...command], { cwd: options.cwd, env: options.env, stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(subprocess.stdout).text(), new Response(subprocess.stderr).text(), subprocess.exited]);
  return { exitCode, timedOut: false, stdoutBytes: new TextEncoder().encode(stdout), stdout, stderr };
};

function git(args: readonly string[], cwd: string): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

test("a commit-source review sandbox shows the whole reviewed diff, added files included, through git diff", async () => {
  root = await mkdtemp(join(tmpdir(), "bench-review-sandbox-"));
  const projectRoot = root;
  await mkdir(join(projectRoot, "src", "workflows", "agents", "personas"), { recursive: true });
  await Bun.write(join(projectRoot, "src", "workflows", "agents", "personas", "reviewer-code-quality.md"), REVIEWER_DEFINITION);
  await Bun.write(join(projectRoot, "ledger.ts"), "export const total = 1;\n");
  git(["init", "-q"], projectRoot);
  git(["add", "-A"], projectRoot);
  git(["-c", "user.email=bench@flywheel.invalid", "-c", "user.name=bench", "commit", "-qm", "base"], projectRoot);
  const commit = git(["rev-parse", "HEAD"], projectRoot).trim();

  const fixture = join(projectRoot, "bench", "ab-persona", "fixtures", "reviews", "added-file");
  await mkdir(fixture, { recursive: true });
  await Bun.write(join(fixture, "source.json"), JSON.stringify({ commit }));
  await Bun.write(join(fixture, "manifest.json"), JSON.stringify({ title: "Added file", review_prompt_hint: "", defects: [] }));
  await Bun.write(join(fixture, "diff.patch"), [
    "diff --git a/ledger.ts b/ledger.ts",
    "--- a/ledger.ts",
    "+++ b/ledger.ts",
    "@@ -1 +1 @@",
    "-export const total = 1;",
    "+export const total = 2;",
    "diff --git a/rounding.ts b/rounding.ts",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/rounding.ts",
    "@@ -0,0 +1 @@",
    "+export const round = Math.round;",
    "",
  ].join("\n"));

  const seen: { changed: string; staged: string; files: string }[] = [];
  const runtime = {
    ...fakeRuntime((options) => {
      const workspace = options.projectRoot;
      if (!workspace) throw new Error("expected the review cell to name its workspace");
      seen.push({
        changed: git(["diff", "--name-only"], workspace),
        staged: git(["diff", "--cached", "--name-only"], workspace),
        files: git(["ls-files", "--others", "--exclude-standard"], workspace),
      });
      return { terminal: { kind: "completed" } };
    }),
    runOwnedCommand: run,
  };
  const catalog = createBenchmarkCatalog(projectRoot);
  const plan = await planPersonaBenchmark({ operation: "run", persona: "reviewer-code-quality", variants: [parseVariant("model-a:medium")], repeats: 1 }, catalog);
  expect((await runPersonaBenchmark(plan, benchmarkDeps(runtime, projectRoot, []))).status).toBe("completed");

  expect(seen).toEqual([{ changed: "ledger.ts\nrounding.ts\n", staged: "", files: "" }]);
});
