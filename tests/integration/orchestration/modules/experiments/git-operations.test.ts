import { afterEach, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { OwnedCommandRunner } from "../../../../../src/infra/owned-command.js"
import { captureExperimentTree, keepExperimentChanges, revertExperimentChanges } from "../../../../../src/orchestration/modules/experiments/git-operations.js"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

const run: OwnedCommandRunner = async (command, options) => {
  const process = Bun.spawn([...command], {
    cwd: options?.cwd,
    env: options?.env,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return { exitCode, stdout, stderr, stdoutBytes: new TextEncoder().encode(stdout), timedOut: false }
}

async function repository(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "flywheel-git-operations-"))
  directories.push(directory)
  await run(["git", "init", directory])
  await run(["git", "-C", directory, "config", "user.email", "test@example.com"])
  await run(["git", "-C", directory, "config", "user.name", "Test"])
  await writeFile(join(directory, "tracked.txt"), "before")
  await writeFile(join(directory, ".experiment"), "control")
  await run(["git", "-C", directory, "add", "-A"])
  await run(["git", "-C", directory, "commit", "-m", "baseline"])
  return directory
}

test("keep commits all changes and revert preserves experiment controls", async () => {
  const directory = await repository()
  await writeFile(join(directory, "tracked.txt"), "kept")
  await writeFile(join(directory, "new.txt"), "new")
  const scratch = await mkdtemp(join(tmpdir(), "flywheel-keep-index-"))
  directories.push(scratch)
  const measuredTree = await captureExperimentTree({ cwd: directory, scratchDir: scratch, run })
  const commit = await keepExperimentChanges({
    cwd: directory,
    scratchDir: scratch,
    description: "keep",
    result: { run: 1, segment: 0, metric: 1, metrics: {}, status: "keep", description: "keep", confidence: null, durationMs: null },
    measuredTree,
    run,
  })
  expect(commit).toHaveLength(7)

  await writeFile(join(directory, "tracked.txt"), "discard")
  await writeFile(join(directory, "untracked.txt"), "discard")
  await writeFile(join(directory, ".experiment"), "preserved")
  await revertExperimentChanges({ cwd: directory, run })

  expect(await readFile(join(directory, "tracked.txt"), "utf8")).toBe("kept")
  expect(await readFile(join(directory, ".experiment"), "utf8")).toBe("preserved")
  expect(await Bun.file(join(directory, "untracked.txt")).exists()).toBe(false)
})

test("isolated tree capture includes tracked and untracked content without changing the real index", async () => {
  const directory = await repository()
  const scratch = await mkdtemp(join(tmpdir(), "flywheel-tree-index-"))
  directories.push(scratch)
  await writeFile(join(directory, "tracked.txt"), "candidate")
  await writeFile(join(directory, "untracked.txt"), "candidate")

  const tree = await captureExperimentTree({ cwd: directory, scratchDir: scratch, run })
  const headTree = (await run(["git", "-C", directory, "rev-parse", "HEAD^{tree}"])).stdout.trim()
  const cached = await run(["git", "-C", directory, "diff", "--cached", "--quiet", "--exit-code"])

  expect(tree).not.toBe(headTree)
  expect(cached.exitCode).toBe(0)
})

test("unchanged candidate tree equals HEAD", async () => {
  const directory = await repository()
  const scratch = await mkdtemp(join(tmpdir(), "flywheel-baseline-index-"))
  directories.push(scratch)

  expect(await captureExperimentTree({ cwd: directory, scratchDir: scratch, run }))
    .toBe((await run(["git", "-C", directory, "rev-parse", "HEAD^{tree}"])).stdout.trim())
})

test("keep rejects a commit hook that changes staged content", async () => {
  const directory = await repository()
  const scratch = await mkdtemp(join(tmpdir(), "flywheel-hook-index-"))
  directories.push(scratch)
  await writeFile(join(directory, "tracked.txt"), "measured")
  const measuredTree = await captureExperimentTree({ cwd: directory, scratchDir: scratch, run })
  const hooks = join(directory, ".git", "hooks")
  await mkdir(hooks, { recursive: true })
  const hook = join(hooks, "pre-commit")
  await writeFile(hook, "#!/bin/sh\nprintf hook > tracked.txt\ngit add tracked.txt\n")
  await chmod(hook, 0o755)

  await expect(keepExperimentChanges({
    cwd: directory,
    scratchDir: scratch,
    description: "hook mutation",
    result: { run: 1, segment: 0, metric: 1, metrics: {}, status: "keep", description: "hook mutation", confidence: null, durationMs: null },
    measuredTree,
    run,
  })).rejects.toThrow("Experiment tree mismatch at commit")
})

test("discard restores staged candidate content in both index and worktree", async () => {
  const directory = await repository()
  await writeFile(join(directory, "tracked.txt"), "staged candidate")
  await run(["git", "-C", directory, "add", "tracked.txt"])

  await revertExperimentChanges({ cwd: directory, run })

  expect(await readFile(join(directory, "tracked.txt"), "utf8")).toBe("before")
  expect((await run(["git", "-C", directory, "diff", "--cached", "--quiet", "--exit-code"])).exitCode).toBe(0)
})
