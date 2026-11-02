import { expect, test } from "bun:test"
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../../src/infra/owned-command.js"
import { keepExperimentChanges, revertExperimentChanges, type ExperimentKeepResult } from "../../../../../src/orchestration/modules/experiments/git-operations.js"

function result(exitCode = 0, stdout = ""): OwnedCommandResult {
  return { exitCode, stdout, stderr: "", stdoutBytes: new TextEncoder().encode(stdout), timedOut: false }
}

const kept: ExperimentKeepResult = {
  run: 1, segment: 0, metric: 8, metrics: {}, status: "keep", description: "Faster parser", confidence: null, durationMs: null,
}
const tree = "a".repeat(40)

test("keeps all changes with a Result trailer and returns the seven-character commit", async () => {
  const commands: string[][] = []
  const run: OwnedCommandRunner = async (command) => {
    commands.push([...command])
    if (command.includes("write-tree") || command.at(-1) === "HEAD^{tree}") return result(0, `${tree}\n`)
    if (command.includes("diff")) return result(1)
    if (command.includes("--short=7")) return result(0, "abcdef1\n")
    return result()
  }

  const commit = await keepExperimentChanges({
    cwd: "/worktree",
    scratchDir: "/scratch",
    description: "Faster parser",
    result: kept,
    measuredTree: tree,
    run,
  })

  expect(commit).toBe("abcdef1")
  expect(commands).toEqual([
    ["git", "-C", "/worktree", "read-tree", "HEAD"],
    ["git", "-C", "/worktree", "add", "-A"],
    ["git", "-C", "/worktree", "write-tree"],
    ["git", "-C", "/worktree", "add", "-A"],
    ["git", "-C", "/worktree", "write-tree"],
    ["git", "-C", "/worktree", "diff", "--cached", "--quiet", "--exit-code"],
    ["git", "-C", "/worktree", "commit", "-m", "Faster parser", "-m", `Result: ${JSON.stringify(kept)}`],
    ["git", "-C", "/worktree", "rev-parse", "HEAD^{tree}"],
    ["git", "-C", "/worktree", "rev-parse", "--short=7", "HEAD"],
  ])
})

test("keeps an unchanged tree as the current commit without committing", async () => {
  const commands: string[][] = []
  const commit = await keepExperimentChanges({
    cwd: "/worktree",
    scratchDir: "/scratch",
    description: "baseline",
    result: kept,
    measuredTree: tree,
    run: async (command) => {
      commands.push([...command])
      if (command.includes("write-tree")) return result(0, `${tree}\n`)
      return command.includes("rev-parse") ? result(0, "1234abc\n") : result()
    },
  })

  expect(commit).toBe("1234abc")
  expect(commands.map((command) => command[3])).toEqual(["read-tree", "add", "write-tree", "add", "write-tree", "diff", "rev-parse"])
})

test("rejects a failed cached diff", async () => {
  await expect(keepExperimentChanges({
    cwd: "/worktree",
    scratchDir: "/scratch",
    description: "broken",
    result: kept,
    measuredTree: tree,
    run: async (command) => command.includes("diff") ? result(2) : command.includes("write-tree") ? result(0, `${tree}\n`) : result(),
  })).rejects.toThrow("git diff --cached")
})

test("reverts tracked and untracked changes while preserving experiment control files", async () => {
  const commands: string[][] = []
  await revertExperimentChanges({
    cwd: "/worktree",
    run: async (command) => {
      commands.push([...command])
      return result()
    },
  })

  expect(commands).toEqual([
    ["git", "-C", "/worktree", "reset", "HEAD", "--", ".", ":(exclude).experiment", ":(exclude).experiment/**"],
    ["git", "-C", "/worktree", "checkout", "HEAD", "--", ".", ":(exclude).experiment", ":(exclude).experiment/**"],
    ["git", "-C", "/worktree", "clean", "-fd", "-e", ".experiment", "-e", ".experiment/**"],
  ])
})

test("stops revert after a failed checkout", async () => {
  let calls = 0
  await expect(revertExperimentChanges({
    cwd: "/worktree",
    run: async () => {
      calls++
      return result(1)
    },
  })).rejects.toThrow("git reset")
  expect(calls).toBe(1)
})
