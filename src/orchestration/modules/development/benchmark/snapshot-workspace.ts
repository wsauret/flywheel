import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainedDirectory } from "../../../../infra/descriptor-directory.js";
import type { OwnedCommandRunner } from "../../../../infra/owned-command.js";
import { runCheckedSandboxCommand, SANDBOX_HOME_DIR } from "./sandbox-command.js";
import type { CommitSnapshot } from "./task-schema.js";

/** Extract `snapshot` from the benchmarked project's Git history into `dir`.
 *
 *  This is the one owner of commit snapshots: implementation sandboxes, review
 *  sandboxes, and research workspaces all read the project through it, so a
 *  trial sees the pinned commit and never the live checkout. It throws when
 *  the commit or a path is unknown, and when the archive holds a symlink or
 *  any entry that is not a regular file or directory. */
export async function materializeCommitSnapshot(projectRoot: string, snapshot: CommitSnapshot, dir: string, run: OwnedCommandRunner): Promise<void> {
  const archivePath = join(dir, ".bench-snapshot.tar");
  try {
    await runCheckedSandboxCommand(run, ["git", "-C", projectRoot, "archive", "--format=tar", `--output=${archivePath}`, snapshot.commit, "--", ...snapshot.paths], { cwd: projectRoot, sandboxDir: dir });
    await runCheckedSandboxCommand(run, ["tar", "-xf", archivePath, "-C", dir], { cwd: dir, sandboxDir: dir });
  } finally {
    await rm(archivePath, { force: true });
  }
  const authority = ContainedDirectory.openExisting(dir, [], { noFollowBase: true });
  if (!authority) throw new Error(`Benchmark sandbox is unavailable: ${dir}`);
  try {
    rejectUnsafeArchiveEntries(authority);
  } finally {
    authority.close();
  }
}

function rejectUnsafeArchiveEntries(directory: ContainedDirectory, relativeDir = "."): void {
  const directories = new Set(directory.directoryEntryNames());
  const files = new Set(directory.regularFileEntries().map((entry) => entry.name));
  for (const name of directory.entryNames()) {
    if (!directories.has(name) && !files.has(name)) {
      throw new Error(`Commit archive contains a symlink or unsupported entry at ${relativeDir}/${name}`);
    }
  }
  for (const name of directories) {
    const child = directory.openExistingChild(name);
    if (!child) throw new Error(`Commit archive directory became unavailable at ${relativeDir}/${name}`);
    try {
      rejectUnsafeArchiveEntries(child, `${relativeDir}/${name}`);
    } finally {
      child.close();
    }
  }
}

/** Run `use` in a fresh temporary workspace that `prepare` fills, then remove
 *  the workspace, on success and failure alike.
 *
 *  The workspace is the trial's whole view of the project: the home directory
 *  that preparation commands needed is removed before `use` starts. Evidence a
 *  trial must keep belongs outside the workspace. */
export async function withTrialWorkspace<T>(prepare: (workspace: string) => Promise<void>, use: (workspace: string) => Promise<T>): Promise<T> {
  const workspace = await mkdtemp(join(tmpdir(), "flywheel-bench-trial-"));
  try {
    await prepare(workspace);
    await rm(join(workspace, SANDBOX_HOME_DIR), { recursive: true, force: true });
    return await use(workspace);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

/** Run `use` in a temporary workspace that holds only `snapshot`. */
export function withSnapshotWorkspace<T>(projectRoot: string, snapshot: CommitSnapshot, run: OwnedCommandRunner, use: (workspace: string) => Promise<T>): Promise<T> {
  return withTrialWorkspace((workspace) => materializeCommitSnapshot(projectRoot, snapshot, workspace, run), use);
}
