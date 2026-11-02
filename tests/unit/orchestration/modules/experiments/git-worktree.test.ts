import { expect, test } from "bun:test"
import { resolve } from "node:path"
import type { OwnedCommandRunner } from "../../../../../src/infra/owned-command.js"
import { validateExperimentWorktree } from "../../../../../src/orchestration/modules/experiments/git-worktree.js"

const result = (stdout: string, exitCode = 0) => ({
  exitCode, stdout, stderr: "", stdoutBytes: new TextEncoder().encode(stdout), timedOut: false,
})
const ROOT = resolve("/repo")

test("admits only the clean canonical session Git root", async () => {
  const calls: string[][] = []
  const run: OwnedCommandRunner = async (argv) => {
    calls.push([...argv])
    return argv.includes("--show-toplevel") ? result(`${ROOT}\n`) : result("")
  }
  await expect(validateExperimentWorktree({ workDir: ".", executionCwd: ROOT, projectRoot: ROOT, run, canonicalize: async (path) => path })).resolves.toBe(ROOT)
  expect(calls).toEqual([
    ["git", "-C", ROOT, "rev-parse", "--show-toplevel"],
    ["git", "-C", ROOT, "status", "--porcelain", "--untracked-files=all"],
  ])
})

test("refuses subdirectories and dirty trees", async () => {
  const rootRun: OwnedCommandRunner = async (argv) => argv.includes("--show-toplevel") ? result(`${ROOT}\n`) : result("")
  await expect(validateExperimentWorktree({ workDir: ".", executionCwd: resolve(ROOT, "sub"), projectRoot: ROOT, run: rootRun, canonicalize: async (path) => path })).rejects.toThrow("project root")
  const dirtyRun: OwnedCommandRunner = async (argv) => argv.includes("--show-toplevel") ? result(`${ROOT}\n`) : result(" M src/a.ts\n")
  await expect(validateExperimentWorktree({ workDir: ROOT, executionCwd: ROOT, projectRoot: ROOT, run: dirtyRun, canonicalize: async (path) => path })).rejects.toThrow("clean")
})
