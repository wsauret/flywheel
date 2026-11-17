// Runs oxlint on the TypeScript files under src/ that changed against the merge base with a base
// ref (origin/main by default): committed, staged, unstaged, and untracked files that are not
// ignored. Deleted files are left out.
//
// It also sets `JEV_CHANGED_ONLY=1` and `JEV_CHANGED_BASE=<merge base>` for oxlint-plugin-jev,
// unless the caller already set them, so the plugin asks only about functions and calls on
// changed lines. File rules still read the whole file.
//
// Usage: bun run scripts/anti-slop-llm/lint-changed.ts [--base=<ref>] [oxlint args...]
//
// Every argument other than `--base=` is passed to oxlint unchanged, such as
// `--config oxlint.slop.config.ts`.

import { existsSync } from "node:fs";
import { extname, join } from "node:path";

const LINTABLE_EXTENSIONS = new Set([".ts", ".tsx"]);
const ROOT = "src";
// This checkout's oxlint, so the runner works from any working directory without a download.
const OXLINT = join(import.meta.dir, "..", "..", "node_modules", "oxlint", "bin", "oxlint");

let base = "origin/main";
const oxlintArgs: string[] = [];
for (const arg of Bun.argv.slice(2)) {
  if (arg.startsWith("--base=")) base = arg.slice("--base=".length);
  else oxlintArgs.push(arg);
}

function git(args: readonly string[]): string {
  const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", windowsHide: true });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

const paths = (output: string): string[] => output.split("\0").filter((path) => path.length > 0);

try {
  const mergeBase = git(["merge-base", "HEAD", base]).trim();
  const changed = new Set([
    ...paths(git(["diff", "--name-only", "-z", "--no-renames", "--diff-filter=d", mergeBase, "--", ROOT])),
    ...paths(git(["ls-files", "-z", "--others", "--exclude-standard", "--", ROOT])),
  ]);
  const files = [...changed].filter((path) => LINTABLE_EXTENSIONS.has(extname(path)) && existsSync(path)).sort();
  if (files.length === 0) {
    console.log(`lint-changed: no TypeScript file under ${ROOT}/ changed against ${base}.`);
    process.exit(0);
  }
  console.log(`lint-changed: linting ${files.length} file(s) changed against ${base} (merge base ${mergeBase.slice(0, 12)}).`);
  const oxlint = Bun.spawnSync([process.execPath, OXLINT, ...oxlintArgs, ...files], {
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      JEV_CHANGED_ONLY: process.env.JEV_CHANGED_ONLY ?? "1",
      JEV_CHANGED_BASE: process.env.JEV_CHANGED_BASE ?? mergeBase,
    },
    windowsHide: true,
  });
  process.exit(oxlint.exitCode);
} catch (error) {
  console.error(`lint-changed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
