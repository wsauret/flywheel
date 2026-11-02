import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ensureSessionDir, resolveSessionDir } from "../../../../src/infra/paths";
import type { OwnedCommandRunner } from "../../../../src/infra/owned-command";
import { PRIVATE_COPY_RECORD } from "../../../../src/orchestration/agent-runtime/tools/bash-private-copy-record";
import { mutationGitDirectoryName, prepareMutationGitEnvironment } from "../../../../src/orchestration/agent-runtime/tools/bash-git-wrapper";
import { MUTATION_GIT_REMOVALS_PER_SWEEP, SCRATCH_ENTRY_LIMIT_BYTES, SCRATCH_IDLE_DAYS, sweepIdleScratch } from "../../../../src/orchestration/session/session-artifacts";
import { temporaryDirectories } from "../../../helpers/directories";

const DAY_MS = 24 * 60 * 60 * 1000;
const temporaryDirectory = temporaryDirectories();

/** A sparse file: its size counts toward the limit without writing the bytes. */
function plantFile(file: string, bytes: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, "w");
  try {
    fs.ftruncateSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

function scratchOf(projectRoot: string, sessionId: string): string {
  ensureSessionDir(sessionId, projectRoot);
  return path.join(resolveSessionDir(sessionId, projectRoot), "scratch");
}

function recordingGit() {
  const commands: (readonly string[])[] = [];
  const runGit: OwnedCommandRunner = async (command) => {
    commands.push(command);
    return { exitCode: 0, stdoutBytes: new Uint8Array(), stdout: "", stderr: "", timedOut: false };
  };
  return { runGit, commands };
}

// A write is dated by its change time, which no tool can set back, so the
// files below are all written now and the sweep runs at a later `now`.
const idleNow = (): number => Date.now() + (SCRATCH_IDLE_DAYS + 1) * DAY_MS;
const LARGE = SCRATCH_ENTRY_LIMIT_BYTES + 1;

describe("the idle scratch sweep", () => {
  it("removes a large entry nobody wrote to for the idle window, and keeps notes and small entries", async () => {
    const projectRoot = temporaryDirectory("flywheel-scratch-retention-");
    const scratch = scratchOf(projectRoot, "session-idle");
    plantFile(path.join(scratch, "clone", "objects", "pack.bin"), LARGE);
    const note = plantFile(path.join(scratch, "notes", "abc", "big.md"), LARGE);
    const script = plantFile(path.join(scratch, "audit.ts"), 4_096);
    const { runGit } = recordingGit();

    const swept = await sweepIdleScratch({ projectRoot, now: idleNow(), signal: new AbortController().signal, runGit });

    expect(fs.existsSync(path.join(scratch, "clone"))).toBe(false);
    expect(fs.existsSync(note)).toBe(true);
    expect(fs.existsSync(script)).toBe(true);
    expect(swept.removedEntries).toBe(1);
    expect(swept.removedBytes).toBeGreaterThanOrEqual(LARGE);
  });

  it("keeps a large entry written within the idle window", async () => {
    const projectRoot = temporaryDirectory("flywheel-scratch-retention-");
    const scratch = scratchOf(projectRoot, "session-fresh");
    const pack = plantFile(path.join(scratch, "clone", "pack.bin"), LARGE);
    const { runGit } = recordingGit();

    const swept = await sweepIdleScratch({ projectRoot, now: Date.now() + (SCRATCH_IDLE_DAYS - 1) * DAY_MS, signal: new AbortController().signal, runGit });

    expect(fs.existsSync(pack)).toBe(true);
    expect(swept.removedEntries).toBe(0);
  });

  it.each(["mutations", "edits"])("judges each private copy under %s on its own, including the previous directory name", async (directory) => {
    const projectRoot = temporaryDirectory("flywheel-scratch-retention-");
    const scratch = scratchOf(projectRoot, "session-edits");
    plantFile(path.join(scratch, directory, "copy-large", "tree", "dist.bin"), LARGE);
    plantFile(path.join(scratch, directory, "copy-large", PRIVATE_COPY_RECORD), 64);
    const small = plantFile(path.join(scratch, directory, "copy-small", "tree", "a.ts"), 128);
    plantFile(path.join(scratch, directory, "copy-small", PRIVATE_COPY_RECORD), 64);
    const { runGit } = recordingGit();

    await sweepIdleScratch({ projectRoot, now: idleNow(), signal: new AbortController().signal, runGit });

    expect(fs.existsSync(path.join(scratch, directory, "copy-large"))).toBe(false);
    expect(fs.existsSync(small)).toBe(true);
  });

  it("removes a private copy without its record after an hour, whatever its size", async () => {
    const projectRoot = temporaryDirectory("flywheel-scratch-retention-");
    const scratch = scratchOf(projectRoot, "session-unfinished");
    plantFile(path.join(scratch, "edits", "unfinished", "tree", "a.ts"), 128);
    const recorded = plantFile(path.join(scratch, "edits", "recorded", PRIVATE_COPY_RECORD), 64);
    const { runGit } = recordingGit();
    const sweep = (after: number) => sweepIdleScratch({ projectRoot, now: Date.now() + after, signal: new AbortController().signal, runGit });

    // A copy still being taken has no record yet either; it keeps writing.
    expect((await sweep(10 * 60 * 1000)).removedEntries).toBe(0);
    expect((await sweep(2 * 60 * 60 * 1000)).removedEntries).toBe(1);

    expect(fs.existsSync(path.join(scratch, "edits", "unfinished"))).toBe(false);
    expect(fs.existsSync(recorded)).toBe(true);
  });

  it("removes each idle Git shim folder whatever its size, and keeps a fresh one and the current runtime's", async () => {
    const projectRoot = temporaryDirectory("flywheel-scratch-retention-");
    const scratch = scratchOf(projectRoot, "session-shims");
    const shims = path.join(scratch, "mutation-git");
    plantFile(path.join(shims, "0b6c6a0e-legacy-per-command", "git"), 128);
    const current = plantFile(path.join(shims, mutationGitDirectoryName(process.execPath, process.platform), "git"), 128);
    const { runGit } = recordingGit();

    expect((await sweepIdleScratch({ projectRoot, now: Date.now() + (SCRATCH_IDLE_DAYS - 1) * DAY_MS, signal: new AbortController().signal, runGit })).removedEntries).toBe(0);
    expect((await sweepIdleScratch({ projectRoot, now: idleNow(), signal: new AbortController().signal, runGit })).removedEntries).toBe(1);

    expect(fs.existsSync(path.join(shims, "0b6c6a0e-legacy-per-command"))).toBe(false);
    expect(fs.existsSync(current)).toBe(true);
  });

  it("keeps the idle Git shim folder of a runtime that still exists, and removes the one whose runtime is gone", async () => {
    const projectRoot = temporaryDirectory("flywheel-scratch-retention-");
    const scratchDir = scratchOf(projectRoot, "session-builds");
    const builds = temporaryDirectory("flywheel-scratch-builds-");
    const realGit = Bun.which("git");
    expect(realGit).not.toBeNull();
    const install = (execPath: string): string => {
      prepareMutationGitEnvironment({ env: { PATH: path.dirname(realGit ?? "") }, cwd: projectRoot, scratchDir, platform: "darwin", execPath });
      return path.join(scratchDir, "mutation-git", mutationGitDirectoryName(execPath, "darwin"));
    };
    const kept = install(plantFile(path.join(builds, "kept", "flywheel-bin"), 1));
    const collectedRuntime = plantFile(path.join(builds, "collected", "flywheel-bin"), 1);
    const collected = install(collectedRuntime);
    fs.rmSync(path.dirname(collectedRuntime), { recursive: true });
    const { runGit } = recordingGit();

    expect((await sweepIdleScratch({ projectRoot, now: idleNow(), signal: new AbortController().signal, runGit })).removedEntries).toBe(1);

    expect(fs.existsSync(kept)).toBe(true);
    expect(fs.existsSync(collected)).toBe(false);
  });

  it("removes at most a fixed number of Git shim folders in one pass and leaves the rest for later passes", async () => {
    const projectRoot = temporaryDirectory("flywheel-scratch-retention-");
    const shims = path.join(scratchOf(projectRoot, "session-backlog"), "mutation-git");
    for (let index = 0; index <= MUTATION_GIT_REMOVALS_PER_SWEEP; index += 1) plantFile(path.join(shims, `legacy-${index}`, "git"), 1);
    const { runGit } = recordingGit();
    const sweep = () => sweepIdleScratch({ projectRoot, now: idleNow(), signal: new AbortController().signal, runGit });

    expect((await sweep()).removedEntries).toBe(MUTATION_GIT_REMOVALS_PER_SWEEP);
    expect(fs.readdirSync(shims)).toHaveLength(1);
    expect((await sweep()).removedEntries).toBe(1);
  });

  it("measures a link as itself, never as what it points to", async () => {
    const projectRoot = temporaryDirectory("flywheel-scratch-retention-");
    const outside = plantFile(path.join(temporaryDirectory("flywheel-scratch-outside-"), "big.bin"), LARGE);
    const scratch = scratchOf(projectRoot, "session-link");
    fs.mkdirSync(path.join(scratch, "linked"), { recursive: true });
    fs.symlinkSync(outside, path.join(scratch, "linked", "big.bin"));
    const { runGit } = recordingGit();

    const swept = await sweepIdleScratch({ projectRoot, now: idleNow(), signal: new AbortController().signal, runGit });

    expect(swept.removedEntries).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("removes the registration of a linked worktree inside a removed entry", async () => {
    const projectRoot = temporaryDirectory("flywheel-scratch-retention-");
    const scratch = scratchOf(projectRoot, "session-worktree");
    const worktree = path.join(scratch, "bench", "sources", "candidate");
    plantFile(path.join(worktree, "dist.bin"), LARGE);
    const repository = temporaryDirectory("flywheel-scratch-repo-");
    // Git writes the pointer as an absolute path with forward slashes on every platform.
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${repository.replaceAll("\\", "/")}/.git/worktrees/candidate\n`);
    const { runGit, commands } = recordingGit();

    await sweepIdleScratch({ projectRoot, now: idleNow(), signal: new AbortController().signal, runGit });

    expect(commands).toEqual([["git", "--git-dir", path.join(repository, ".git"), "worktree", "remove", "--force", "--force", fs.realpathSync(projectRoot) + worktree.slice(projectRoot.length)]]);
    expect(fs.existsSync(path.join(scratch, "bench"))).toBe(false);
  });
});
