import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../../src/infra/owned-command.js";
import type { ContainerProbe } from "../../../../../src/infra/process-container.js";
import { createPrivateCopyPool, REUSE_IDLE_LIMIT_MS, type LaunchStamp, type PrivateCopyPool } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy-pool.js";
import { privateCopyRemovals, readPrivateProjectCopy, takePrivateProjectCopy } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

const createDirectory = temporaryDirectories();
const HOUR_MS = 60 * 60 * 1000;

function answered(stdout: string): OwnedCommandResult {
  return { exitCode: 0, stdout, stdoutBytes: new TextEncoder().encode(stdout), stderr: "", timedOut: false };
}

/** A macOS kernel over `table`, pid to parent and start stamp. */
function kernel(table: ReadonlyMap<number, { readonly ppid: number; readonly start: string }>): ContainerProbe {
  const pids = () => [...table.keys()];
  return {
    signal: () => undefined,
    groupExists: () => false,
    libproc: {
      query(pid) {
        const entry = table.get(pid);
        return entry ? { kind: "process", pgid: pid, ppid: entry.ppid, identity: `${pid} ${pid} ${entry.start}`, start: entry.start } : { kind: "absent" };
      },
      group: () => [],
      pids,
      children: pid => pids().filter(child => table.get(child)?.ppid === pid),
      executable: () => ({ kind: "unavailable" }),
      processArguments: () => undefined,
      environment: () => undefined,
      bootSession: () => undefined,
      footprintBytes: () => undefined,
      runnableThreads: () => undefined,
    },
  };
}

const SUPERVISOR = 7001;
/** The command's supervisor started at 100 under an older parent; nothing newer runs. */
const SETTLED = new Map([[1, { ppid: 0, start: "1" }], [50, { ppid: 1, start: "50" }], [SUPERVISOR, { ppid: 50, start: "100" }]]);
const noSurvivor = kernel(SETTLED);
const LAUNCH: LaunchStamp = { start: "100", pidNamespace: false };

/** A project with a session scratch folder inside it, in a repository whose
 *  top level is `top`, or outside Git when `repository` is false. Git is
 *  faked; `init` creates the directory it names, as Git does. */
function project(options: { readonly prefix?: string; readonly repository?: boolean } = {}) {
  const top = fs.realpathSync(createDirectory("bash-private-copy-reuse-"));
  const root = options.prefix ? path.join(top, options.prefix) : top;
  const gitDir = path.join(top, ".git");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "source\n");
  const scratchDir = path.join(root, ".flywheel", "sessions", "own", "scratch");
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.writeFileSync(path.join(scratchDir, "note.md"), "note\n");
  const initialized: string[] = [];
  let duringInit: ((privateGit: string) => Promise<void>) | undefined;
  const git: OwnedCommandRunner = async command => {
    if (command.includes("init")) {
      const privateGit = command[command.length - 1] ?? "";
      initialized.push(privateGit);
      await duringInit?.(privateGit);
      fs.mkdirSync(privateGit, { recursive: true });
      return answered("");
    }
    if (command.includes("--verify")) return answered(`${"1".repeat(40)}\n`);
    if (command.includes("--show-object-format") && !command.includes("--show-toplevel")) return answered("sha1\nfiles\n");
    if (command.includes("rev-parse")) return answered(`${top}\n${gitDir}\n${gitDir}\nsha1\nfiles\n`);
    if (command.includes("for-each-ref")) return answered(`${"1".repeat(40)} refs/heads/main\n`);
    if (command.includes("symbolic-ref")) return answered("refs/heads/main\n");
    if (command.includes("worktree")) return answered(`worktree ${top}\0\0`);
    if (command.includes("--get-regexp")) return answered("core.repositoryformatversion 0\n");
    if (command.includes("config")) return { ...answered(""), exitCode: 1 };
    return answered("");
  };
  const notGit: OwnedCommandRunner = async () => ({ ...answered(""), exitCode: 128 });
  const addRepository = () => {
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  };
  if (options.repository !== false) addRepository();
  let homes = 0;
  return {
    top, root, scratchDir, initialized, addRepository,
    mutations: path.join(scratchDir, "mutations"),
    watchInit(watch: (privateGit: string) => Promise<void>) {
      duringInit = watch;
    },
    take(pool: PrivateCopyPool | undefined, repository = fs.existsSync(gitDir)) {
      homes += 1;
      return takePrivateProjectCopy({ projectRoot: root, executionCwd: root, home: path.join(scratchDir, "mutations", `h${homes}`), scratchDir, runGit: repository ? git : notGit, guard: "none", ...(pool ? { pool } : {}) });
    },
  };
}

function identity(file: string): string {
  const stats = fs.lstatSync(file, { bigint: true });
  return `${stats.dev}:${stats.ino}`;
}

/** Names and bytes of every entry below `directory`, links as their text. */
function contents(directory: string): Map<string, string> {
  return new Map(fs.readdirSync(directory, { recursive: true }).map(String).toSorted().map(name => {
    const entry = path.join(directory, name);
    const stats = fs.lstatSync(entry);
    return [name, stats.isSymbolicLink() ? `link ${fs.readlinkSync(entry)}` : stats.isFile() ? fs.readFileSync(entry, "utf8") : "directory"];
  }));
}

describe("reusing a private copy", () => {
  it("refreshes a released copy in its own home with a new private Git directory and no record while it runs", async () => {
    const fixture = project();
    // A take pins the hash of a file changed within RACY_WINDOW_NS of its own
    // start, which the copy Worker reads from the real clock. A future
    // modification time keeps the file inside that window for both takes,
    // however long a loaded machine takes between them, so both record the same state.
    const future = new Date(Date.now() + HOUR_MS);
    fs.utimesSync(path.join(fixture.root, "src", "a.ts"), future, future);
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    expect(first.refresh).toBeUndefined();
    const treeFile = path.join(first.copyRoot, "src", "a.ts");
    const baseFile = path.join(first.baseRoot, "src", "a.ts");
    const before = { tree: identity(treeFile), base: identity(baseFile) };
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");
    const recordDuringRefresh: string[] = [];
    fixture.watchInit(async () => {
      recordDuringRefresh.push((await readPrivateProjectCopy(first.home)).kind);
    });

    const second = await fixture.take(pool);

    expect(second.home).toBe(first.home);
    expect(recordDuringRefresh).toEqual(["missing"]);
    expect(fixture.initialized).toEqual([path.join(first.home, "git"), path.join(first.home, "git")]);
    expect(second.refresh).toMatchObject({ recloned: 0, removed: 0 });
    expect(second.files).toEqual(first.files);
    expect({ tree: identity(treeFile), base: identity(baseFile) }).toEqual(before);
    expect(fs.readFileSync(path.join(second.copyRoot, ".git"), "utf8")).toBe(`gitdir: ${path.join(second.home, "git")}\n`);
    const reread = await readPrivateProjectCopy(second.home);
    if (reread.kind !== "recorded") throw new Error("refreshed copy has no record");
    expect(reread.copy.files).toEqual(first.files);
    pool.close();
    await privateCopyRemovals();
  });

  it("removes what the previous command left in the private Git directory, the home, and beside the copy root", async () => {
    const fixture = project({ prefix: "pkg" });
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    const treeRoot = path.dirname(first.copyRoot);
    const git = path.join(first.home, "git");
    fs.mkdirSync(path.join(git, "objects", "ab"), { recursive: true });
    fs.writeFileSync(path.join(git, "objects", "ab", "cdef"), "loose");
    fs.writeFileSync(path.join(git, "ORIG_HEAD"), "1".repeat(40));
    fs.writeFileSync(path.join(git, "index.lock"), "");
    fs.mkdirSync(path.join(first.home, "merge"));
    fs.writeFileSync(path.join(first.home, "stray.txt"), "stray");
    fs.mkdirSync(path.join(treeRoot, "stray-dir"));
    fs.writeFileSync(path.join(treeRoot, "stray-dir", "f"), "f");
    fs.writeFileSync(path.join(first.copyRoot, "created.txt"), "not landed");
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");

    const second = await fixture.take(pool);

    expect(second.home).toBe(first.home);
    for (const left of [path.join(git, "objects", "ab"), path.join(git, "ORIG_HEAD"), path.join(git, "index.lock"), path.join(first.home, "merge"), path.join(first.home, "stray.txt"), path.join(treeRoot, "stray-dir"), path.join(second.copyRoot, "created.txt")]) {
      expect(fs.existsSync(left)).toBe(false);
    }
    expect(fs.readdirSync(treeRoot).sort()).toEqual([".git", "pkg"]);
    expect(fs.readFileSync(path.join(treeRoot, ".git"), "utf8")).toBe(`gitdir: ${git}\n`);
    expect(second.refresh?.removed).toBe(1);
    pool.close();
    await privateCopyRemovals();
  });

  it.each([
    ["base", "a link"], ["session-before", "a link"], ["tree name", "a link"], ["home", "a link"], ["mutations", "a link"], ["tree", "a file"],
  ] as const)("retires the copy when its %s was replaced by %s, and never touches the link's referent", async (replaced, form) => {
    const fixture = project();
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    const outside = createDirectory("bash-private-copy-reuse-outside-");
    fs.writeFileSync(path.join(outside, "copy.json"), "not a record");
    const target = {
      base: first.baseRoot,
      "session-before": path.join(first.home, "session-before"),
      "tree name": path.join(first.home, "tree", path.basename(fixture.top)),
      tree: path.join(first.home, "tree"),
      home: first.home,
      mutations: fixture.mutations,
    }[replaced];
    fs.rmSync(target, { recursive: true });
    if (form === "a link") fs.symlinkSync(outside, target, "junction");
    else fs.writeFileSync(target, "a file\n");
    const referent = contents(outside);
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");

    const second = await fixture.take(pool);
    await privateCopyRemovals();

    expect(second.home).not.toBe(first.home);
    expect(second.refresh).toBeUndefined();
    expect(contents(outside)).toEqual(referent);
    expect(fs.lstatSync(fixture.mutations).isDirectory()).toBe(true);
    expect(fs.existsSync(first.home)).toBe(false);
    expect(fs.readFileSync(path.join(second.copyRoot, "src", "a.ts"), "utf8")).toBe("source\n");
    pool.close();
    await privateCopyRemovals();
  });

  it("refreshes a copy whose mutations directory sits in a linked parent, and leaves the person's link in place when the copy is removed", async () => {
    const fixture = project();
    // The parent of `mutations` is the session scratch directory, or the system temporary directory, which a person can make a link.
    const linked = path.join(fs.realpathSync(createDirectory("bash-private-copy-reuse-linked-")), "scratch");
    fs.renameSync(fixture.scratchDir, linked);
    fs.symlinkSync(linked, fixture.scratchDir, "junction");
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");

    const second = await fixture.take(pool);
    expect(second.home).toBe(first.home);
    expect(second.refresh).toBeDefined();
    expect(pool.release(second.reuse, LAUNCH)).toBe("pooled");
    pool.close();
    await privateCopyRemovals();

    expect(fs.lstatSync(fixture.scratchDir).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(linked, "note.md"), "utf8")).toBe("note\n");
    expect(fs.existsSync(first.home)).toBe(false);
  });

  it.each(["closes", "expires"] as const)("removes only the link when the pool %s an idle copy whose home was replaced by a link", async retirement => {
    const fixture = project();
    let offset = 0;
    const pool = createPrivateCopyPool({ now: () => Date.now() + offset, probe: noSurvivor });
    const first = await fixture.take(pool);
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");
    const outside = createDirectory("bash-private-copy-reuse-outside-");
    fs.writeFileSync(path.join(outside, "copy.json"), "not a record");
    fs.mkdirSync(path.join(outside, "tree"));
    fs.rmSync(first.home, { recursive: true });
    fs.symlinkSync(outside, first.home, "junction");

    if (retirement === "closes") pool.close();
    else {
      offset = REUSE_IDLE_LIMIT_MS + HOUR_MS;
      expect((await fixture.take(pool)).home).not.toBe(first.home);
    }
    await privateCopyRemovals();

    expect(contents(outside)).toEqual(new Map([["copy.json", "not a record"], ["tree", "directory"]]));
    expect(fs.existsSync(first.home)).toBe(false);
    pool.close();
    await privateCopyRemovals();
  });

  it.each(["exclude", "git", ".git pointer"] as const)("writes nothing through %s replaced by a link to a file outside the home", async replaced => {
    const fixture = project();
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    const secret = path.join(createDirectory("bash-private-copy-reuse-secret-"), "secret");
    fs.writeFileSync(secret, "secret\n");
    const target = { exclude: path.join(first.home, "exclude"), git: path.join(first.home, "git"), ".git pointer": path.join(first.copyRoot, ".git") }[replaced];
    fs.rmSync(target, { recursive: true });
    fs.symlinkSync(secret, target);
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");

    const second = await fixture.take(pool);

    expect(second.home).toBe(first.home);
    expect(fs.readFileSync(secret, "utf8")).toBe("secret\n");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(second.copyRoot, ".git"), "utf8")).toBe(`gitdir: ${path.join(second.home, "git")}\n`);
    pool.close();
    await privateCopyRemovals();
  });

  it("discards the idle copy when the project became a repository", async () => {
    const fixture = project({ repository: false });
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    expect(first.git).toEqual({ kind: "none" });
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");
    fixture.addRepository();

    const second = await fixture.take(pool);
    await privateCopyRemovals();

    expect(second.home).not.toBe(first.home);
    expect(second.git.kind).toBe("repository");
    expect(fs.existsSync(first.home)).toBe(false);
    pool.close();
    await privateCopyRemovals();
  });

  // Windows has no POSIX write permission, and root removes entries whatever the mode, so neither makes the refresh fail this way.
  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)("takes a new copy at the new home when the refresh fails", async () => {
    const fixture = project();
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    // A directory the command left without write permission cannot be emptied, so the mirror fails.
    const stuck = path.join(first.copyRoot, "stuck");
    fs.mkdirSync(stuck);
    fs.writeFileSync(path.join(stuck, "f"), "f");
    fs.chmodSync(stuck, 0o555);
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");
    try {
      const second = await fixture.take(pool);
      await privateCopyRemovals();

      expect(second.home).toBe(path.join(fixture.mutations, "h2"));
      expect(second.refresh).toBeUndefined();
      expect(fs.readFileSync(path.join(second.copyRoot, "src", "a.ts"), "utf8")).toBe("source\n");
      expect(fs.existsSync(path.join(first.home, "copy.json"))).toBe(false);
    } finally {
      fs.chmodSync(stuck, 0o755);
    }
    pool.close();
    await privateCopyRemovals();
  });

  it("refreshes a copy only within the idle limit of its last refresh, however long it was checked out", async () => {
    const fixture = project();
    let offset = 0;
    const pool = createPrivateCopyPool({ now: () => Date.now() + offset, probe: noSurvivor });
    const first = await fixture.take(pool);
    offset = REUSE_IDLE_LIMIT_MS - 0.1 * HOUR_MS;
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");
    offset = REUSE_IDLE_LIMIT_MS + 0.1 * HOUR_MS;
    const expired = await fixture.take(pool);
    await privateCopyRemovals();
    expect(expired.home).not.toBe(first.home);
    expect(fs.existsSync(first.home)).toBe(false);

    offset = 0;
    const third = await fixture.take(pool);
    offset = 20 * HOUR_MS;
    expect(pool.release(third.reuse, LAUNCH)).toBe("pooled");
    offset = 21 * HOUR_MS;
    expect((await fixture.take(pool)).home).toBe(third.home);
    pool.close();
    await privateCopyRemovals();
  });

  it("on Linux takes a copy back only from a launch that ran in its own process namespace", async () => {
    const fixture = project();
    const stat = (pid: number) => pid === SUPERVISOR ? { kind: "content" as const, text: `${pid} (bwrap) S 50 ${pid} ${pid} 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 100 0 0` } : { kind: "absent" as const };
    const linux = (): PrivateCopyPool => createPrivateCopyPool({ probe: { signal: () => undefined, groupExists: () => false, procfs: { readStat: stat, readEnviron: () => ({ kind: "absent" }), listPids: () => [SUPERVISOR], bootId: () => ({ kind: "content", text: "boot" }) } } });
    const copy = await fixture.take(undefined);
    const namespaced = linux().launchStamp(SUPERVISOR, true);

    expect(namespaced).toEqual({ start: expect.any(String), pidNamespace: true });
    expect(linux().release(copy.reuse, namespaced)).toBe("pooled");
    expect(linux().release(copy.reuse, linux().launchStamp(SUPERVISOR, false))).toBe("survivor");
    // A launch whose process the kernel cannot stamp proves no teardown.
    expect(linux().release(copy.reuse, linux().launchStamp(9999, true))).toBe("stamp");
  });

  it("takes a copy back only with a proven stamp, no survivor, a free slot, and an open pool", async () => {
    const fixture = project();
    const orphaned = createPrivateCopyPool({ probe: kernel(new Map([...SETTLED, [8000, { ppid: 1, start: "200" }]])) });
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(undefined);
    const second = await fixture.take(undefined);

    expect(pool.launchStamp(SUPERVISOR, false)).toEqual(LAUNCH);
    expect(pool.launchStamp(9999, false)).toBeUndefined();
    expect(orphaned.release(first.reuse, LAUNCH)).toBe("survivor");
    expect(orphaned.checkout(first.reuse.geometry)).toBeUndefined();
    expect(pool.release(first.reuse, undefined)).toBe("stamp");
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");
    expect(pool.release(second.reuse, LAUNCH)).toBe("slot");
    expect(fs.existsSync(first.home)).toBe(true);

    pool.close();
    await privateCopyRemovals();
    expect(fs.existsSync(first.home)).toBe(false);
    expect(fs.existsSync(second.home)).toBe(true);
    expect(pool.release(second.reuse, LAUNCH)).toBe("slot");
    expect(pool.checkout(second.reuse.geometry)).toBeUndefined();
  });
});
