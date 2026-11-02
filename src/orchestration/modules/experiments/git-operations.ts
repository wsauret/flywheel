import { randomUUID } from "node:crypto"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../infra/owned-command.js"
import type { ExperimentRunRecordedFact } from "./facts.js"

/** The recorded run without its commit: the commit is what the keep produces. */
export type ExperimentKeepResult = Omit<ExperimentRunRecordedFact["payload"], "commit">

interface KeepExperimentChangesInput {
  readonly cwd: string
  readonly scratchDir: string
  readonly description: string
  readonly result: ExperimentKeepResult
  readonly measuredTree: string
  readonly run: OwnedCommandRunner
}

interface RevertExperimentChangesInput {
  readonly cwd: string
  readonly run: OwnedCommandRunner
}

interface CaptureExperimentTreeInput {
  readonly cwd: string
  readonly scratchDir: string
  readonly run: OwnedCommandRunner
}

/** Reports candidate drift detected before `git commit` can publish anything. */
export class ExperimentPreCommitCandidateMismatchError extends Error {
  override readonly name = "ExperimentPreCommitCandidateMismatchError"
}

/** Captures the candidate's tracked and untracked content without touching its real index. */
export async function captureExperimentTree(input: CaptureExperimentTreeInput): Promise<string> {
  const indexFile = join(input.scratchDir, `experiment-index-${randomUUID()}`)
  const options = { env: { ...process.env, GIT_INDEX_FILE: indexFile } }
  try {
    requireSuccess("git read-tree", await input.run(["git", "-C", input.cwd, "read-tree", "HEAD"], options))
    requireSuccess("git add -A", await input.run(["git", "-C", input.cwd, "add", "-A"], options))
    const written = await input.run(["git", "-C", input.cwd, "write-tree"], options)
    requireSuccess("git write-tree", written)
    return requireTree("git write-tree", written.stdout)
  } finally {
    await rm(indexFile, { force: true })
  }
}

/** Stages and commits one successful experiment attempt, then returns its canonical short commit. */
export async function keepExperimentChanges(input: KeepExperimentChangesInput): Promise<string> {
  const boundaryTree = await captureExperimentTree(input)
  requirePreCommitMatchingTree("keep staging boundary", input.measuredTree, boundaryTree)
  requireSuccess("git add -A", await input.run(["git", "-C", input.cwd, "add", "-A"]))
  const staged = await input.run(["git", "-C", input.cwd, "write-tree"])
  requireSuccess("git write-tree", staged)
  requirePreCommitMatchingTree("staged candidate", input.measuredTree, requireTree("git write-tree", staged.stdout))

  const diff = await input.run(["git", "-C", input.cwd, "diff", "--cached", "--quiet", "--exit-code"])
  if (diff.timedOut || (diff.exitCode !== 0 && diff.exitCode !== 1)) {
    throw commandFailure("git diff --cached", diff)
  }
  // The baseline run keeps an unchanged tree, so an empty index is a keep of
  // the current commit, not a failure.
  if (diff.exitCode === 1) {
    const trailer = `Result: ${JSON.stringify(input.result)}`
    requireSuccess("git commit", await input.run([
      "git", "-C", input.cwd, "commit", "-m", input.description, "-m", trailer,
    ]))
    const committed = await input.run(["git", "-C", input.cwd, "rev-parse", "HEAD^{tree}"])
    requireSuccess("git rev-parse HEAD tree", committed)
    requireMatchingTree("commit", input.measuredTree, requireTree("git rev-parse HEAD tree", committed.stdout))
  }
  return readExperimentHead(input.cwd, input.run)
}

/** Restores the worktree while retaining the experiment's own control files. */
export async function revertExperimentChanges(input: RevertExperimentChangesInput): Promise<void> {
  requireSuccess("git reset", await input.run([
    "git", "-C", input.cwd, "reset", "HEAD", "--", ".",
    ":(exclude).experiment", ":(exclude).experiment/**",
  ]))
  requireSuccess("git checkout", await input.run([
    "git", "-C", input.cwd, "checkout", "HEAD", "--", ".",
    ":(exclude).experiment", ":(exclude).experiment/**",
  ]))
  requireSuccess("git clean", await input.run([
    "git", "-C", input.cwd, "clean", "-fd",
    "-e", ".experiment",
    "-e", ".experiment/**",
  ]))
}

function requireTree(command: string, output: string): string {
  const tree = output.trim()
  if (!/^[0-9a-f]{40,64}$/i.test(tree)) throw new Error(`${command} did not return a Git tree object ID.`)
  return tree
}

function requireMatchingTree(boundary: string, measured: string, actual: string): void {
  if (actual !== measured) {
    throw new Error(`Experiment tree mismatch at ${boundary}: measured ${measured}, found ${actual}.`)
  }
}

function requirePreCommitMatchingTree(boundary: string, measured: string, actual: string): void {
  if (actual !== measured) {
    throw new ExperimentPreCommitCandidateMismatchError(
      `Experiment tree mismatch at ${boundary}: measured ${measured}, found ${actual}.`,
    )
  }
}

/** Reads the current commit through the same owned process boundary as settlement actions. */
export async function readExperimentHead(cwd: string, run: OwnedCommandRunner): Promise<string> {
  const revision = await run(["git", "-C", cwd, "rev-parse", "--short=7", "HEAD"])
  requireSuccess("git rev-parse", revision)
  const commit = revision.stdout.trim()
  if (!/^[0-9a-f]{7}$/i.test(commit)) throw new Error("git rev-parse did not return a seven-character commit.")
  return commit
}

function requireSuccess(command: string, result: OwnedCommandResult): void {
  if (result.exitCode !== 0 || result.timedOut) throw commandFailure(command, result)
}

function commandFailure(command: string, result: OwnedCommandResult): Error {
  const reason = result.timedOut ? "timed out" : `exited ${result.exitCode}`
  const detail = [result.stderr, result.stdout].find((output) => output.trim().length > 0)?.trim()
  return new Error(`${command} ${reason}${detail ? `: ${detail}` : ""}`)
}
