import { realpath } from "node:fs/promises"
import { isAbsolute, resolve } from "node:path"
import type { OwnedCommandRunner } from "../../../infra/owned-command.js"

interface ValidateExperimentWorktreeInput {
  readonly workDir: string
  readonly executionCwd: string
  readonly projectRoot: string
  readonly run: OwnedCommandRunner
  readonly canonicalize?: (path: string) => Promise<string>
}

/** Admits only a clean Git root that is also the session's dedicated execution tree. */
export async function validateExperimentWorktree(input: ValidateExperimentWorktreeInput): Promise<string> {
  const canonicalize = input.canonicalize ?? realpath
  const candidate = await canonicalize(isAbsolute(input.workDir) ? input.workDir : resolve(input.executionCwd, input.workDir))
  const executionCwd = await canonicalize(input.executionCwd)
  const projectRoot = await canonicalize(input.projectRoot)
  if (candidate !== executionCwd) throw new Error("Experiment work_dir must equal the session execution directory.")
  if (candidate !== projectRoot) throw new Error("Experiment work_dir must equal the project root.")

  const rootResult = await input.run(["git", "-C", candidate, "rev-parse", "--show-toplevel"])
  if (rootResult.exitCode !== 0) throw new Error("Experiment work_dir must be a Git worktree root.")
  const gitRoot = await canonicalize(rootResult.stdout.trim())
  if (gitRoot !== candidate) throw new Error("Experiment work_dir must equal the Git worktree root.")
  const status = await input.run(["git", "-C", candidate, "status", "--porcelain", "--untracked-files=all"])
  if (status.exitCode !== 0) throw new Error("Git status failed for the experiment worktree.")
  if (status.stdout.length > 0) throw new Error("The experiment worktree must be clean.")
  return candidate
}
