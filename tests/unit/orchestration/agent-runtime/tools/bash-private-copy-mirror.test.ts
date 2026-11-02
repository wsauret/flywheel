import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { cloneEntry, mirrorTree, type MirrorRequest, type MirrorState } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy-mirror.js";
import { copyProjectTree, type CopyTreeRequest } from "../../../../../src/orchestration/agent-runtime/tools/bash-private-copy-tree.js";
import { scanSessionChanges, snapshotSessionFolder } from "../../../../../src/orchestration/agent-runtime/tools/bash-session-observation.js";
import { observeFileState, sameObservedState } from "../../../../../src/orchestration/file-edits/file-state.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

const createDirectory = temporaryDirectories();

/** A start this far after every file the test wrote keeps them outside the racy window. */
const settled = (): bigint => BigInt(Date.now()) * 1_000_000n + 10_000_000_000n;
const now = (): bigint => BigInt(Date.now()) * 1_000_000n;

function mirror(source: string, target: string, prior: MirrorState | undefined, options: Partial<MirrorRequest> = {}): MirrorState {
  return mirrorTree({ source, target, plan: () => "mirror", prior, startedNs: settled(), pin: true, clone: cloneEntry, ...options });
}

/** Every entry below `root`, links unfollowed, with its identity and both timestamps. */
function entryStamps(root: string): Map<string, string> {
  const stamps = new Map<string, string>();
  const walk = (directory: string): void => {
    for (const name of fs.readdirSync(path.join(root, directory))) {
      const relative = path.join(directory, name);
      const stats = fs.lstatSync(path.join(root, relative), { bigint: true });
      stamps.set(relative, `${stats.ino}:${stats.mtimeNs}:${stats.ctimeNs}`);
      if (stats.isDirectory()) walk(relative);
    }
  };
  const rootStats = fs.lstatSync(root, { bigint: true });
  stamps.set("", `${rootStats.ino}:${rootStats.mtimeNs}:${rootStats.ctimeNs}`);
  walk("");
  return stamps;
}

function inode(file: string): bigint {
  return fs.lstatSync(file, { bigint: true }).ino;
}

function project(prefix: string) {
  const top = fs.realpathSync(createDirectory(prefix));
  const root = path.join(top, "real");
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  fs.writeFileSync(path.join(root, "a.txt"), "alpha\n");
  fs.writeFileSync(path.join(root, "src", "b.txt"), "bravo\n");
  fs.writeFileSync(path.join(root, "src", "deep", "c.txt"), "charlie\n");
  fs.symlinkSync("a.txt", path.join(root, "alias"));
  fs.symlinkSync("../a.txt", path.join(root, "src", "alias"));
  return { root, target: path.join(top, "copy") };
}

function take(root: string, overrides: Partial<CopyTreeRequest> = {}) {
  const home = path.join(path.dirname(root), "home");
  return copyProjectTree({ realRoot: root, home, copyRoot: path.join(home, "tree", "real"), baseRoot: path.join(home, "base"), guard: "none", whollyIgnored: [], git: undefined, ...overrides });
}

describe("private copy mirror", () => {
  it("writes nothing when nothing changed, and answers the prior record", () => {
    const { root, target } = project("mirror-unchanged-");
    const first = mirror(root, target, undefined);
    const before = entryStamps(target);

    const second = mirror(root, target, first);

    expect(entryStamps(target)).toEqual(before);
    expect(second).toEqual(first);
  });

  it("keeps a generated pointer at the target root and never mirrors a source entry over it", () => {
    const { root, target } = project("mirror-generated-");
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, ".git"), "gitdir: private\n");
    const pointer = inode(path.join(target, ".git"));
    const generated = new Set([".git"]);

    const first = mirror(root, target, undefined, { generated });
    mirror(root, target, first, { generated });

    expect(fs.readFileSync(path.join(target, ".git"), "utf8")).toBe("gitdir: private\n");
    expect(inode(path.join(target, ".git"))).toBe(pointer);
    expect(first.files.has(path.join(".git", "HEAD"))).toBe(false);
  });

  it.each([["outside the racy window", settled], ["inside the racy window", now]] as const)("clones again a same-size rewrite whose mtime was restored, %s", (_window, start) => {
    const { root, target } = project("mirror-same-size-");
    const real = path.join(root, "src", "b.txt");
    const first = mirror(root, target, undefined, { startedNs: start() });
    const { atime, mtime } = fs.statSync(real);
    fs.writeFileSync(real, "BRAVO\n");
    fs.utimesSync(real, atime, mtime);

    mirror(root, target, first, { startedNs: start() });

    expect(fs.readFileSync(path.join(target, "src", "b.txt"), "utf8")).toBe("BRAVO\n");
  });

  it("clones again a file whose only change is its ctime, and records its new state", () => {
    const { root, target } = project("mirror-ctime-");
    const real = path.join(root, "a.txt");
    const first = mirror(root, target, undefined);
    fs.chmodSync(real, fs.statSync(real).mode & 0o777);
    fs.writeFileSync(real, "alpha\n");

    const tally = { recloned: 0, removed: 0 };
    const second = mirror(root, target, first, { tally });

    expect(fs.readFileSync(path.join(target, "a.txt"), "utf8")).toBe("alpha\n");
    expect(sameObservedState(observeFileState(real), second.files.get("a.txt")!.source)).toBe(true);
    expect(tally).toEqual({ recloned: 1, removed: 1 });
  });

  it("clones again a file whose fingerprint matches the record but whose pinned hash names older bytes", () => {
    const { root, target } = project("mirror-stale-hash-");
    const first = mirror(root, target, undefined);
    const recorded = first.files.get("a.txt")!;
    const stale: MirrorState = { ...first, files: new Map([...first.files, ["a.txt", { ...recorded, source: { ...recorded.source, sha256: createHash("sha256").update("older\n").digest("hex") } }]]) };

    const tally = { recloned: 0, removed: 0 };
    mirror(root, target, stale, { tally });

    expect(tally).toEqual({ recloned: 1, removed: 1 });
    expect(fs.readFileSync(path.join(target, "a.txt"), "utf8")).toBe("alpha\n");
  });

  it("removes what only the copy and its base hold, empty directories included", () => {
    const { root } = project("mirror-leftover-");
    const first = take(root);
    const home = path.join(path.dirname(root), "home");
    const copyRoot = path.join(home, "tree", "real");
    fs.writeFileSync(path.join(copyRoot, "src", "left.txt"), "refused\n");
    fs.mkdirSync(path.join(copyRoot, "empty"));
    fs.writeFileSync(path.join(home, "base", "left.txt"), "stray\n");

    take(root, { prior: first.state });

    expect(fs.existsSync(path.join(copyRoot, "src", "left.txt"))).toBe(false);
    expect(fs.existsSync(path.join(copyRoot, "empty"))).toBe(false);
    expect(fs.existsSync(path.join(home, "base", "left.txt"))).toBe(false);
  });

  it("clones a copy file the command changed again from the real file, and its base again from the copy", () => {
    const { root } = project("mirror-copy-changed-");
    const first = take(root);
    const home = path.join(path.dirname(root), "home");
    const copied = path.join(home, "tree", "real", "src", "b.txt");
    const base = path.join(home, "base", "src", "b.txt");
    fs.writeFileSync(copied, "command write\n");

    const second = take(root, { prior: first.state });

    expect(fs.readFileSync(copied, "utf8")).toBe("bravo\n");
    expect(fs.readFileSync(base, "utf8")).toBe("bravo\n");
    // The copy file from the real file, and the base file from the copy.
    expect(second.tally).toEqual({ recloned: 2, removed: 2 });
  });

  it("clones a base file changed after the take again from the untouched copy", () => {
    const { root } = project("mirror-base-changed-");
    const first = take(root);
    const home = path.join(path.dirname(root), "home");
    fs.writeFileSync(path.join(home, "base", "a.txt"), "base write\n");
    const copied = inode(path.join(home, "tree", "real", "a.txt"));

    take(root, { prior: first.state });

    expect(fs.readFileSync(path.join(home, "base", "a.txt"), "utf8")).toBe("alpha\n");
    expect(inode(path.join(home, "tree", "real", "a.txt"))).toBe(copied);
  });

  it("removes a target directory replaced by a link without touching the link's referent", () => {
    const { root, target } = project("mirror-replaced-dir-");
    const first = mirror(root, target, undefined);
    const outside = fs.realpathSync(createDirectory("mirror-outside-"));
    fs.writeFileSync(path.join(outside, "b.txt"), "outside\n");
    fs.rmSync(path.join(target, "src"), { recursive: true });
    fs.symlinkSync(outside, path.join(target, "src"), "junction");

    mirror(root, target, first);

    expect(fs.readdirSync(outside)).toEqual(["b.txt"]);
    expect(fs.readFileSync(path.join(outside, "b.txt"), "utf8")).toBe("outside\n");
    expect(fs.lstatSync(path.join(target, "src")).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(target, "src", "deep", "c.txt"), "utf8")).toBe("charlie\n");
  });

  it("clones every file of a real directory created again with the same names and bytes", () => {
    const { root, target } = project("mirror-recreated-");
    const first = mirror(root, target, undefined);
    fs.rmSync(path.join(root, "src"), { recursive: true });
    fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "b.txt"), "bravo\n");
    fs.writeFileSync(path.join(root, "src", "deep", "c.txt"), "charlie\n");
    fs.symlinkSync("../a.txt", path.join(root, "src", "alias"));

    const tally = { recloned: 0, removed: 0 };
    const second = mirror(root, target, first, { tally });

    for (const file of [path.join("src", "b.txt"), path.join("src", "deep", "c.txt")]) {
      expect(sameObservedState(observeFileState(path.join(root, file)), second.files.get(file)!.source)).toBe(true);
    }
    expect(tally).toEqual({ recloned: 2, removed: 2 });
  });

  it("replaces a file that became a directory, a directory that became a file, and a retargeted link", () => {
    const { root, target } = project("mirror-swap-");
    const first = mirror(root, target, undefined);
    fs.rmSync(path.join(root, "a.txt"));
    fs.mkdirSync(path.join(root, "a.txt"));
    fs.writeFileSync(path.join(root, "a.txt", "inner"), "inner\n");
    fs.rmSync(path.join(root, "src", "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "deep"), "flat\n");
    fs.rmSync(path.join(root, "alias"));
    fs.symlinkSync(path.join("src", "b.txt"), path.join(root, "alias"));

    const second = mirror(root, target, first);

    expect(fs.readFileSync(path.join(target, "a.txt", "inner"), "utf8")).toBe("inner\n");
    expect(fs.readFileSync(path.join(target, "src", "deep"), "utf8")).toBe("flat\n");
    expect(fs.readlinkSync(path.join(target, "alias"))).toBe(path.join("src", "b.txt"));
    expect([...second.files.keys()].sort()).toEqual([path.join("a.txt", "inner"), path.join("src", "b.txt"), path.join("src", "deep")].sort());
  });

  it.each(["none", "mount-namespace"] as const)("shares a path that became wholly ignored and clones one that stopped being ignored, under guard %s", guard => {
    const { root } = project("mirror-ignored-");
    const home = path.join(path.dirname(root), "home");
    const copied = path.join(home, "tree", "real", "src", "deep");
    const first = take(root, { guard });

    const ignored = take(root, { guard, whollyIgnored: [path.join("src", "deep")], prior: first.state });

    if (guard === "none") expect(fs.realpathSync(copied)).toBe(path.join(root, "src", "deep"));
    else expect(fs.readdirSync(copied)).toEqual([]);
    expect(fs.lstatSync(copied).isSymbolicLink()).toBe(guard === "none");
    expect(fs.existsSync(path.join(home, "base", "src", "deep"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "src", "deep", "c.txt"), "utf8")).toBe("charlie\n");

    take(root, { guard, prior: ignored.state });

    expect(fs.lstatSync(copied).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(copied, "c.txt"), "utf8")).toBe("charlie\n");
    expect(fs.readFileSync(path.join(home, "base", "src", "deep", "c.txt"), "utf8")).toBe("charlie\n");
    expect(fs.readFileSync(path.join(root, "src", "deep", "c.txt"), "utf8")).toBe("charlie\n");
  });

  it("records a file's state from before a concurrent write that lands between its observation and its clone", () => {
    const { root, target } = project("mirror-concurrent-");
    const real = path.join(root, "a.txt");
    const first = mirror(root, target, undefined);
    fs.writeFileSync(real, "changed\n");

    const second = mirror(root, target, first, {
      clone: (source, destination, kind) => {
        if (source === real) fs.writeFileSync(real, "concurrent\n");
        cloneEntry(source, destination, kind);
      },
    });

    expect(sameObservedState(observeFileState(real), second.files.get("a.txt")!.source)).toBe(false);
  });

  it("never reads or removes through a directory that became a link while it was cloned, and mirrors it again from the source", () => {
    const { root, target } = project("mirror-kind-race-");
    const outside = fs.realpathSync(createDirectory("mirror-kind-outside-"));
    fs.writeFileSync(path.join(outside, "sentinel"), "outside\n");
    const src = path.join(root, "src");

    const first = mirror(root, target, undefined, {
      clone: (source, destination, kind) => {
        if (source !== src) return cloneEntry(source, destination, kind);
        fs.rmSync(src, { recursive: true });
        fs.symlinkSync(outside, src, "junction");
        cloneEntry(source, destination, kind);
        fs.rmSync(src);
        fs.mkdirSync(src);
      },
    });
    mirror(root, target, first);

    expect(fs.readFileSync(path.join(outside, "sentinel"), "utf8")).toBe("outside\n");
    expect(fs.lstatSync(path.join(target, "src")).isDirectory()).toBe(true);
    expect(fs.readdirSync(path.join(target, "src"))).toEqual([]);
  });

  it("replaces a link that was retargeted while its directory was cloned and then restored", () => {
    const { root, target } = project("mirror-link-race-");
    const link = path.join(root, "src", "alias");

    const first = mirror(root, target, undefined, {
      clone: (source, destination, kind) => {
        if (kind === "directory") {
          fs.rmSync(link);
          fs.symlinkSync("b.txt", link);
        }
        cloneEntry(source, destination, kind);
        if (kind === "directory") {
          fs.rmSync(link);
          fs.symlinkSync("../a.txt", link);
        }
      },
    });
    mirror(root, target, first);

    expect(fs.readlinkSync(path.join(target, "src", "alias"))).toBe(fs.readlinkSync(link));
    expect(fs.readFileSync(path.join(target, "src", "alias"), "utf8")).toBe("alpha\n");
  });

  it("never records a skipped file as current when a concurrent writer changed it during the mirror", () => {
    const { root, target } = project("mirror-concurrent-skip-");
    fs.writeFileSync(path.join(root, "0.txt"), "zero\n");
    fs.writeFileSync(path.join(root, "z.txt"), "zulu\n");
    const first = mirror(root, target, undefined);
    fs.writeFileSync(path.join(root, "src", "b.txt"), "drifted\n");
    let clones = 0;

    const second = mirror(root, target, first, {
      clone: (source, destination, kind) => {
        clones++;
        for (const name of ["0.txt", "a.txt", "z.txt"]) fs.writeFileSync(path.join(root, name), `${name} concurrent\n`);
        cloneEntry(source, destination, kind);
      },
    });

    for (const [file, recorded] of second.files) {
      const current = observeFileState(path.join(root, file));
      const sameBytes = fs.readFileSync(path.join(target, file)).equals(fs.readFileSync(path.join(root, file)));
      expect(sameObservedState(current, recorded.source) ? sameBytes : true).toBe(true);
    }
    expect(clones).toBeGreaterThan(0);
  });

  it("leaves exactly the new spelling after a case-only rename on a case-insensitive volume", () => {
    const { root, target } = project("mirror-case-");
    if (!fs.existsSync(path.join(root, "A.TXT"))) return;
    fs.writeFileSync(path.join(root, "Foo.txt"), "foo\n");
    const first = mirror(root, target, undefined);
    fs.renameSync(path.join(root, "Foo.txt"), path.join(root, "foo.txt"));

    mirror(root, target, first);

    expect(fs.readdirSync(target).filter(name => name.toLowerCase() === "foo.txt")).toEqual(["foo.txt"]);
  });

  it.skipIf(process.platform === "win32")("restores a copy directory's permission bits before it removes a leftover inside it", () => {
    const { root, target } = project("mirror-permissions-");
    const first = mirror(root, target, undefined);
    fs.writeFileSync(path.join(target, "src", "left.txt"), "leftover\n");
    fs.chmodSync(path.join(target, "src"), 0o500);

    mirror(root, target, first);

    expect(fs.statSync(path.join(target, "src")).mode & 0o777).toBe(fs.statSync(path.join(root, "src")).mode & 0o777);
    expect(fs.existsSync(path.join(target, "src", "left.txt"))).toBe(false);
  });

  it("clones only the changed session file into the before image, and the new snapshot observes no change", () => {
    const root = fs.realpathSync(createDirectory("mirror-session-"));
    const scratchDir = path.join(root, ".flywheel", "sessions", "own", "scratch");
    const home = path.join(scratchDir, "mutations", "one");
    fs.mkdirSync(path.join(scratchDir, "notes"), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(scratchDir, "a.md"), "alpha\n");
    fs.writeFileSync(path.join(scratchDir, "notes", "b.md"), "bravo\n");
    fs.writeFileSync(path.join(scratchDir, "..", "top.md"), "top\n");
    const image = path.join(home, "session-before");
    const first = snapshotSessionFolder(home)!;
    const before = entryStamps(image);
    fs.writeFileSync(path.join(scratchDir, "a.md"), "ALPHA, longer\n");

    const second = snapshotSessionFolder(home, first.state)!;

    const after = entryStamps(image);
    const changed = [...after].filter(([entry, stamp]) => before.get(entry) !== stamp && fs.lstatSync(path.join(image, entry)).isFile()).map(([entry]) => entry);
    expect(changed).toEqual([path.join("scratch", "a.md")]);
    expect(fs.readFileSync(path.join(image, "scratch", "a.md"), "utf8")).toBe("ALPHA, longer\n");
    expect(scanSessionChanges(home, root, second.snapshot)).toEqual({ kind: "observed", changes: [], removedDirectories: [] });
  });
});
