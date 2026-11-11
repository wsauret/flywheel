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

/** A unified diff that changes the one line of ledger.ts from `from` to `to`. */
function ledgerDiff(from: number, to: number): string[] {
  return ["diff --git a/ledger.ts b/ledger.ts", "--- a/ledger.ts", "+++ b/ledger.ts", "@@ -1 +1 @@", `-export const total = ${from};`, `+export const total = ${to};`];
}

/** A unified diff that creates `path` with one line. */
function creationDiff(path: string, line: string): string[] {
  return [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, "@@ -0,0 +1 @@", `+${line}`];
}

/** Run one review cell over a commit-source fixture whose pinned commit holds
 *  ledger.ts, and return what the reviewer's workspace showed: the changed,
 *  staged, and untracked paths, and the base commit's files. */
async function reviewWorkspace(fixtureFiles: (commit: string) => { [name: string]: string }) {
  root = await mkdtemp(join(tmpdir(), "bench-review-sandbox-"));
  const projectRoot = root;
  await mkdir(join(projectRoot, "src", "workflows", "agents", "personas"), { recursive: true });
  await Bun.write(join(projectRoot, "src", "workflows", "agents", "personas", "reviewer-code-quality.md"), REVIEWER_DEFINITION);
  await Bun.write(join(projectRoot, "ledger.ts"), "export const total = 1;\n");
  git(["init", "-q"], projectRoot);
  git(["add", "-A"], projectRoot);
  git(["-c", "user.email=bench@flywheel.invalid", "-c", "user.name=bench", "commit", "-qm", "base"], projectRoot);
  const commit = git(["rev-parse", "HEAD"], projectRoot).trim();

  const fixture = join(projectRoot, "bench", "ab-persona", "fixtures", "reviews", "change");
  await mkdir(fixture, { recursive: true });
  await Bun.write(join(fixture, "manifest.json"), JSON.stringify({ title: "Change", review_prompt_hint: "", defects: [] }));
  for (const [name, content] of Object.entries(fixtureFiles(commit))) await Bun.write(join(fixture, name), content);

  const seen: { changed: string; staged: string; files: string; base: string; ledger: string }[] = [];
  const runtime = {
    ...fakeRuntime((options) => {
      const workspace = options.projectRoot;
      if (!workspace) throw new Error("expected the review cell to name its workspace");
      seen.push({
        changed: git(["diff", "--name-only"], workspace),
        staged: git(["diff", "--cached", "--name-only"], workspace),
        files: git(["ls-files", "--others", "--exclude-standard"], workspace),
        base: git(["ls-tree", "--name-only", "HEAD"], workspace),
        ledger: git(["show", "HEAD:ledger.ts"], workspace),
      });
      return { terminal: { kind: "completed" } };
    }),
    runOwnedCommand: run,
  };
  const catalog = createBenchmarkCatalog(projectRoot);
  const plan = await planPersonaBenchmark({ operation: "run", persona: "reviewer-code-quality", variants: [parseVariant("model-a:medium")], repeats: 1 }, catalog);
  expect((await runPersonaBenchmark(plan, benchmarkDeps(runtime, projectRoot, []))).status).toBe("completed");
  return seen;
}

test("a commit-source review sandbox shows the whole reviewed diff, added files included, through git diff", async () => {
  const seen = await reviewWorkspace((commit) => ({
    "source.json": JSON.stringify({ commit }),
    "diff.patch": [...ledgerDiff(1, 2), ...creationDiff("rounding.ts", "export const round = Math.round;"), ""].join("\n"),
  }));
  expect(seen).toEqual([{ changed: "ledger.ts\nrounding.ts\n", staged: "", files: "", base: "ledger.ts\nsrc\n", ledger: "export const total = 1;\n" }]);
});

test("a restored review sandbox commits the base patch into its base, so git diff shows only the reviewed change", async () => {
  const seen = await reviewWorkspace((commit) => ({
    "source.json": JSON.stringify({ commit, variant: "restore" }),
    "base.patch": [...ledgerDiff(1, 3), ...creationDiff("restored.ts", "export const restored = true;"), ""].join("\n"),
    "diff.patch": [...ledgerDiff(3, 4), ...creationDiff("rounding.ts", "export const round = Math.round;"), ""].join("\n"),
  }));
  expect(seen).toEqual([{ changed: "ledger.ts\nrounding.ts\n", staged: "", files: "", base: "ledger.ts\nrestored.ts\nsrc\n", ledger: "export const total = 3;\n" }]);
});
