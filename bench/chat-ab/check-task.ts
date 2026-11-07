#!/usr/bin/env bun
// Validates one task directory without a model: provisions its sandbox the
// way a cell does, captures the (empty) diff, runs the acceptance tests, and
// optionally repeats the capture after overlaying files from a fix revision.
//
//   bun bench/chat-ab/check-task.ts <task-id> [--root <dir>] [--write-baseline]
//     [--overlay <tree-ish> --overlay-files <path,path,...>] [--apply-diff <patch>] [--keep]
//
// The unfixed run must match the task's stored acceptance baseline, test by
// test, or the check fails. `--write-baseline` instead computes the baseline
// from the unfixed run and writes it into task.json: its failing tests become
// the fail-to-pass set and its passing tests the guards.
// `--overlay` copies each listed path from `<tree-ish>` (for example
// `fc3aa6454:flywheel-tui`) in the repository into the sandbox, which checks
// that a fix revision's non-test changes pass the acceptance suite.
// `--apply-diff` applies a patch instead, such as the task's reference.patch
// or a recorded cell's diff.patch, and scores it against the current
// acceptance tests. The overlaid fix must resolve the task: every baseline
// test passes.
// Prints one JSON object: the sandbox shape, the rendered message, the
// per-test outcomes of the unfixed run, and the score of the fixed run.
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createCliLauncher } from "../../src/cli/runtime-launch.js";
import { ownedCommandRunner } from "../../src/infra/owned-command.js";
import { objectValue } from "../../src/orchestration/modules/development/benchmark/task-schema.js";
import { baselineDrift, baselineOf, classifyAcceptance, scoreAcceptance, type AcceptanceBaseline } from "./acceptance.js";
import { HARNESS_DIR, REPO_ROOT } from "./harness-paths.js";
import { captureSandbox, loadDraftTask, provisionSandbox } from "./tasks.js";


/** The task.json text with `acceptanceBaseline` as its last key, replacing a
 *  baseline this script wrote before. The author's formatting of every other
 *  key is kept, and the result must parse to the same object. */
function withBaseline(text: string, baseline: AcceptanceBaseline, context: string): string {
  const config = objectValue(JSON.parse(text), context);
  const field = `,\n  "acceptanceBaseline": `;
  const head = text.includes(field) ? text.slice(0, text.indexOf(field)) : text.trimEnd().replace(/\n\}$/, "");
  const rendered = `${head}${field}${JSON.stringify(baseline, null, 2).replaceAll("\n", "\n  ")}\n}\n`;
  if (!Bun.deepEquals(JSON.parse(rendered), { ...config, acceptanceBaseline: baseline })) throw new Error(`${context} has an unexpected layout; add acceptanceBaseline as its last key by hand`);
  return rendered;
}

async function main(argv: readonly string[]): Promise<void> {
  const [taskId, ...rest] = argv;
  if (!taskId) throw new Error("usage: check-task.ts <task-id> [--root <dir>] [--overlay <tree-ish> --overlay-files <a,b>] [--keep]");
  let root: string | undefined;
  let overlay: string | undefined;
  let overlayFiles: string[] = [];
  let keep = false;
  let applyDiff: string | undefined;
  let writeBaseline = false;
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    const value = () => {
      const next = rest[++index];
      if (next === undefined) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--root") root = resolve(value());
    else if (flag === "--overlay") overlay = value();
    else if (flag === "--overlay-files") overlayFiles = value().split(",").map((path) => path.trim()).filter(Boolean);
    else if (flag === "--keep") keep = true;
    else if (flag === "--apply-diff") applyDiff = resolve(value());
    else if (flag === "--write-baseline") writeBaseline = true;
    else throw new Error(`Unknown option: ${flag}`);
  }
  if ((overlay === undefined) !== (overlayFiles.length === 0)) throw new Error("--overlay and --overlay-files go together");
  const task = await loadDraftTask(join(HARNESS_DIR, "tasks"), taskId);
  if (!writeBaseline && !task.acceptanceBaseline) throw new Error(`${taskId}/task.json has no acceptanceBaseline; run with --write-baseline`);
  const launcher = await createCliLauncher();
  const run = ownedCommandRunner(launcher.scope);
  const started = performance.now();
  const sandbox = await provisionSandbox(REPO_ROOT, task, run, root);
  try {
    const provisionSeconds = Math.round((performance.now() - started) / 1000);
    const log = (await run(["git", "log", "--all", "--format=%an <%ae> %s"], { cwd: sandbox.dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 30_000 })).stdout.trim();
    const refs = (await run(["git", "for-each-ref", "--format=%(refname)"], { cwd: sandbox.dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 30_000 })).stdout.trim();
    const status = (await run(["git", "status", "--porcelain", "--ignored=no"], { cwd: sandbox.dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 30_000 })).stdout.trim();
    const topLevel = (await readdir(sandbox.dir)).sort();
    const base = await captureSandbox(task, sandbox, run);
    if (!base.acceptance) throw new Error("the unfixed acceptance run timed out or wrote no report");
    const baseline = !writeBaseline && task.acceptanceBaseline ? task.acceptanceBaseline : baselineOf(base.acceptance);
    const drift = baselineDrift(baseline, base.acceptance);
    if (writeBaseline) {
      const path = join(task.taskDir, "task.json");
      await writeFile(path, withBaseline(await readFile(path, "utf8"), baseline, `${task.id}/task.json`));
    }
    let fixed;
    if (overlay) {
      for (const path of overlayFiles) {
        const shown = await run(["git", "-C", REPO_ROOT, "show", `${overlay}/${path}`], { cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 30_000 });
        if (shown.exitCode !== 0) throw new Error(`git show ${overlay}/${path} failed`);
        await mkdir(dirname(join(sandbox.dir, path)), { recursive: true });
        await writeFile(join(sandbox.dir, path), shown.stdout);
      }
      fixed = await captureSandbox(task, sandbox, run);
    } else if (applyDiff) {
      const applied = await run(["git", "apply", "--whitespace=nowarn", applyDiff], { cwd: sandbox.dir, env: { PATH: process.env.PATH ?? "/usr/bin:/bin" }, timeoutMs: 60_000 });
      if (applied.exitCode !== 0) throw new Error(`git apply ${applyDiff} failed: ${applied.stderr}`);
      overlay = `diff:${applyDiff}`;
      fixed = await captureSandbox(task, sandbox, run);
    }
    const fixedAcceptance = fixed ? classifyAcceptance(baseline, fixed.acceptance) : undefined;
    const fixedScore = fixedAcceptance ? scoreAcceptance(fixedAcceptance) : undefined;
    console.log(JSON.stringify({
      task: task.id,
      sandbox: { dir: sandbox.dir, home: sandbox.home, provisionSeconds, topLevel, gitLog: log, gitRefs: refs, statusAfterSetup: status },
      message: task.message,
      base: { diffBytes: base.diff.length, filesTouched: base.filesTouched, tests: Object.fromEntries(base.acceptance), baselineWritten: writeBaseline, baselineDrift: drift },
      ...(fixed && fixedAcceptance && fixedScore ? { fixed: { overlay, files: overlayFiles, diffBytes: fixed.diff.length, filesTouched: fixed.filesTouched, linesAdded: fixed.linesAdded, linesRemoved: fixed.linesRemoved, acceptance: fixedAcceptance, score: fixedScore } } : {}),
    }, null, 2));
    if (drift.length > 0) throw new Error(`the unfixed run does not match the stored acceptance baseline:\n${drift.join("\n")}`);
    // A recorded cell's diff is rescored whatever it scores; an overlaid fix must resolve the task.
    if (fixedScore && !applyDiff && !fixedScore.resolved) throw new Error(`the overlaid fix does not resolve the task: ${fixedScore.fixed}/${fixedScore.fixable} fail-to-pass tests pass, ${fixedScore.brokenGuards.length} guards broken`);
  } finally {
    if (!keep) await sandbox.dispose();
    await launcher.dispose();
  }
}

main(process.argv.slice(2)).then(() => process.exit(0), (error: unknown) => {
  console.error(`check-task failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
