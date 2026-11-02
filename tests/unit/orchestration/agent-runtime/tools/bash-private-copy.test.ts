import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";

import type { OwnedCommandResult, OwnedCommandRunner } from "../../../../../src/infra/owned-command.js";
import { seatbeltProfile } from "../../../../../src/orchestration/agent-runtime/tools/bash-mutation-guard.js";
import { detectCopyChanges, inspectPrivateCopyTopology, readPrivateProjectCopy, takePrivateProjectCopy } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy.js";
import { copyProjectTree, scanCopyChanges } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy-tree.js";
import { readCopyRepositoryState } from "../../../../../src/orchestration/agent-runtime/tools/bash-copy-repository-state.js";
import { readRepositoryRefs, readReftableStack } from "../../../../../src/orchestration/agent-runtime/tools/bash-copy-refs.js";
import { observeFileState, sameObservedState } from "../../../../../src/orchestration/file-edits/file-state.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";
import { runPrivateCopyJob } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy-jobs.js";

const createDirectory = temporaryDirectories();

function answered(stdout: string): OwnedCommandResult {
  return { exitCode: 0, stdout, stdoutBytes: new TextEncoder().encode(stdout), stderr: "", timedOut: false };
}

const notGit: OwnedCommandRunner = async () => ({ ...answered(""), exitCode: 128 });

async function copyOf(root: string) {
  return takePrivateProjectCopy({ projectRoot: root, executionCwd: root, home: path.join(root, ".flywheel", "edits", "one"), runGit: notGit, guard: "none" });
}

describe("private project copy", () => {
  it("keeps the session folder shared and observes its exact before image after the copy is adopted", async () => {
    const root = fs.realpathSync(createDirectory("bash-private-copy-scratch-"));
    const scratchDir = path.join(root, ".flywheel", "sessions", "own", "scratch");
    const home = path.join(scratchDir, "mutations", "one");
    fs.mkdirSync(path.join(scratchDir, "notes"), { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "notes", "checkpoint.md"), "before\n");
    fs.writeFileSync(path.join(scratchDir, "deleted.bin"), Buffer.from([255, 0, 1]));
    fs.writeFileSync(path.join(path.dirname(scratchDir), "owner.pid"), "1\n");
    const copy = await takePrivateProjectCopy({ projectRoot: root, executionCwd: root, home, scratchDir, runGit: notGit, guard: "none" });
    expect(copy.shared).toEqual([".flywheel"]);
    fs.appendFileSync(path.join(copy.copyRoot, ".flywheel", "sessions", "own", "scratch", "notes", "checkpoint.md"), "after\n");
    fs.unlinkSync(path.join(scratchDir, "deleted.bin"));
    fs.writeFileSync(path.join(scratchDir, "new.txt"), "new\n");
    fs.writeFileSync(path.join(path.dirname(scratchDir), "d1.txt"), "direct\n");
    fs.writeFileSync(path.join(path.dirname(scratchDir), "owner.pid"), "2\n");
    const adopted = await readPrivateProjectCopy(home);
    if (adopted.kind !== "recorded") throw new Error("copy record missing");
    const outside = createDirectory("bash-scratch-outside-");
    fs.writeFileSync(path.join(outside, "foreign.txt"), "not scratch\n");
    fs.rmSync(path.join(home, "scratch-source"), { force: true });
    fs.symlinkSync(outside, path.join(home, "scratch-source"), "junction");
    fs.writeFileSync(path.join(home, "junk"), "not scratch\n");
    const observed = await runPrivateCopyJob({ kind: "session", home: adopted.copy.home, projectRoot: adopted.copy.realRoot });
    if (observed.kind !== "observed") throw new Error("session image damaged");
    expect(observed.changes.map(change => [path.basename(change.path), change.before && Buffer.from(change.before).toString("hex"), change.after && Buffer.from(change.after).toString("hex")])).toEqual([
      ["d1.txt", undefined, "6469726563740a"],
      ["deleted.bin", "ff0001", undefined],
      ["new.txt", undefined, "6e65770a"],
      ["checkpoint.md", "6265666f72650a", "6265666f72650a61667465720a"],
    ]);
    expect(await detectCopyChanges(adopted.copy)).toEqual({ changes: [], unsupported: [], removedDirectories: [] });
    fs.unlinkSync(path.join(home, "scratch-source"));
    expect(await runPrivateCopyJob({ kind: "session", home, projectRoot: root })).toEqual(observed);
    fs.rmSync(path.join(home, "session-before"), { recursive: true });
    expect(await runPrivateCopyJob({ kind: "session", home, projectRoot: root })).toEqual({ kind: "observed", changes: [], removedDirectories: [] });
    const old = await copyOf(fs.realpathSync(createDirectory("bash-private-copy-no-image-")));
    expect(await runPrivateCopyJob({ kind: "session", home: old.home, projectRoot: old.realRoot })).toEqual({ kind: "observed", changes: [], removedDirectories: [] });
  });

  it.each(["replaced", "symlink", "missing"] as const)("reports a %s before image as damaged instead of trusting its bytes", async tamper => {
    const root = fs.realpathSync(createDirectory("bash-private-copy-damaged-scratch-"));
    const scratchDir = path.join(root, ".flywheel", "sessions", "own", "scratch");
    const home = path.join(scratchDir, "mutations", "one");
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "note.md"), "before\n");
    const copy = await takePrivateProjectCopy({ projectRoot: root, executionCwd: root, home, scratchDir, runGit: notGit, guard: "none" });
    fs.writeFileSync(path.join(scratchDir, "note.md"), "after\n");
    const image = path.join(home, "session-before", "scratch", "note.md");
    fs.unlinkSync(image);
    if (tamper === "replaced") fs.writeFileSync(image, "after\n");
    if (tamper === "symlink") fs.symlinkSync(path.join(scratchDir, "note.md"), image);
    expect(await runPrivateCopyJob({ kind: "session", home, projectRoot: root, snapshot: copy.observedSession })).toEqual({ kind: "damaged" });
  });

  it("links wholly ignored directories and gives Git private metadata without overriding repository discovery", async () => {
    const root = fs.realpathSync(createDirectory("bash-private-copy-"));
    const gitDir = path.join(root, ".git");
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(gitDir, "index"), "real index");
    fs.mkdirSync(path.join(gitDir, "hooks"));
    fs.writeFileSync(path.join(gitDir, "hooks", "pre-commit"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(gitDir, "hooks", "pre-commit.sample"), "#!/bin/sh\n");
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "dependency\n");
    fs.writeFileSync(path.join(root, "src", "a.ts"), "source\n");
    fs.writeFileSync(path.join(root, ".env"), "ignored file outside an ignored directory\n");
    const commands: string[][] = [];
    const runGit: OwnedCommandRunner = async (command) => {
      commands.push([...command]);
      expect(fs.existsSync(path.join(root, ".flywheel", "edits", "one", "copy.json"))).toBe(false);
      if (command.includes("--verify")) return answered(`${"1".repeat(40)}\n`);
      if (command.includes("--show-object-format") && !command.includes("--show-toplevel")) return answered("sha1\nfiles\n");
      if (command.includes("rev-parse")) return answered(`${root}\n${gitDir}\n${gitDir}\nsha1\nfiles\n`);
      if (command.includes("--stage")) return answered(`100644 ${"1".repeat(40)} 0\tsrc/a.ts\0`);
      if (command.includes("for-each-ref")) return answered(`${"1".repeat(40)} refs/heads/main\n`);
      if (command.includes("symbolic-ref")) return answered("refs/heads/main\n");
      if (command.includes("reflog")) return answered("");
      // Git keeps listing a linked tree whose directory was deleted until `git worktree prune`.
      if (command.includes("worktree")) return answered(`worktree ${root}\0HEAD ${"1".repeat(40)}\0branch refs/heads/main\0\0worktree ${deletedTree}\0HEAD ${"2".repeat(40)}\0branch refs/heads/gone\0prunable gitdir file points to non-existent location\0\0`);
      if (command.includes("--get-regexp")) return answered("core.repositoryformatversion 0\n");
      if (command.includes("config")) return answered(`${excludesFile}\n`);
      return answered("node_modules/\0.env\0");
    };
    const deletedTree = `${root}-deleted`;
    const excludesFile = path.join(createDirectory("bash-private-copy-config-"), "ignore");
    fs.writeFileSync(excludesFile, "*.log");

    const copy = await takePrivateProjectCopy({ projectRoot: root, executionCwd: root, home: path.join(root, ".flywheel", "edits", "one"), runGit, guard: "seatbelt" });

    expect(commands.every((command) => command[0] === "git" && ["rev-parse", "ls-files", "config", "for-each-ref", "worktree", "init", "symbolic-ref", "update-ref", "update-index", "reflog"].some((operation) => command.includes(operation)))).toBe(true);
    expect(fs.lstatSync(path.join(copy.copyRoot, "node_modules")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(copy.copyRoot, "node_modules"))).toBe(path.join(root, "node_modules"));
    expect(fs.lstatSync(path.join(copy.copyRoot, ".flywheel")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(copy.copyRoot, ".git"), "utf8")).toBe(`gitdir: ${path.join(copy.home, "git")}\n`);
    expect([...copy.files.keys()].sort()).toEqual([".env", path.join("src", "a.ts")]);
    const privateExcludes = path.join(copy.home, "exclude");
    const privateIndex = path.join(copy.home, "git", "index");
    expect(fs.readFileSync(privateIndex, "utf8")).toBe("real index");
    // A hook that can run is kept; Git's inert samples are not.
    expect(fs.readdirSync(path.join(copy.home, "git", "hooks"))).toEqual(["pre-commit"]);
    expect(copy.git).toMatchObject({ kind: "repository", gitDir, privateGitDir: path.join(copy.home, "git"), workTrees: [root] });
    // The guard resolves each tree it protects, so a deleted tree must not reach it.
    expect(() => seatbeltProfile(copy)).not.toThrow();
    // The deleted tree still holds its branch, so the private Git directory registers it: the worktrees directory, one tree directory, and its four files.
    expect(copy.execution).toMatchObject({ kind: "file-only-v4", baseline: { repository: { head: { kind: "symbolic", target: "refs/heads/main", object: "1".repeat(40) }, index: { count: 1 }, refs: { count: 1 } }, topology: { count: 7 } } });
    expect(await readPrivateProjectCopy(copy.home)).toMatchObject({ kind: "recorded", copy: { git: { kind: "repository", gitDir } } });
    // Links are symlinks to Git, so each is ignored by exact path next to the inherited patterns.
    expect(fs.readFileSync(privateExcludes, "utf8").split("\n").sort()).toEqual(["*.log", "/.flywheel", "/node_modules"]);

    fs.writeFileSync(path.join(copy.copyRoot, "node_modules", "pkg", "index.js"), "shared write\n");
    fs.writeFileSync(path.join(copy.copyRoot, "src", "a.ts"), "changed\n");
    fs.writeFileSync(privateIndex, "private index");

    expect((await detectCopyChanges(copy)).changes.map((change) => change.path)).toEqual([path.join("src", "a.ts")]);
    expect(fs.readFileSync(path.join(root, "src", "a.ts"), "utf8")).toBe("source\n");
    expect(fs.readFileSync(path.join(gitDir, "index"), "utf8")).toBe("real index");
    // The base keeps each copied file as the copy was taken, inside the home, and leaves shared entries out.
    expect(copy.baseRoot.startsWith(copy.home)).toBe(true);
    expect(fs.readFileSync(path.join(copy.baseRoot, "src", "a.ts"), "utf8")).toBe("source\n");
    expect(fs.existsSync(path.join(copy.baseRoot, "node_modules"))).toBe(false);
  });

  it("refuses the copy when Git never answers, instead of copying every ignored directory as if there were no repository", async () => {
    const root = fs.realpathSync(createDirectory("bash-private-copy-git-unanswered-"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "dependency\n");
    // A command the owned launcher ends answers no exit code: a timeout, or a runtime that is shutting down.
    const timedOut: OwnedCommandRunner = async () => ({ ...answered(""), exitCode: null, timedOut: true });
    const ended: OwnedCommandRunner = async () => ({ ...answered(""), exitCode: null });
    const home = path.join(root, ".flywheel", "edits", "one");

    await expect(takePrivateProjectCopy({ projectRoot: root, executionCwd: root, home, runGit: timedOut, guard: "none" })).rejects.toThrow("git rev-parse timed out before it answered");
    await expect(takePrivateProjectCopy({ projectRoot: root, executionCwd: root, home, runGit: ended, guard: "none" })).rejects.toThrow("git rev-parse ended before it answered");
    expect(fs.existsSync(path.join(home, "tree"))).toBe(false);
  });

  it("refuses the copy when Git refuses a repository it finds above the project, and copies a directory outside every repository", async () => {
    const root = fs.realpathSync(createDirectory("bash-private-copy-git-refused-"));
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "pkg"));
    const refused: OwnedCommandRunner = async command => {
      if (command.includes("ls-files")) throw new Error("ignored listing refused");
      return { ...answered(""), exitCode: 128, stderr: "fatal: detected dubious ownership in repository\n" };
    };

    await expect(takePrivateProjectCopy({ projectRoot: path.join(root, "pkg"), executionCwd: path.join(root, "pkg"), home: path.join(root, "pkg", ".flywheel", "edits", "one"), runGit: refused, guard: "none" })).rejects.toThrow("git rev-parse exited with 128 below a .git entry: fatal: detected dubious ownership");

    const outside = fs.realpathSync(createDirectory("bash-private-copy-outside-git-"));
    fs.writeFileSync(path.join(outside, "a.txt"), "a\n");
    expect((await copyOf(outside)).git).toEqual({ kind: "none" });
  });

  it("places bind targets for shared entries but keeps the copy's Git directory private", async () => {
    const root = fs.realpathSync(createDirectory("bash-private-copy-bind-"));
    const gitDir = path.join(createDirectory("bash-private-copy-worktree-git-"), "worktrees", "one");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(path.join(root, "pkg", "node_modules", "dep"), { recursive: true });
    fs.mkdirSync(path.join(root, "pkg", "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git"), `gitdir: ${gitDir}\n`);
    fs.writeFileSync(path.join(root, "pkg", "node_modules", "dep", "index.js"), "dependency\n");
    fs.writeFileSync(path.join(root, "pkg", "lib", "a.ts"), "source\n");
    const runGit: OwnedCommandRunner = async (command) => {
      if (command.includes("--verify")) return { ...answered(""), exitCode: 1 };
      if (command.includes("--show-object-format") && !command.includes("--show-toplevel")) return answered("sha1\nfiles\n");
      if (command.includes("rev-parse")) return answered(`${root}\n${gitDir}\n${path.dirname(path.dirname(gitDir))}\n`);
      if (command.includes("symbolic-ref")) return answered("refs/heads/main\n");
      if (command.includes("--stage")) return answered("");
      if (command.includes("for-each-ref")) return answered("");
      if (command.includes("worktree")) return answered(`worktree ${root}\0\0`);
      if (command.includes("--get-regexp")) return answered("core.repositoryformatversion 0\n");
      if (command.includes("config")) return { ...answered(""), exitCode: 1 };
      return answered("pkg/node_modules/\0");
    };

    const copy = await takePrivateProjectCopy({ projectRoot: root, executionCwd: root, home: path.join(root, ".flywheel", "edits", "one"), runGit, guard: "mount-namespace" });

    expect([...copy.shared].sort()).toEqual([".flywheel", path.join("pkg", "node_modules")]);
    expect(fs.lstatSync(path.join(copy.copyRoot, ".git")).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(copy.copyRoot, ".git"), "utf8")).toBe(`gitdir: ${path.join(copy.home, "git")}\n`);
    expect(fs.lstatSync(path.join(copy.copyRoot, ".flywheel")).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(copy.copyRoot, "pkg", "node_modules"))).toEqual([]);
    expect([...copy.files.keys()]).toEqual([path.join("pkg", "lib", "a.ts")]);

    fs.writeFileSync(path.join(copy.copyRoot, "pkg", "lib", "a.ts"), "changed\n");
    expect((await detectCopyChanges(copy)).changes.map((change) => change.path)).toEqual([path.join("pkg", "lib", "a.ts")]);
  });

  it("finalizes after split-index normalization and prefix masking, before returning or writing a V4 record", async () => {
    const top = createDirectory("bash-copy-finalization-");
    const root = path.join(top, "pkg");
    const gitDir = path.join(top, ".git");
    const home = path.join(root, ".flywheel", "copy");
    fs.mkdirSync(root);
    fs.mkdirSync(gitDir);
    fs.writeFileSync(path.join(gitDir, "index"), "split index");
    fs.writeFileSync(path.join(gitDir, "sharedindex.abc"), "shared index");
    fs.writeFileSync(path.join(root, "a.txt"), "before");
    let normalized = false;
    let masked = false;
    const runGit: OwnedCommandRunner = async command => {
      expect(fs.existsSync(path.join(home, "copy.json"))).toBe(false);
      if (command.includes("--show-toplevel")) return answered(`${top}\n${gitDir}\n${gitDir}\nsha1\nfiles\n`);
      if (command.includes("--show-ref-format")) {
        expect(normalized && masked).toBe(true);
        return answered("sha1\nfiles\n");
      }
      if (command.includes("--get-regexp")) return answered("core.repositoryformatversion 0\n");
      if (command.includes("worktree")) return answered(`worktree ${top}\0branch refs/heads/main\0\0`);
      if (command.includes("symbolic-ref")) return answered("refs/heads/main\n");
      if (command.includes("--verify")) return { ...answered(""), exitCode: 1 };
      if (command.includes("--no-split-index")) {
        normalized = true;
        fs.writeFileSync(path.join(home, "git", "index"), "standalone");
      }
      if (command.includes("--skip-worktree")) {
        expect(normalized).toBe(true);
        masked = true;
      }
      if (command.includes("ls-files") && command.includes(":(top,exclude)pkg/")) return answered("outside.txt\0");
      if (command.includes("--stage")) return answered(`100644 ${"1".repeat(40)} 0\tpkg/a.txt\0`);
      return answered("");
    };
    const copy = await takePrivateProjectCopy({ projectRoot: root, executionCwd: root, home, runGit, guard: "none" });
    expect(copy.execution).toMatchObject({ kind: "file-only-v4", treeRoot: path.join(home, "tree", path.basename(top)), baseline: { repository: { index: { count: 1 } }, topology: { count: 1 } } });
    expect([...copy.files.keys()]).toEqual(["a.txt"]);
    expect(await readPrivateProjectCopy(home)).toMatchObject({ kind: "recorded", copy: { execution: copy.execution, files: copy.files } });
  });

  it("expects a file's state from before its directory was cloned, so a write racing the clone reads as a conflict, and takes the base from the copy", () => {
    const root = fs.realpathSync(createDirectory("bash-private-copy-race-"));
    const racing = path.join(root, "src", "deep", "a.ts");
    fs.mkdirSync(path.dirname(racing), { recursive: true });
    fs.writeFileSync(racing, "before\n");
    const home = path.join(root, ".flywheel", "edits", "one");
    const copyRoot = path.join(home, "tree", "project");
    const baseRoot = path.join(home, "base");
    const clones: string[] = [];

    const tree = copyProjectTree({ realRoot: root, home, copyRoot, baseRoot, guard: "none", whollyIgnored: [], git: undefined }, (source, destination, kind) => {
      clones.push(`${kind} ${path.relative(root, source)}`);
      fs.writeFileSync(racing, `concurrent write ${clones.length}\n`);
      fs.cpSync(source, destination, { recursive: true });
    });
    fs.writeFileSync(path.join(copyRoot, "src", "deep", "a.ts"), "command write\n");
    const [change] = scanCopyChanges({ realRoot: root, copyRoot, baseRoot, ...tree }).changes;

    expect(clones).toEqual(["directory src", `directory ${path.relative(root, path.join(copyRoot, "src"))}`]);
    expect(change?.path).toBe(path.join("src", "deep", "a.ts"));
    expect(sameObservedState(observeFileState(racing), change!.expected)).toBe(false);
    // The base holds the bytes the command started from, not a later project write.
    expect(fs.readFileSync(path.join(baseRoot, "src", "deep", "a.ts"), "utf8")).toBe("concurrent write 1\n");
    expect(fs.readFileSync(racing, "utf8")).toBe("concurrent write 2\n");
  });

  it("recognizes metadata case aliases only when the filesystem resolves them to .git", async () => {
    const root = createDirectory("bash-copy-case-alias-");
    fs.mkdirSync(path.join(root, ".GIT"));
    const caseInsensitive = fs.existsSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".GIT", "HEAD"), "root metadata");
    const home = path.join(root, ".flywheel", "copy");
    const copyRoot = path.join(home, "tree");
    const baseRoot = path.join(home, "base");
    const copied = copyProjectTree({ realRoot: root, home, copyRoot, baseRoot, guard: "none", whollyIgnored: [], git: undefined });
    expect(fs.existsSync(path.join(copyRoot, ".GIT"))).toBe(!caseInsensitive);
    const copy = { realRoot: root, copyRoot, baseRoot, ...copied };
    const request = { copyRoot, treeRoot: copyRoot, shared: copied.shared, privateGitDir: null };
    const before = await inspectPrivateCopyTopology(request);
    fs.mkdirSync(path.join(copyRoot, "nested", ".GIT"), { recursive: true });
    fs.writeFileSync(path.join(copyRoot, "nested", ".GIT", "HEAD"), "nested metadata");
    fs.writeFileSync(path.join(copyRoot, "nested", "adjacent.txt"), "edit");
    const after = await inspectPrivateCopyTopology(request);
    expect(after.count - before.count).toBe(caseInsensitive ? 1 : 0);
    const changes = await detectCopyChanges(copy);
    expect(changes.changes.map(change => change.path).sort()).toEqual([
      ...(!caseInsensitive ? [path.join("nested", ".GIT", "HEAD")] : []),
      path.join("nested", "adjacent.txt"),
    ]);
    expect(changes.unsupported.map(change => change.path)).toEqual(caseInsensitive ? [path.join("nested", ".GIT")] : []);
  });

  it("records the copy in its home when it is taken, and the record reads back as the copy its landing reads", async () => {
    const root = fs.realpathSync(createDirectory("bash-private-copy-record-"));
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "a.ts"), "source\n");
    fs.writeFileSync(path.join(root, "run.sh"), "#!/bin/sh\n", { mode: 0o755 });
    fs.symlinkSync("src/a.ts", path.join(root, "alias"));
    const { scratchDir: _scratchDir, reuse: _reuse, ...copy } = await copyOf(root);

    const read = await readPrivateProjectCopy(copy.home);

    expect(JSON.parse(fs.readFileSync(path.join(copy.home, "copy.json"), "utf8")).version).toBe(4);
    expect(copy).toMatchObject({ execution: { kind: "file-only-v4", baseline: { repository: null, topology: { count: 0 } } } });
    expect(read).toEqual({ kind: "recorded", copy });
    expect(copy.guard).toBe("none");
    expect([...copy.links]).toEqual([["alias", path.join("src", "a.ts")]]);
    // Just written, so each file's real state is pinned by the hash of its bytes too.
    expect([...copy.files.values()].every((file) => file.real.sha256 !== undefined)).toBe(true);
  });

  it.each([1, 2] as const)("reads a version %s record as a later release must read these bytes", async (version) => {
    const home = createDirectory("bash-private-copy-record-v1-");
    const real = { identity: "16777233:4242", size: 7, mtimeNs: "1758800000123456789", ctimeNs: "1758800000123456790" };
    fs.writeFileSync(path.join(home, "copy.json"), JSON.stringify({
      version,
      ...(version === 2 ? { gitDir: path.join(home, "real-git") } : {}),
      realRoot: "/work/app",
      copyRoot: path.join(home, "tree", "app"),
      baseRoot: path.join(home, "base"),
      guard: "seatbelt",
      shared: ["node_modules", ".flywheel"],
      files: [
        { path: "src/a.ts", real, copy: { ...real, identity: "16777233:5151" }, mode: 420 },
        { path: "src/b.ts", real: { ...real, identity: "16777233:4343", sha256: "a".repeat(64) }, copy: { ...real, identity: "16777233:5252" }, mode: 493 },
      ],
      links: [{ path: "alias", target: "src/a.ts" }],
    }));
    const fingerprint = (identity: string) => ({ kind: "file" as const, identity, size: 7, mtimeNs: 1758800000123456789n, ctimeNs: 1758800000123456790n });

    expect(await readPrivateProjectCopy(home)).toEqual({
      kind: "recorded",
      copy: {
        home,
        realRoot: "/work/app",
        copyRoot: path.join(home, "tree", "app"),
        baseRoot: path.join(home, "base"),
        guard: "seatbelt",
        shared: ["node_modules", ".flywheel"],
        files: new Map([
          ["src/a.ts", { real: fingerprint("16777233:4242"), copy: fingerprint("16777233:5151"), mode: 420 }],
          ["src/b.ts", { real: { ...fingerprint("16777233:4343"), sha256: "a".repeat(64) }, copy: fingerprint("16777233:5252"), mode: 493 }],
        ]),
        links: new Map([["alias", "src/a.ts"]]),
        git: version === 2 ? { kind: "shared-repository", gitDir: path.join(home, "real-git") } : { kind: "unrecorded" },
        execution: { kind: "legacy-unlandable", version },
      },
    });
  });

  it.each([2, 3] as const)("classifies literal V%s records by recorded Git identity without rewriting or fabricating a baseline", async version => {
    const home = createDirectory("bash-copy-legacy-");
    const record = path.join(home, "copy.json");
    for (const inGit of [true, false]) {
      const bytes = JSON.stringify({
        version, realRoot: path.join(home, "real"), copyRoot: path.join(home, "tree"), baseRoot: path.join(home, "base"),
        guard: "none", shared: [], files: [], links: [], gitDir: inGit ? path.join(home, "real-git") : null,
        ...(version === 3 ? { privateGitDir: inGit ? path.join(home, "git") : null, commonDir: inGit ? path.join(home, "real-git") : null, workTrees: [] } : {}),
      });
      fs.writeFileSync(record, bytes);
      const read = await readPrivateProjectCopy(home);
      expect(read).toMatchObject({ kind: "recorded", copy: { execution: { kind: inGit ? "legacy-unlandable" : "legacy-non-git", version } } });
      if (read.kind === "recorded") expect("baseline" in read.copy.execution).toBe(false);
      expect(fs.readFileSync(record, "utf8")).toBe(bytes);
    }
  });

  it("requires a complete current-policy baseline and rejects unknown V4 fields without changing the bytes", async () => {
    const root = createDirectory("bash-copy-strict-v4-");
    const copy = await copyOf(root);
    const file = path.join(copy.home, "copy.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const invalid of [
      { ...stored, extra: true },
      { ...stored, execution: { ...stored.execution, baseline: { topology: stored.execution.baseline.topology } } },
      { ...stored, execution: { ...stored.execution, baseline: { ...stored.execution.baseline, topology: { count: 0, sha256: "partial" } } } },
    ]) {
      const bytes = JSON.stringify(invalid);
      fs.writeFileSync(file, bytes);
      expect(await readPrivateProjectCopy(copy.home)).toEqual({ kind: "unreadable", reason: "does not have the shape of version 4" });
      expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    }
  });

  it("binds the tree-root pointer above a project prefix and detects new nested registrations without following shared or link targets", async () => {
    const root = createDirectory("bash-copy-topology-");
    const copy = await copyOf(root);
    if (copy.execution.kind !== "file-only-v4") throw new Error("Expected a finalized copy");
    const request = { copyRoot: copy.copyRoot, treeRoot: copy.execution.treeRoot, shared: copy.shared, privateGitDir: null };
    const baseline = await inspectPrivateCopyTopology(request);
    const external = createDirectory("bash-copy-linked-git-");
    fs.mkdirSync(path.join(external, ".git"));
    fs.symlinkSync(external, path.join(copy.copyRoot, "linked"), "junction");
    expect(await inspectPrivateCopyTopology(request)).toEqual(baseline);
    const prefix = path.join(copy.copyRoot, "prefix");
    fs.mkdirSync(prefix);
    fs.writeFileSync(path.join(copy.copyRoot, ".git"), "gitdir: /outside/never-followed\n");
    const prefixed = { ...request, copyRoot: prefix };
    const registered = await inspectPrivateCopyTopology(prefixed);
    expect(registered).not.toEqual(baseline);
    fs.writeFileSync(path.join(copy.copyRoot, ".git"), "gitdir: /different/never-followed\n");
    expect(await inspectPrivateCopyTopology(prefixed)).not.toEqual(registered);
    fs.mkdirSync(path.join(prefix, "nested", ".git"), { recursive: true });
    expect((await inspectPrivateCopyTopology(prefixed)).count).toBe(2);
    const privateGitDir = path.join(copy.home, "git");
    fs.mkdirSync(path.join(privateGitDir, "worktrees", "new"), { recursive: true });
    fs.writeFileSync(path.join(privateGitDir, "worktrees", "new", "gitdir"), "/outside/never-followed");
    const withWorktree = await inspectPrivateCopyTopology({ ...prefixed, privateGitDir });
    expect(withWorktree.count).toBeGreaterThan(2);
    fs.mkdirSync(path.join(privateGitDir, "modules"));
    expect(await inspectPrivateCopyTopology({ ...prefixed, privateGitDir })).not.toEqual(withWorktree);
  });

  it("merges dangling loose symbolic refs with enumeration and refuses linked metadata rather than following it", async () => {
    const gitDir = createDirectory("bash-copy-refs-");
    fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(gitDir, "refs", "heads", "dangling"), "ref: refs/heads/missing\n");
    const input = { gitDir, runGit: async () => answered(`${"1".repeat(40)} refs/heads/main\n`) };
    expect([...(await readRepositoryRefs(input))]).toEqual([
      ["refs/heads/dangling", { kind: "symbolic", target: "refs/heads/missing", object: null }],
      ["refs/heads/main", { kind: "direct", object: "1".repeat(40) }],
    ]);
    fs.symlinkSync(path.join(gitDir, "refs", "heads", "dangling"), path.join(gitDir, "refs", "heads", "linked"));
    await expect(readRepositoryRefs(input)).rejects.toThrow("not a regular file or directory");
  });

  it("captures a reftable stash and dangling symbolic ref, detects table changes, and refuses incomplete metadata without objects", async () => {
    const gitDir = createDirectory("bash-copy-reftable-");
    const directory = path.join(gitDir, "reftable");
    fs.mkdirSync(directory);
    const list = path.join(directory, "tables.list");
    fs.writeFileSync(list, "first.ref\nsecond.ref\n");
    // Git 2.49 fixture: one stash and a dangling symbolic ref, followed by an update to its dangling target.
    fs.writeFileSync(path.join(directory, "first.ref"), Buffer.from("UkVGVAEAEAAAAAAAAAAAAQAAAAAAAAAGcgAAvwAjSEVBRAAPcmVmcy9oZWFkcy9tYWluAElPUklHX0hFQUQDxUqZVTTsODCN57CIeUwo98ZUrt0AgBtyZWZzL2hlYWRzL2RhbmdsaW5nBRJyZWZzL2hlYWRzL21pc3NpbmcLIW1haW4BxUqZVTTsODCN57CIeUwo98ZUrt0FKXN0YXNoAm5i16P//NOTiprlbcyWDLjDusDGAAAcAAAzAABTAANnAAGSeNpjyPRwdXRh+A8Bv456zQw1eWNh0Pt8Q0elj8b3YyHr7mITY3TjTHPIzCtLzMlMaT159SMDA4NYUWpxaomVQm5+WWZeukJJvgLIZC4ezr8MWACRhkol5+fmZpYoaGTmZZZkJuZoWilAWVwMDY5FqWnF+hmpiSnF+rmJmXkwX9DIQtbC4pLE4gyYLX+w2ZKXdH3x/z+XJ3fNepp7ZhrPjsO7DhzDYgu/f54CyMVWCmmZRcUlXAwMLAwM+xiYAEF4l09SRUZUAQAQAAAAAAAAAAABAAAAAAAAAAYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAvwAAAAAAAAAA1JcBYg==", "base64"));
    fs.writeFileSync(path.join(directory, "second.ref"), Buffer.from("UkVGVAEAEAAAAAAAAAAABwAAAAAAAAAHcgAASQCAG3JlZnMvaGVhZHMvZGFuZ2xpbmcAEHJlZnMvaGVhZHMvb3RoZXIAABwAAVJFRlQBABAAAAAAAAAAAAcAAAAAAAAABwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+b3Bn", "base64"));
    fs.writeFileSync(path.join(directory, "obsolete.ref"), "not in the active stack");
    const runGit: OwnedCommandRunner = async command => {
      if (command.includes("--show-ref-format")) return answered("sha1\nreftable\n");
      if (command.includes("symbolic-ref")) return answered("refs/heads/main\n");
      if (command.includes("--verify")) return { ...answered(""), exitCode: 1 };
      if (command.includes("ls-files")) return answered("");
      throw new Error(`Unexpected Git call: ${command.join(" ")}`);
    };
    const baseline = await readCopyRepositoryState(gitDir, runGit);
    expect(baseline.refs.count).toBe(3);
    expect(baseline.stash).toEqual(baseline.refs);
    expect([...await readReftableStack(gitDir)].map(([name]) => name)).toEqual(["tables.list", "first.ref", "second.ref"]);
    fs.writeFileSync(path.join(directory, "obsolete.ref"), "ignored obsolete bytes");
    expect(await readCopyRepositoryState(gitDir, runGit)).toEqual(baseline);
    for (const name of ["first.ref", "second.ref"]) {
      const bytes = fs.readFileSync(path.join(directory, name));
      fs.appendFileSync(path.join(directory, name), "changed");
      const changed = await readCopyRepositoryState(gitDir, runGit);
      expect(changed.refs).not.toEqual(baseline.refs);
      expect(changed.stash).not.toEqual(baseline.stash);
      fs.writeFileSync(path.join(directory, name), bytes);
    }
    fs.writeFileSync(list, "second.ref\nfirst.ref\n");
    expect((await readCopyRepositoryState(gitDir, runGit)).refs).not.toEqual(baseline.refs);
    fs.unlinkSync(path.join(directory, "first.ref"));
    await expect(readReftableStack(gitDir)).rejects.toThrow("ENOENT");
    fs.symlinkSync(path.join(directory, "second.ref"), path.join(directory, "first.ref"));
    await expect(readReftableStack(gitDir)).rejects.toThrow("not a regular file");
    fs.writeFileSync(list, "../outside.ref\n");
    await expect(readReftableStack(gitDir)).rejects.toThrow("invalid reftable list");
    expect(fs.readdirSync(gitDir)).toEqual(["reftable"]);
  });

  it.each(["sha1", "sha256"] as const)("compares raw %s index paths, entry stages, symbolic targets and ordered stash without storing enumerations", async format => {
    const gitDir = createDirectory("bash-copy-semantic-");
    const oid = "1".repeat(format === "sha1" ? 40 : 64);
    let pathByte = 0xff;
    let stage = 0;
    let reversed = false;
    let captured: Uint8Array = new Uint8Array();
    let stash = [`${"1".repeat(40)} first`, `${"2".repeat(40)} second`];
    let target = "refs/heads/main";
    const runGit: OwnedCommandRunner = async command => {
      if (command.includes("--show-ref-format")) return answered(`${format}\nfiles\n`);
      if (command.includes("for-each-ref")) return answered(`${"1".repeat(40)} refs/heads/main\n${"2".repeat(40)} refs/stash\n`);
      if (command.includes("symbolic-ref")) return answered(`${target}\n`);
      if (command.includes("--verify")) return answered(`${"1".repeat(40)}\n`);
      if (command.includes("reflog")) return answered(`${stash.join("\n")}\n`);
      const entries = [
        Buffer.concat([Buffer.from(`100644 ${oid} ${stage}\t`), Buffer.from([pathByte, 0])]),
        Buffer.from(`100755 ${oid} 0\tother\npath\0`),
      ];
      captured = new Uint8Array(Buffer.concat(reversed ? entries.toReversed() : entries));
      return { ...answered("the lossy text view does not identify this path"), stdoutBytes: captured };
    };
    const baseline = await readCopyRepositoryState(gitDir, runGit);
    const first = Buffer.concat([Buffer.from(`100644 ${oid} 0\t`), Buffer.from([0xff])]);
    const second = Buffer.from(`100755 ${oid} 0\tother\npath`);
    const expected = createHash("sha256").update(`${first.length}:`).update(first).update(`${second.length}:`).update(second).digest("hex");
    expect(baseline).toMatchObject({ index: { count: 2, sha256: expected }, stash: { count: 2 }, refs: { count: 2 } });
    expect(captured.byteLength).toBe(0);
    reversed = true;
    expect((await readCopyRepositoryState(gitDir, runGit)).index).toEqual(baseline.index);
    pathByte = 0xfe;
    expect((await readCopyRepositoryState(gitDir, runGit)).index).not.toEqual(baseline.index);
    pathByte = 0xff;
    stage = 2;
    expect((await readCopyRepositoryState(gitDir, runGit)).index).not.toEqual(baseline.index);
    stage = 0;
    stash = stash.toReversed();
    expect((await readCopyRepositoryState(gitDir, runGit)).stash).not.toEqual(baseline.stash);
    target = "refs/heads/alias";
    expect((await readCopyRepositoryState(gitDir, runGit)).head).not.toEqual(baseline.head);
    expect(JSON.stringify(baseline).length).toBeLessThan(600);
  });

  it.each(["for-each-ref", "ls-files", "reflog"] as const)("refuses a partial %s enumeration instead of treating it as equality", async operation => {
    const gitDir = createDirectory("bash-copy-partial-");
    const runGit: OwnedCommandRunner = async command => {
      if (command.includes(operation)) return { ...answered(""), stdoutTruncated: true };
      if (command.includes("--show-ref-format")) return answered("sha1\nfiles\n");
      if (command.includes("for-each-ref")) return answered(`${"1".repeat(40)} refs/stash\n`);
      if (command.includes("symbolic-ref")) return answered("refs/heads/main\n");
      if (command.includes("--verify")) return { ...answered(""), exitCode: 1 };
      return answered("");
    };
    await expect(readCopyRepositoryState(gitDir, runGit)).rejects.toThrow(operation === "for-each-ref" ? "complete refs" : "did not finish completely");
  });

  it.each([
    { index: `100644 ${"1".repeat(40)} 0\tpath`, reason: "incomplete index entry" },
    { index: `100644 ${"1".repeat(40)} 4\tpath\0`, reason: "invalid index entry" },
    { index: `100644 ${"1".repeat(40)} 0\t\0`, reason: "invalid index entry" },
  ])("refuses $reason from the index Worker", async ({ index, reason }) => {
    const gitDir = createDirectory("bash-copy-invalid-index-");
    const runGit: OwnedCommandRunner = async command => {
      if (command.includes("--show-ref-format")) return answered("sha1\nfiles\n");
      if (command.includes("for-each-ref")) return answered("");
      if (command.includes("symbolic-ref")) return answered("refs/heads/main\n");
      if (command.includes("--verify")) return { ...answered(""), exitCode: 1 };
      return answered(index);
    };
    await expect(readCopyRepositoryState(gitDir, runGit)).rejects.toThrow(reason);
  });

  it("answers why it cannot read a record that is missing, of another version, or not a record, and leaves every record as it is", async () => {
    const home = createDirectory("bash-private-copy-record-unreadable-");
    const record = path.join(home, "copy.json");
    expect(await readPrivateProjectCopy(home)).toEqual({ kind: "missing" });

    const later = JSON.stringify({ version: 5, realRoot: "/work/app", layout: "unknown" });
    fs.writeFileSync(record, later);
    expect(await readPrivateProjectCopy(home)).toEqual({ kind: "unreadable", reason: "has version 5, which this build cannot read" });
    expect(fs.readFileSync(record, "utf8")).toBe(later);

    fs.writeFileSync(record, "{ half");
    expect(await readPrivateProjectCopy(home)).toEqual({ kind: "unreadable", reason: "is not valid JSON" });
    fs.writeFileSync(record, JSON.stringify({ version: 1, realRoot: "/work/app" }));
    expect(await readPrivateProjectCopy(home)).toEqual({ kind: "unreadable", reason: "does not have the shape of version 1" });
    fs.writeFileSync(record, JSON.stringify({ version: 2, realRoot: "/work/app" }));
    expect(await readPrivateProjectCopy(home)).toEqual({ kind: "unreadable", reason: "does not have the shape of version 2" });
    expect(fs.existsSync(record)).toBe(true);
  });

  it("carries exact bytes of a changed or deleted file of any size", async () => {
    const root = fs.realpathSync(createDirectory("bash-private-copy-large-"));
    const large = 16 * 1024 * 1024 + 1;
    fs.writeFileSync(path.join(root, "grown.bin"), "small\n");
    fs.writeFileSync(path.join(root, "removed.bin"), Buffer.alloc(large, 1));
    const copy = await copyOf(root);
    const grown = Buffer.alloc(large, 2);
    fs.writeFileSync(path.join(copy.copyRoot, "grown.bin"), grown);
    fs.rmSync(path.join(copy.copyRoot, "removed.bin"));

    const { changes, unsupported } = await detectCopyChanges(copy);

    expect(unsupported).toEqual([]);
    expect(changes.map((change) => [change.path, change.after?.byteLength, change.expected.kind])).toEqual([["grown.bin", large, "file"], ["removed.bin", undefined, "file"]]);
    expect(Buffer.from(changes[0]!.after!).equals(grown)).toBe(true);
  });

  it("reports what only regular file contents cannot carry, and never turns a file replaced by another kind into a deletion", async () => {
    const root = fs.realpathSync(createDirectory("bash-private-copy-kinds-"));
    const outside = fs.realpathSync(createDirectory("bash-private-copy-outside-"));
    for (const name of ["to-link.txt", "to-dir.txt", "chmod.txt", "both.txt"]) fs.writeFileSync(path.join(root, name), `${name}\n`);
    fs.symlinkSync("to-link.txt", path.join(root, "kept-link"));
    fs.symlinkSync(outside, path.join(root, "escape"));
    const copy = await copyOf(root);
    const inCopy = (name: string) => path.join(copy.copyRoot, name);
    fs.rmSync(inCopy("to-link.txt"));
    fs.symlinkSync("elsewhere", inCopy("to-link.txt"));
    fs.rmSync(inCopy("to-dir.txt"));
    fs.mkdirSync(inCopy("to-dir.txt"));
    fs.symlinkSync("to-dir.txt", inCopy("new-link"));
    fs.chmodSync(inCopy("chmod.txt"), 0o755);
    fs.writeFileSync(inCopy("both.txt"), "changed\n");
    fs.chmodSync(inCopy("both.txt"), 0o700);
    // A command that swaps a copied link for a directory must not land a file through the real link.
    fs.rmSync(inCopy("escape"));
    fs.mkdirSync(inCopy("escape"));
    fs.writeFileSync(path.join(inCopy("escape"), "planted.txt"), "outside\n");

    const { changes, unsupported } = await detectCopyChanges(copy);

    expect(changes.map((change) => [change.path, change.mode])).toEqual([["both.txt", undefined]]);
    const permissions = process.platform === "win32" ? [] : [{ path: "both.txt", reason: "permissions changed" }, { path: "chmod.txt", reason: "permissions changed" }];
    expect(unsupported).toEqual([
      ...permissions,
      { path: "escape", reason: "symbolic link replaced by a directory" },
      { path: path.join("escape", "planted.txt"), reason: "escape is a symbolic link in the project" },
      { path: "new-link", reason: "symbolic link created" },
      { path: "to-dir.txt", reason: "replaced by a directory" },
      { path: "to-link.txt", reason: "replaced by a symbolic link" },
    ]);
  });
});
