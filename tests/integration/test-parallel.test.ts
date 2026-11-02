/**
 * End-to-end wiring smoke for the parallel test runner. The unit suite covers
 * argument classification, requested-path planning, and TEST_SHARDS parsing
 * (`tests/unit/scripts/test-parallel.test.ts`); this runs the real
 * `bun run test` script once to prove that `main` applies them: the shard
 * override reaches shard planning, an option passes through to Bun, and the
 * focused file runs to a clean summary.
 */

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { temporaryDirectories } from "../helpers/directories.js";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const EXISTING_TEST = "tests/unit/scripts/check-filenames.test.ts";
const temporaryDirectory = temporaryDirectories();

interface RunResult {
  output: string;
  exitCode: number;
}

/** Each nested run gets a temporary directory this file owns and removes. The
 *  nested runner keeps its validation lane and shard directories in its temp
 *  directory, so an inherited one would keep them after this file ends. */
async function runTestScript(args: readonly string[], env: { [key: string]: string } = {}): Promise<RunResult> {
  const temporary = temporaryDirectory("flywheel-test-parallel-");
  const proc = Bun.spawn(["bun", "run", "test", ...args], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, TMPDIR: temporary, TEMP: temporary, TMP: temporary, ...env },
    windowsHide: true,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { output: stdout + stderr, exitCode };
}

describe("bun run test wiring", () => {
  it("runs a focused file with an option and a TEST_SHARDS override", async () => {
    const result = await runTestScript(["--timeout", "20000", EXISTING_TEST], { TEST_SHARDS: "2" });
    expect(result.output).toContain("Ran across 2 parallel shards");
    expect(result.output).toContain("0 fail");
    expect(result.exitCode).toBe(0);
  }, 60000);
});
