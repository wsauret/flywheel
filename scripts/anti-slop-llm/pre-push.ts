// The body of the opt-in pre-push hook, `.githooks/pre-push`, which `bun run hooks:install`
// turns on. It judges the commits being pushed with the changed-code rules (`bun run lint:slop`)
// and the diff rules (`bun run lint:slop:diff`) and prints what they find. It never blocks a
// push: it always exits 0, prints nothing when no decision credential is set, and ends its
// checks with a "skipped: timed out" line after one minute.
//
// Usage: bun run scripts/anti-slop-llm/pre-push.ts < <git pre-push input>

import { join } from "node:path";
import { chooseDecisionBackend } from "../oxlint-plugin-jev/src/backend.ts";
import { withOwnedCommands } from "./owned-commands.ts";

const PREFIX = "anti-slop pre-push:";
const TIMEOUT_MS = 60_000;
const NEW_BRANCH_BASE = "origin/main";
const NO_COMMIT = /^0+$/;
const REPO_ROOT = join(import.meta.dir, "..", "..");

interface Env {
  readonly [name: string]: string | undefined;
}

interface PushedRange {
  readonly ref: string;
  readonly head: string;
  /** The ref the pushed commits are judged against. */
  readonly base: string;
}

// Git writes one `<local ref> <local sha> <remote ref> <remote sha>` line per pushed ref. A
// deleted ref pushes nothing, and a new branch has no remote commit to start from.
function pushedRanges(input: string): PushedRange[] {
  return input.split("\n").flatMap((line) => {
    const [ref, head, , remote] = line.trim().split(/\s+/);
    if (ref === undefined || head === undefined || remote === undefined || NO_COMMIT.test(head)) return [];
    return [{ ref, head, base: NO_COMMIT.test(remote) ? NEW_BRANCH_BASE : remote }];
  });
}

const checks = (base: string): ReadonlyArray<readonly string[]> => [
  [process.execPath, join(import.meta.dir, "lint-changed.ts"), `--base=${base}`, "--config", join(REPO_ROOT, "oxlint.slop.config.ts")],
  [process.execPath, join(import.meta.dir, "diff-rules", "run.ts"), "--committed", "--base", base],
];

export interface PrePushOptions {
  readonly cwd: string;
  readonly env: Env;
  /** What git writes to the hook's standard input. */
  readonly input: string;
  /** How long all checks of all pushed refs may take together. */
  readonly timeoutMs: number;
}

/**
 * Judges each pushed ref that is checked out and returns the text to print. Oxlint reads the
 * working tree, so a pushed ref other than HEAD is skipped with a line that says so.
 */
export async function runPrePush({ cwd, env, input, timeoutMs }: PrePushOptions): Promise<string> {
  const decision = chooseDecisionBackend(env, { typesafeModel: "jev-latest", longContext: false });
  if (!decision.ok) return "";
  const ranges = pushedRanges(input);
  if (ranges.length === 0) return "";
  const deadline = Date.now() + timeoutMs;
  // The oxlint native binding must load from its own package, whatever the developer's shell sets.
  const childEnv = { ...env, NAPI_RS_NATIVE_LIBRARY_PATH: "" };
  return withOwnedCommands(async (run) => {
    const head = (await run(["git", "rev-parse", "HEAD"], { cwd, env: childEnv })).stdout.trim();
    let output = "";
    for (const range of ranges) {
      if (range.head !== head) {
        output += `${PREFIX} skipped ${range.ref}: it is not checked out\n`;
        continue;
      }
      const results = await Promise.all(
        checks(range.base).map((argv) => run(argv, { cwd, env: childEnv, timeoutMs: Math.max(1, deadline - Date.now()) })),
      );
      for (const result of results) output += result.stdout + result.stderr;
      if (results.some((result) => result.timedOut)) return `${output}${PREFIX} skipped: timed out\n`;
    }
    return output;
  });
}

if (import.meta.main) {
  try {
    const input = await Bun.stdin.text();
    process.stdout.write(await runPrePush({ cwd: process.cwd(), env: process.env, input, timeoutMs: TIMEOUT_MS }));
  } catch (error) {
    console.log(`${PREFIX} ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exitCode = 0;
}
