import { afterAll, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createEnvCaptureResolver, detectShell, isGitRepo, localDate, localDateZone, observeGitDirectory, type EnvScope } from "../../../src/infra/env-detection.js";
import type { OwnedCommandResult } from "../../../src/infra/owned-command.js";
import { fakeOwnedCommandRunner, ownedCommandResult } from "../../helpers/owned-command-fake.js";

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A directory that looks like a working tree without invoking Git. */
function repoDirectory(branch: string | null = "main"): string {
  const root = mkdtempSync(join(tmpdir(), "flywheel-env-repo-"));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  writeFileSync(join(root, ".git", "HEAD"), branch ? `ref: refs/heads/${branch}\n` : "0123456789abcdef\n");
  return root;
}

/** Switches the branch as Git does: the new HEAD is written beside the old one and renamed over it. */
function replaceHead(gitDirectory: string, branch: string): void {
  const lockFile = join(gitDirectory, "HEAD.lock");
  writeFileSync(lockFile, `ref: refs/heads/${branch}\n`);
  renameSync(lockFile, join(gitDirectory, "HEAD"));
}

function plainDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "flywheel-env-plain-"));
  roots.push(root);
  return root;
}

function gitAnswers(files: readonly string[]) {
  return (): Promise<OwnedCommandResult> => Promise.resolve(ownedCommandResult(`${files.join("\n")}\n`));
}

describe("environment detection", () => {
  test("detects shell and repository ancestry", () => {
    expect(detectShell()).toBe(process.env.SHELL ?? process.env.ComSpec ?? process.env.COMSPEC ?? "unknown");
    expect(isGitRepo(join(import.meta.dir, "../../.."))).toBe(true);
    const nested = join(repoDirectory(), "nested", "deep");
    mkdirSync(nested, { recursive: true });
    expect(isGitRepo(nested)).toBe(true);
    expect(isGitRepo(plainDirectory())).toBe(false);
  });

  test("describes the execution directory and its repository", async () => {
    const executionCwd = repoDirectory();
    const runner = fakeOwnedCommandRunner(gitAnswers(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]));
    const resolve = createEnvCaptureResolver(runner.run);

    const snapshot = await resolve({ projectRoot: executionCwd, executionCwd });

    expect(snapshot.envBlock).toContain(`Working directory: ${executionCwd}`);
    expect(snapshot.envBlock).toContain("Is directory a git repo: Yes");
    expect(snapshot.envBlock).toContain("Repo snapshot: 6 tracked files (first 20): a.ts, b.ts, c.ts, d.ts, e.ts, f.ts");
    expect(runner.calls.map((call) => call.options?.cwd)).toEqual([executionCwd]);
  });

  test("resolves one scope once, however many readers ask", async () => {
    const executionCwd = repoDirectory();
    const runner = fakeOwnedCommandRunner(gitAnswers(["a.ts"]));
    const resolve = createEnvCaptureResolver(runner.run);
    const scope: EnvScope = { projectRoot: executionCwd, executionCwd };

    const first = await resolve(scope);
    const second = await resolve(scope);

    expect(second).toEqual(first);
    expect(runner.calls).toHaveLength(1);
  });

  test("states the local date of each read, while the directory probe runs once", async () => {
    const executionCwd = repoDirectory();
    const runner = fakeOwnedCommandRunner(gitAnswers(["a.ts"]));
    const resolve = createEnvCaptureResolver(runner.run);
    const scope: EnvScope = { projectRoot: executionCwd, executionCwd };
    const today = new Date("2026-10-10T12:00:00Z");
    const tomorrow = new Date("2026-10-11T12:00:00Z");
    try {
      setSystemTime(today);
      const first = await resolve(scope);
      setSystemTime(tomorrow);
      const second = await resolve(scope);

      expect(localDate(today)).not.toBe(localDate(tomorrow));
      expect(first.envBlock).toContain(`Date: ${localDate(today)}`);
      expect(second.envBlock).toContain(`Date: ${localDate(tomorrow)}`);
      expect(runner.calls).toHaveLength(1);
    } finally {
      setSystemTime();
    }
  });

  test("readers that arrive while the probe is running join one operation", async () => {
    const executionCwd = repoDirectory();
    let release: (result: OwnedCommandResult) => void = () => {};
    const pending = new Promise<OwnedCommandResult>((settle) => { release = settle; });
    const runner = fakeOwnedCommandRunner(() => pending);
    const resolve = createEnvCaptureResolver(runner.run);
    const scope: EnvScope = { projectRoot: executionCwd, executionCwd };

    const both = Promise.all([resolve(scope), resolve(scope)]);
    release(ownedCommandResult("a.ts\n"));
    const [first, second] = await both;

    expect(second).toEqual(first);
    expect(runner.calls).toHaveLength(1);
  });

  test("keeps one execution directory's environment separate per project", async () => {
    const executionCwd = repoDirectory();
    const runner = fakeOwnedCommandRunner(gitAnswers(["a.ts"]));
    const resolve = createEnvCaptureResolver(runner.run);

    await resolve({ projectRoot: "/projects/work", executionCwd });
    await resolve({ projectRoot: "/projects/home", executionCwd });

    expect(runner.calls).toHaveLength(2);
  });

  test("reports no repository outside a working tree, without probing git", async () => {
    const executionCwd = plainDirectory();
    const runner = fakeOwnedCommandRunner(() => Promise.reject(new Error("a plain directory must not probe git")));
    const resolve = createEnvCaptureResolver(runner.run);

    const snapshot = await resolve({ projectRoot: executionCwd, executionCwd });

    expect(snapshot.envBlock).toContain("Is directory a git repo: No");
    expect(snapshot.envBlock).toContain("Repo snapshot: N/A");
    expect(runner.calls).toEqual([]);
  });

  test("says the file listing failed rather than reporting an empty repo", async () => {
    const executionCwd = repoDirectory();
    const runner = fakeOwnedCommandRunner(() => Promise.resolve(ownedCommandResult("", 128)));
    const resolve = createEnvCaptureResolver(runner.run);

    const snapshot = await resolve({ projectRoot: executionCwd, executionCwd });

    expect(snapshot.envBlock).toContain("Repo snapshot: git ls-files failed");
  });

  test("reports a greenfield repo by its file count", async () => {
    const empty = repoDirectory();
    const small = repoDirectory();
    const runner = fakeOwnedCommandRunner(() => Promise.resolve(ownedCommandResult("\n")));
    const emptySnapshot = await createEnvCaptureResolver(runner.run)({ projectRoot: empty, executionCwd: empty });

    const smallRunner = fakeOwnedCommandRunner(gitAnswers(["a.ts", "b.ts"]));
    const smallSnapshot = await createEnvCaptureResolver(smallRunner.run)({ projectRoot: small, executionCwd: small });

    expect(emptySnapshot.envBlock).toContain("Repo snapshot: Greenfield repo (0 tracked files)");
    expect(smallSnapshot.envBlock).toContain("Repo snapshot: Greenfield repo (2 tracked files): a.ts, b.ts");
  });

  test("publishes no branch on a detached head", () => {
    const executionCwd = repoDirectory(null);
    const branches: Array<string | undefined> = [];
    const dispose = observeGitDirectory(executionCwd, (view) => { branches.push(view.branch); });

    dispose();
    expect(branches).toEqual([undefined]);
  });

  test("publishes atomic Git HEAD replacements until disposed", async () => {
    const repository = repoDirectory();
    const gitDirectory = join(repository, ".git", "worktrees", "linked");
    mkdirSync(gitDirectory, { recursive: true });
    writeFileSync(join(gitDirectory, "HEAD"), "ref: refs/heads/main\n");
    writeFileSync(join(gitDirectory, "commondir"), "../..\n");
    const worktreeRoot = plainDirectory();
    writeFileSync(join(worktreeRoot, ".git"), `gitdir: ${gitDirectory}\n`);
    const executionCwd = join(worktreeRoot, "package");
    mkdirSync(executionCwd);
    const branches: Array<string | undefined> = [];
    const switched = Promise.withResolvers<void>();
    const dispose = observeGitDirectory(executionCwd, (view) => {
      expect(view.worktreeRoot).toBe(worktreeRoot);
      branches.push(view.branch);
      if (view.branch === "feature/reactive-branch") switched.resolve();
    });

    replaceHead(gitDirectory, "feature/reactive-branch");
    await switched.promise;
    expect(branches).toEqual(["main", "feature/reactive-branch"]);

    dispose();
    replaceHead(gitDirectory, "feature/after-dispose");
    for (let attempt = 0; attempt < 25; attempt++) await Bun.sleep(5);
    expect(branches).toEqual(["main", "feature/reactive-branch"]);
  });

  test("publishes a HEAD replacement that lands while the observer starts", async () => {
    const repository = repoDirectory();
    const gitDirectory = join(repository, ".git");
    const branches: Array<string | undefined> = [];
    const switched = Promise.withResolvers<void>();
    const dispose = observeGitDirectory(repository, (view) => {
      branches.push(view.branch);
      // The first publication comes before any watch is armed, so the switch
      // lands where no watch can see it happen.
      if (branches.length === 1) replaceHead(gitDirectory, "feature/switched-at-start");
      else switched.resolve();
    });
    try {
      await switched.promise;
      expect(branches).toEqual(["main", "feature/switched-at-start"]);
    } finally {
      dispose();
    }
  });

  test("retries a scope whose probe could not be run at all", async () => {
    const executionCwd = repoDirectory();
    let refuse = true;
    const runner = fakeOwnedCommandRunner(() => {
      if (refuse) return Promise.reject(new Error("launcher scope is closed"));
      return gitAnswers(["a.ts"])();
    });
    const resolve = createEnvCaptureResolver(runner.run);
    const scope: EnvScope = { projectRoot: executionCwd, executionCwd };

    await expect(resolve(scope)).rejects.toThrow("launcher scope is closed");
    refuse = false;
    await resolve(scope);
  });
});

/** The local dates at one instant under two zones 25 hours apart, which always name different days, and the zone that
 *  Flywheel gives the engine under each. */
function datesUnderZones() {
  const zone = process.env.TZ;
  const resolvedZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const instant = new Date("2026-10-10T12:00:00Z");
  const dates: string[] = [];
  const zones: (string | undefined)[] = [];
  try {
    for (const name of ["Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
      process.env.TZ = name;
      dates.push(localDate(instant));
      zones.push(localDateZone());
    }
  } finally {
    // Removing TZ selects the machine's zone, not the runner's UTC, so the runner's zone is set back by name.
    process.env.TZ = zone ?? resolvedZone;
  }
  return { dates, zones };
}

describe("the local date", () => {
  test.skipIf(process.platform === "win32")("is the date in the zone that TZ names, and the engine gets that zone", () => {
    expect(datesUnderZones()).toEqual({ dates: ["2026-10-11", "2026-10-10"], zones: ["Pacific/Kiritimati", "Pacific/Pago_Pago"] });
  });

  // The bundled engine on Windows dates in the Windows system zone and ignores TZ, so Flywheel does the same.
  test.if(process.platform === "win32")("on Windows is the date in the system zone whatever TZ names, and the engine gets no zone", () => {
    const { dates, zones } = datesUnderZones();
    expect(dates[1]).toBe(dates[0]);
    expect(zones).toEqual([undefined, undefined]);
  });
});
