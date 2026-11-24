import { afterAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { Log } from "../../../../../../../src/infra/diagnostics/log.js";
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../../../../src/infra/owned-command.js";
import type { ContainerProbe } from "../../../../../../../src/infra/process/container/process-container.js";
import { createPrivateCopyJobs } from "../../../../../../../src/orchestration/agent-runtime/tools/bash/private-copy/bash-private-copy-jobs.js";
import { createPrivateCopyPool, type LaunchStamp, type PrivateCopyPool } from "../../../../../../../src/orchestration/agent-runtime/tools/bash/private-copy/bash-private-copy-pool.js";
import { detectCopyChanges, readPrivateProjectCopy, takePrivateProjectCopy } from "../../../../../../../src/orchestration/agent-runtime/tools/bash/private-copy/bash-private-copy.js";
import { readPrivateCopyRecord } from "../../../../../../../src/orchestration/agent-runtime/tools/bash/private-copy/bash-private-copy-record.js";
import { observeCopyTopology } from "../../../../../../../src/orchestration/agent-runtime/tools/bash/private-copy/bash-private-copy-tree.js";
import { temporaryDirectories } from "../../../../../../helpers/directories.js";

const createDirectory = temporaryDirectories();
const jobs = createPrivateCopyJobs();
afterAll(() => jobs.close());
const HOUR_MS = 60 * 60 * 1000;
/** The pool refreshes an idle copy for one day after its last refresh. */
const REUSE_IDLE_LIMIT_MS = 24 * HOUR_MS;

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

const OBJECT = "1".repeat(40);

/** What the fake Git answers about the repository, real and private alike. */
interface FakeRepository {
  head: string;
  refs: string;
  stash: string;
  index: string;
  worktrees: string;
}

/** A project with a session scratch folder inside it, in a repository whose
 *  top level is `top`, or outside Git when `repository` is false. Git is
 *  faked over `repository`, which a case changes to move the real state;
 *  `init` creates the directory it names, as Git does. With `reftable`, the
 *  real refs are a reftable stack on disk, which a case changes directly. */
function project(options: { readonly prefix?: string; readonly repository?: boolean; readonly reftable?: boolean } = {}) {
  const refFormat = options.reftable ? "reftable" : "files";
  const top = fs.realpathSync(createDirectory("bash-private-copy-reuse-"));
  const root = options.prefix ? path.join(top, options.prefix) : top;
  const gitDir = path.join(top, ".git");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "a.ts"), "source\n");
  const scratchDir = path.join(root, ".flywheel", "sessions", "own", "scratch");
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.writeFileSync(path.join(scratchDir, "note.md"), "note\n");
  const initialized: string[] = [];
  let during: { readonly argument: string; readonly run: () => Promise<void> } | undefined;
  const repository: FakeRepository = { head: "refs/heads/main", refs: `${OBJECT} refs/heads/main\n`, stash: "", index: "", worktrees: `worktree ${top}\0\0` };
  const git: OwnedCommandRunner = async command => {
    if (during && command.includes(during.argument)) await during.run();
    if (command.includes("init")) {
      const privateGit = command[command.length - 1] ?? "";
      initialized.push(privateGit);
      fs.mkdirSync(path.join(privateGit, ...(options.reftable ? ["reftable"] : [])), { recursive: true });
      return answered("");
    }
    if (command.includes("--verify")) return answered(`${OBJECT}\n`);
    if (command.includes("--show-object-format") && !command.includes("--show-toplevel")) return answered(`sha1\n${refFormat}\n`);
    if (command.includes("rev-parse")) return answered(`${top}\n${gitDir}\n${gitDir}\nsha1\n${refFormat}\n`);
    if (command.includes("for-each-ref")) return answered(repository.refs);
    if (command.includes("symbolic-ref")) return answered(`${repository.head}\n`);
    if (command.includes("worktree")) return answered(repository.worktrees);
    if (command.includes("--get-regexp")) return answered(options.reftable ? "core.repositoryformatversion 1\nextensions.refstorage reftable\n" : "core.repositoryformatversion 0\n");
    if (command.includes("config")) return { ...answered(""), exitCode: 1 };
    if (command.includes("reflog")) return answered(repository.stash);
    if (command.includes("--stage")) return answered(repository.index);
    return answered("");
  };
  const notGit: OwnedCommandRunner = async () => ({ ...answered(""), exitCode: 128 });
  const addRepository = () => {
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    if (!options.reftable) return;
    fs.mkdirSync(path.join(gitDir, "reftable"));
    fs.writeFileSync(path.join(gitDir, "reftable", "t1.ref"), "one");
    fs.writeFileSync(path.join(gitDir, "reftable", "tables.list"), "t1.ref\n");
  };
  if (options.repository !== false) addRepository();
  let homes = 0;
  return {
    top, root, scratchDir, initialized, addRepository, repository,
    mutations: path.join(scratchDir, "mutations"),
    /** Runs `run` before each Git command that has `argument`. */
    during(argument: string, run: () => Promise<void>) {
      during = { argument, run };
    },
    take(pool: PrivateCopyPool | undefined, hasRepository = fs.existsSync(gitDir)) {
      homes += 1;
      return takePrivateProjectCopy({ projectRoot: root, executionCwd: root, home: path.join(scratchDir, "mutations", `h${homes}`), scratchDir, runGit: hasRepository ? git : notGit, guard: "none", jobs: pool?.jobs ?? jobs, ...(pool ? { pool } : {}) });
    },
  };
}

/** The file entries that the record in `home` holds; they stay on the Worker, so a take never answers them. */
function recordedFiles(home: string) {
  const read = readPrivateCopyRecord(home);
  if (read.kind !== "recorded") throw new Error(`no record in ${home}`);
  return read.copy.files;
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
  it.each([
    { change: "adds a nested repository", registers: true, run: (copyRoot: string) => fs.mkdirSync(path.join(copyRoot, "src", "inner", ".git"), { recursive: true }) },
    { change: "adds a symbolic link", registers: false, run: (copyRoot: string) => fs.symlinkSync("../outside", path.join(copyRoot, "src", "linked")) },
    { change: "removes a directory", registers: false, run: (copyRoot: string) => fs.rmSync(path.join(copyRoot, "src"), { recursive: true }) },
  ])("a landing scan of a command that $change answers the topology that a fresh observation of the copy finds", async ({ registers, run }) => {
    const fixture = project({ prefix: "app" });
    fs.mkdirSync(path.join(fixture.root, "vendored", ".git"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "empty"));
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const copy = await fixture.take(pool);
    if (copy.execution.kind !== "file-only-v4") throw new Error("Expected a finalized copy");
    const request = { treeRoot: copy.execution.treeRoot, privateGitDir: path.join(copy.home, "git") };
    run(copy.copyRoot);
    const { topology } = await detectCopyChanges(copy, pool.jobs, request);
    expect(topology).toEqual(observeCopyTopology({ ...request, copyRoot: copy.copyRoot, shared: copy.shared }));
    // The topology binds Git registrations only, so only a new one moves it off the take's baseline.
    expect(topology === undefined || !isDeepStrictEqual(topology, copy.execution.baseline.topology)).toBe(registers);
    await pool.close();
  });

  it.each(["", "app"])("records a topology baseline equal to a fresh observation of the copy, fresh and reused (prefix %j)", async (prefix) => {
    const fixture = project({ prefix });
    fs.symlinkSync("src", path.join(fixture.root, "linked"));
    fs.mkdirSync(path.join(fixture.root, "empty"));
    fs.mkdirSync(path.join(fixture.root, "vendored", ".git"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "sub"));
    fs.writeFileSync(path.join(fixture.root, "sub", ".git"), "gitdir: /outside/never-followed\n");
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const observed = (copy: Awaited<ReturnType<typeof fixture.take>>) => {
      if (copy.execution.kind !== "file-only-v4") throw new Error("Expected a finalized copy");
      return observeCopyTopology({ copyRoot: copy.copyRoot, treeRoot: copy.execution.treeRoot, shared: copy.shared, privateGitDir: path.join(copy.home, "git") });
    };
    const first = await fixture.take(pool);
    // The shared session folder is the excluded path; a nested registration in it is never observed.
    expect(first.shared).toEqual([".flywheel"]);
    fs.mkdirSync(path.join(first.copyRoot, ".flywheel", "x", ".git"), { recursive: true });
    expect(first.execution).toMatchObject({ baseline: { topology: { count: 3 } } });
    expect(first.execution.kind === "file-only-v4" && first.execution.baseline.topology).toEqual(observed(first));
    fs.rmSync(path.join(fixture.root, ".flywheel", "x"), { recursive: true });
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");
    fs.rmSync(path.join(fixture.root, "empty"), { recursive: true });
    fs.mkdirSync(path.join(fixture.root, "src", "deeper", ".git"), { recursive: true });

    const second = await fixture.take(pool);
    expect(second.home).toBe(first.home);
    expect(second.execution).toMatchObject({ baseline: { topology: { count: 4 } } });
    expect(second.execution.kind === "file-only-v4" && second.execution.baseline.topology).toEqual(observed(second));
    await pool.close();
  });

  it("refreshes a released copy in its own home, keeps its private Git directory, and has no record while it runs", async () => {
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
    const firstFiles = recordedFiles(first.home);
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");
    const recordDuringRefresh: string[] = [];
    // The read of the real index runs after the home was reset, before the copy is recorded again.
    fixture.during("--stage", async () => {
      recordDuringRefresh.push((await readPrivateProjectCopy(first.home, jobs)).kind);
    });

    const second = await fixture.take(pool);

    expect(second.home).toBe(first.home);
    expect(recordDuringRefresh).toEqual(["missing"]);
    expect(fixture.initialized).toEqual([path.join(first.home, "git")]);
    expect(second.refresh).toMatchObject({ recloned: 0, removed: 0, reseeded: false });
    // The kept directory's baseline is the first take's, which no read of the private state replaced.
    expect(second.execution).toEqual(first.execution);
    expect({ tree: identity(treeFile), base: identity(baseFile) }).toEqual(before);
    expect(fs.readFileSync(path.join(second.copyRoot, ".git"), "utf8")).toBe(`gitdir: ${path.join(second.home, "git")}\n`);
    expect(recordedFiles(second.home)).toEqual(firstFiles);
    await pool.close();
  });

  /** What a command can leave in its copy's private Git directory, its home, and beside its copy root. */
  function leaveTraces(copy: Awaited<ReturnType<ReturnType<typeof project>["take"]>>) {
    const treeRoot = path.dirname(copy.copyRoot);
    const git = path.join(copy.home, "git");
    fs.mkdirSync(path.join(git, "objects", "ab"), { recursive: true });
    fs.writeFileSync(path.join(git, "objects", "ab", "cdef"), "loose");
    fs.writeFileSync(path.join(git, "ORIG_HEAD"), OBJECT);
    fs.writeFileSync(path.join(git, "index.lock"), "");
    fs.appendFileSync(path.join(git, "config"), "[user]\nname = x\n");
    fs.mkdirSync(path.join(git, "info"), { recursive: true });
    fs.writeFileSync(path.join(git, "info", "exclude"), "*.left\n");
    fs.mkdirSync(path.join(git, "hooks"), { recursive: true });
    fs.writeFileSync(path.join(git, "hooks", "pre-commit"), "#!/bin/sh\n");
    fs.mkdirSync(path.join(copy.home, "merge"));
    fs.writeFileSync(path.join(copy.home, "stray.txt"), "stray");
    fs.mkdirSync(path.join(treeRoot, "stray-dir"));
    fs.writeFileSync(path.join(treeRoot, "stray-dir", "f"), "f");
    fs.writeFileSync(path.join(copy.copyRoot, "created.txt"), "not landed");
    return {
      treeRoot, git,
      removed: [path.join(git, "ORIG_HEAD"), path.join(git, "index.lock"), path.join(git, "info"), path.join(git, "hooks"), path.join(copy.home, "merge"), path.join(copy.home, "stray.txt"), path.join(treeRoot, "stray-dir"), path.join(copy.copyRoot, "created.txt")],
    };
  }

  it("keeps the objects of a private Git directory whose real repository did not move, and writes its configuration again", async () => {
    const fixture = project({ prefix: "pkg" });
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    const { treeRoot, git, removed } = leaveTraces(first);
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");

    const second = await fixture.take(pool);

    expect(second.home).toBe(first.home);
    expect(second.refresh).toMatchObject({ removed: 1, reseeded: false });
    expect(fixture.initialized).toHaveLength(1);
    for (const left of removed) expect(fs.existsSync(left)).toBe(false);
    expect(fs.readFileSync(path.join(git, "objects", "ab", "cdef"), "utf8")).toBe("loose");
    expect(fs.readFileSync(path.join(git, "config"), "utf8")).not.toContain("[user]");
    expect(fs.readFileSync(path.join(git, "objects", "info", "alternates"), "utf8")).toBe(`${path.join(fixture.top, ".git", "objects")}\n`);
    expect(fs.readdirSync(treeRoot).sort()).toEqual([".git", "pkg"]);
    expect(fs.readFileSync(path.join(treeRoot, ".git"), "utf8")).toBe(`gitdir: ${git}\n`);
    await pool.close();
  });

  it("takes a new copy without a warning when the pool's Worker ended after the idle copy was taken, because the new Worker holds no state of it", async () => {
    const fixture = project();
    const workers: Worker[] = [];
    const pool = createPrivateCopyPool({ probe: noSurvivor, spawn: (specifier, options) => {
      const worker = new Worker(specifier, options);
      workers.push(worker);
      return worker;
    } });
    const first = await fixture.take(pool);
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");
    const ended = Promise.withResolvers<void>();
    workers[0]!.addEventListener("close", () => ended.resolve(), { once: true });
    workers[0]!.terminate();
    await ended.promise;
    const warn = spyOn(Log.create({ service: "bash-private-copy" }), "warn");

    let warnings = 0;
    const second = await fixture.take(pool).finally(() => {
      warnings = warn.mock.calls.length;
      warn.mockRestore();
    });

    // A state the Worker no longer holds is an expected miss, not a failed refresh.
    expect(warnings).toBe(0);
    expect(workers.length).toBe(2);
    expect(second.home).not.toBe(first.home);
    expect(second.refresh).toBeUndefined();
    expect(fs.readFileSync(path.join(second.copyRoot, "src", "a.ts"), "utf8")).toBe("source\n");
    await pool.close();
    expect(fs.existsSync(first.home)).toBe(false);
  });

  it.each<readonly [string, (repository: FakeRepository, top: string) => void]>([
    ["HEAD moved to another branch", repository => { repository.head = "refs/heads/other"; }],
    ["a ref was added", repository => { repository.refs += `${OBJECT} refs/tags/v1\n`; }],
    ["the stash changed", repository => { repository.stash = `${OBJECT} On main: saved\n`; }],
    ["a file was staged", repository => { repository.index = `100644 ${OBJECT} 0\tsrc/a.ts\0`; }],
    ["a linked tree was added", (repository, top) => { repository.worktrees += `worktree ${top}-linked\0branch refs/heads/linked\0\0`; }],
  ])("seeds the private Git directory of a reused copy again when %s in the real repository", async (_moved, move) => {
    const fixture = project();
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    const { git, removed } = leaveTraces(first);
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");
    move(fixture.repository, fixture.top);

    const second = await fixture.take(pool);

    expect(second.home).toBe(first.home);
    expect(second.refresh?.reseeded).toBe(true);
    expect(fixture.initialized).toEqual([git, git]);
    for (const left of [...removed, path.join(git, "objects", "ab")]) expect(fs.existsSync(left)).toBe(false);
    expect(fs.readFileSync(path.join(git, "config"), "utf8")).not.toContain("[user]");
    expect(second.reuse.git?.fingerprint).not.toBe(first.reuse.git?.fingerprint);
    await pool.close();
  });

  it("seeds a reftable repository again when a ref moved after its seed copied the stack", async () => {
    const fixture = project({ reftable: true });
    const real = path.join(fixture.top, ".git", "reftable");
    let moved = false;
    // The first read of the private state runs after the seed copied the stack and before the take digests it.
    fixture.during("--no-optional-locks", async () => {
      if (moved) return;
      moved = true;
      fs.writeFileSync(path.join(real, "t2.ref"), "two");
      fs.writeFileSync(path.join(real, "tables.list"), "t1.ref\nt2.ref\n");
    });
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    expect(fs.readdirSync(path.join(first.home, "git", "reftable")).sort()).toEqual(["t1.ref", "tables.list"]);
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");

    const second = await fixture.take(pool);

    expect(second.home).toBe(first.home);
    expect(second.refresh?.reseeded).toBe(true);
    expect(fs.readdirSync(path.join(second.home, "git", "reftable")).sort()).toEqual(["t1.ref", "t2.ref", "tables.list"]);
    await pool.close();
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

    expect(second.home).not.toBe(first.home);
    expect(second.refresh).toBeUndefined();
    expect(fs.readFileSync(path.join(second.copyRoot, "src", "a.ts"), "utf8")).toBe("source\n");
    await pool.close();
    expect(contents(outside)).toEqual(referent);
    expect(fs.lstatSync(fixture.mutations).isDirectory()).toBe(true);
    expect(fs.existsSync(first.home)).toBe(false);
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
    await pool.close();

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

    if (retirement === "expires") {
      offset = REUSE_IDLE_LIMIT_MS + HOUR_MS;
      expect((await fixture.take(pool)).home).not.toBe(first.home);
    }
    await pool.close();

    expect(contents(outside)).toEqual(new Map([["copy.json", "not a record"], ["tree", "directory"]]));
    expect(fs.existsSync(first.home)).toBe(false);
  });

  it.each(["exclude", "git", "objects", "objects info", ".git pointer"] as const)("writes nothing through %s replaced by a link to a file outside the home", async replaced => {
    const fixture = project();
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    const secret = path.join(createDirectory("bash-private-copy-reuse-secret-"), "secret");
    fs.writeFileSync(secret, "secret\n");
    const objects = path.join(first.home, "git", "objects");
    const target = { exclude: path.join(first.home, "exclude"), git: path.join(first.home, "git"), objects, "objects info": path.join(objects, "info"), ".git pointer": path.join(first.copyRoot, ".git") }[replaced];
    fs.rmSync(target, { recursive: true });
    fs.symlinkSync(secret, target);
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");

    const second = await fixture.take(pool);

    expect(second.home).toBe(first.home);
    // A held Git directory with a link in it is seeded again, never kept.
    expect(second.refresh?.reseeded).toBe(replaced !== "exclude" && replaced !== ".git pointer");
    expect(fs.readFileSync(secret, "utf8")).toBe("secret\n");
    expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(second.copyRoot, ".git"), "utf8")).toBe(`gitdir: ${path.join(second.home, "git")}\n`);
    await pool.close();
  });

  it("discards the idle copy when the project became a repository", async () => {
    const fixture = project({ repository: false });
    const pool = createPrivateCopyPool({ probe: noSurvivor });
    const first = await fixture.take(pool);
    expect(first.git).toEqual({ kind: "none" });
    expect(pool.release(first.reuse, LAUNCH)).toBe("pooled");
    fixture.addRepository();

    const second = await fixture.take(pool);
    await pool.close();

    expect(second.home).not.toBe(first.home);
    expect(second.git.kind).toBe("repository");
    expect(fs.existsSync(first.home)).toBe(false);
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
      await pool.close();

      expect(second.home).toBe(path.join(fixture.mutations, "h2"));
      expect(second.refresh).toBeUndefined();
      expect(fs.readFileSync(path.join(second.copyRoot, "src", "a.ts"), "utf8")).toBe("source\n");
      expect(fs.existsSync(path.join(first.home, "copy.json"))).toBe(false);
    } finally {
      fs.chmodSync(stuck, 0o755);
    }
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
    expect(expired.home).not.toBe(first.home);

    offset = 0;
    const third = await fixture.take(pool);
    offset = 20 * HOUR_MS;
    expect(pool.release(third.reuse, LAUNCH)).toBe("pooled");
    offset = 21 * HOUR_MS;
    expect((await fixture.take(pool)).home).toBe(third.home);
    await pool.close();
    expect(fs.existsSync(first.home)).toBe(false);
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

    await pool.close();
    expect(fs.existsSync(first.home)).toBe(false);
    expect(fs.existsSync(second.home)).toBe(true);
    expect(pool.release(second.reuse, LAUNCH)).toBe("slot");
    expect(pool.checkout(second.reuse.geometry)).toBeUndefined();
  });
});
