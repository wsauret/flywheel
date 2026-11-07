import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Schema } from "effect";
import { load } from "js-yaml";
import { RESEARCH_SNAPSHOT } from "../src/orchestration/modules/development/benchmark/catalog.js";
import { EMPTY_TREE } from "../src/orchestration/modules/development/benchmark/task-schema.js";

// ARCH-DIRECTORIES-019: a runnable benchmark fixture depends only on content in
// the public repository. Every commit of this repository that the harness
// archives or builds from must therefore be an ancestor of HEAD, so a
// fresh public clone holds it.

/** One commit that a runnable fixture names, and the file that names it. */
export interface BenchPin {
  readonly source: string;
  readonly commit: string;
}

// Each fixture file keeps its other fields; these read only the commit it names, if any.
const isPinnedSandbox = Schema.is(Schema.Struct({ sandbox: Schema.Struct({ commit: Schema.String }) }));
const isPinnedRuntime = Schema.is(Schema.Struct({ headless: Schema.Struct({ runtime_source_commit: Schema.String }) }));

// Each pattern matches only its corpus depth, so a vendored project/ and a
// campaign source worktree retained under results/ are never read as fixtures.
async function files(root: string, pattern: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const found = await Array.fromAsync(new Bun.Glob(pattern).scan({ cwd: root }));
  return found.sort().map((path) => join(root, path));
}

/** Collect every commit of this repository that a runnable fixture under
 *  `repoRoot` names: task sandboxes (a `<commit>:<subtree>` selector names its
 *  commit), Terminal-Bench runtime builds, and the research corpus. The empty
 *  tree is an object of every repository, so a fixture that names it depends
 *  on nothing. Throws when a fixture file is not readable JSON or YAML. */
export async function collectBenchPins(repoRoot: string): Promise<BenchPin[]> {
  const bench = join(repoRoot, "bench");
  const pins: BenchPin[] = [{ source: "src/orchestration/modules/development/benchmark/catalog.ts RESEARCH_SNAPSHOT", commit: RESEARCH_SNAPSHOT.commit }];
  const add = (path: string, commit: string) => {
    pins.push({ source: relative(repoRoot, path).replaceAll("\\", "/"), commit: commit.split(":")[0]! });
  };
  const benchTasks = await files(join(bench, "tasks"), "*/*/task.json");
  const chatAbTasks = await files(join(bench, "chat-ab", "tasks"), "*/task.json");
  for (const path of [...benchTasks, ...chatAbTasks]) {
    const task: unknown = JSON.parse(await readFile(path, "utf8"));
    if (isPinnedSandbox(task)) add(path, task.sandbox.commit);
  }
  for (const path of await files(join(bench, "terminal_bench", "profiles"), "*.yaml")) {
    const profile = load(await readFile(path, "utf8"));
    if (isPinnedRuntime(profile)) add(path, profile.headless.runtime_source_commit);
  }
  return pins.filter(({ commit }) => commit !== EMPTY_TREE);
}

function git(repoRoot: string, args: readonly string[]) {
  return Bun.spawnSync(["git", "-C", repoRoot, ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..");
  const shallow = git(repoRoot, ["rev-parse", "--is-shallow-repository"]);
  if (shallow.exitCode !== 0) {
    process.stderr.write(`bench-pins: git rev-parse failed: ${shallow.stderr.toString().trim()}\n`);
    process.exit(1);
  }
  if (shallow.stdout.toString().trim() === "true") {
    process.stderr.write("bench-pins: this clone is shallow, so its history cannot prove that a benchmark fixture commit is public. Run `git fetch --unshallow` and run the check again.\n");
    process.exit(1);
  }
  const foreign = (await collectBenchPins(repoRoot)).filter(({ commit }) => git(repoRoot, ["merge-base", "--is-ancestor", commit, "HEAD"]).exitCode !== 0);
  for (const { source, commit } of foreign) process.stderr.write(`bench-pins: ${source} names commit ${commit}, which is not an ancestor of HEAD\n`);
  if (foreign.length > 0) {
    process.stderr.write("bench-pins: a runnable benchmark fixture depends only on the public repository: a commit in its history, files inside the task, or an empty tree (ARCH-DIRECTORIES-019).\n");
    process.exit(1);
  }
}
