import { cp } from "node:fs/promises";
import { join } from "node:path";
import type { OwnedCommandRunner } from "../../../../infra/owned-command.js";
import { resolveReviewFixture, type BenchmarkCatalog, type ReviewTask } from "./catalog.js";
import { runCheckedSandboxCommand, SANDBOX_HOME_DIR } from "./sandbox-command.js";
import { materializeCommitSnapshot } from "./snapshot-workspace.js";

/** Fill a review sandbox with what the recorded reviewer saw. A project source
 *  copies the vendored tree and the artifact. A commit source is a Git
 *  repository whose one commit is the base tree and whose working tree holds
 *  the reviewed diff uncommitted, because recorded review prompts read the
 *  change through git diff. No manifest, provenance, or fix enters either. */
export async function materializeReviewSandbox(catalog: BenchmarkCatalog, task: ReviewTask, sandbox: string, run: OwnedCommandRunner): Promise<void> {
  const fixture = await resolveReviewFixture(catalog.reviewFixturesDir, task);
  if (fixture.kind === "project") {
    await cp(fixture.projectDir, sandbox, { recursive: true });
    await cp(fixture.artifactPath, join(sandbox, task.artifact));
    return;
  }
  const options = { cwd: sandbox, sandboxDir: sandbox };
  await materializeCommitSnapshot(catalog.projectRoot, { commit: fixture.commit, paths: [] }, sandbox, run);
  await runCheckedSandboxCommand(run, ["git", "init", "-q"], options);
  // The archive holds tracked files only, so every one is staged, including a
  // tracked file that a .gitignore pattern matches. The sandbox commands' home
  // is removed before the trial starts and never enters the base commit.
  await runCheckedSandboxCommand(run, ["git", "add", "-A", "-f", "--", ".", `:!${SANDBOX_HOME_DIR}`], options);
  await runCheckedSandboxCommand(run, ["git", "-c", "user.email=bench@flywheel.invalid", "-c", "user.name=bench", "commit", "-qm", "base"], options);
  // Intent-to-add puts the files the diff creates in the index with no content,
  // so `git diff` shows them as the recorded reviewer saw them.
  await runCheckedSandboxCommand(run, ["git", "apply", "--intent-to-add", "--whitespace=nowarn", fixture.artifactPath], options);
}
