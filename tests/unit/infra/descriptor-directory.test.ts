/** Three properties of the held-descriptor boundary that no caller can restate
 *  safely: removing one directory because it is empty, publishing the link a
 *  launch resolves, and the base a walk starts at.
 *
 *  "Remove it because it is empty" is one operation here, not an emptiness check
 *  a caller then acts on: between such a check and a recursive deletion,
 *  whatever arrived in the directory would be deleted with it. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { POSIX_FILE_MODES } from "../../helpers/posix-modes.js";
import { canObserveSqliteLocks, sqliteLocksSeenByOtherProcesses } from "../../helpers/sqlite-locks.js";
import { chmodSync, chownSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import { ContainedDirectory, ContainedPathError, withContainedDirectory } from "../../../src/infra/descriptor-directory.js";
import { openAt } from "../../../src/infra/open-at.js";

let base: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "flywheel-descriptor-"));
  outside = mkdtempSync(join(tmpdir(), "flywheel-descriptor-outside-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function withBase<T>(use: (directory: ContainedDirectory) => T): T {
  const directory = ContainedDirectory.open(base, []);
  try {
    return use(directory);
  } finally {
    directory.close();
  }
}

// Descriptor-relative calls are the POSIX surface this covers: NO_LIBC_REASON in
// src/infra/libc.ts states that Windows exposes none, and the Windows backend
// uses a different mechanism with its own coverage. An errno, a syscall name, or
// a walk stage has no Windows counterpart to assert.
const DESCRIPTOR_RELATIVE = process.platform !== "win32";

describe("removing one empty child", () => {
  it("removes an emptied directory and reports an absent one as gone", () => {
    mkdirSync(join(base, "emptied"));

    expect(withBase((directory) => directory.removeEmptyChild("emptied"))).toBe(true);
    expect(withBase((directory) => directory.removeEmptyChild("emptied"))).toBe(true);
    expect(readdirSync(base)).toEqual([]);
  });

  it("keeps a directory that still holds an entry, and reports that it is still there", () => {
    mkdirSync(join(base, "occupied"));
    writeFileSync(join(base, "occupied", "note.md"), "kept");

    expect(withBase((directory) => directory.removeEmptyChild("occupied"))).toBe(false);
    expect(readFileSync(join(base, "occupied", "note.md"), "utf8")).toBe("kept");
  });

  it("refuses a name that is a symlink to a directory, and removes nothing through it", () => {
    writeFileSync(join(outside, "evidence.txt"), "not ours");
    symlinkSync(outside, join(base, "linked"));

    expect(() => withBase((directory) => directory.removeEmptyChild("linked"))).toThrow(ContainedPathError);
    expect(readFileSync(join(outside, "evidence.txt"), "utf8")).toBe("not ours");
    expect(readdirSync(base)).toEqual(["linked"]);
  });

  it("refuses a name that is a regular file", () => {
    writeFileSync(join(base, "note.md"), "kept");

    expect(() => withBase((directory) => directory.removeEmptyChild("note.md"))).toThrow(ContainedPathError);
    expect(readFileSync(join(base, "note.md"), "utf8")).toBe("kept");
  });
});

describe.skipIf(!DESCRIPTOR_RELATIVE)("descriptor failure diagnostics", () => {
  it("records the immediate errno, operation, and flags for a failed openat", () => {
    const baseFd = openSync(base, constants.O_RDONLY | constants.O_DIRECTORY);
    const flags = constants.O_RDONLY | constants.O_DIRECTORY;
    try {
      try {
        openAt(baseFd, "absent", flags);
        throw new Error("expected openAt to fail");
      } catch (error) {
        expect(error).toMatchObject({
          code: "ENOENT",
          errno: osConstants.errno.ENOENT,
          operation: "openat",
          flags,
        });
      }
    } finally {
      closeSync(baseFd);
    }
  });

  it("identifies the directory-walk stage without disclosing the path", () => {
    symlinkSync(outside, join(base, "linked"));

    expect(() => ContainedDirectory.open(base, ["linked"])).toThrow("stage=open-child-initial");
  });
});

describe("the base a walk starts at", () => {
  it("follows a link at its own final component when the caller does not own that component", () => {
    mkdirSync(join(outside, "store"));
    const link = join(base, "linked-root");
    symlinkSync(outside, link);

    const directory = ContainedDirectory.open(link, ["store"]);
    try {
      directory.writeFile("note.md", "installed");
    } finally {
      directory.close();
    }

    expect(readFileSync(join(outside, "store", "note.md"), "utf8")).toBe("installed");
  });

  it("refuses a link at its own final component when the caller owns it", () => {
    mkdirSync(join(outside, "store"));
    const link = join(base, "linked-root");
    symlinkSync(outside, link);

    expect(() => ContainedDirectory.open(link, ["store"], { noFollowBase: true })).toThrow();
    expect(() => ContainedDirectory.openExisting(link, ["store"], { noFollowBase: true })).toThrow(ContainedPathError);
    expect(readdirSync(join(outside, "store"))).toEqual([]);
  });
});

describe("publishing the link a launch resolves", () => {
  it("publishes a relative link, and replaces it without following the old target", () => {
    mkdirSync(join(base, "first"));
    mkdirSync(join(base, "second"));
    const resolved = (): string | undefined => withBase((directory) => {
      const linked = directory.openLinkedChild("current");
      try {
        return linked?.canonicalPath();
      } finally {
        linked?.close();
      }
    });

    // What both platforms agree on is where the link resolves to: a symlink
    // on POSIX, and on Windows the pointer file the launcher reads.
    withBase((directory) => { directory.publishLink(".pending", "current", "first"); });
    if (DESCRIPTOR_RELATIVE) expect(readlinkSync(join(base, "current"))).toBe("first");
    expect(resolved()).toBe(realpathSync(join(base, "first")));

    withBase((directory) => { directory.publishLink(".pending", "current", "second"); });
    if (DESCRIPTOR_RELATIVE) expect(readlinkSync(join(base, "current"))).toBe("second");
    expect(resolved()).toBe(realpathSync(join(base, "second")));
    expect(readdirSync(join(base, "first"))).toEqual([]);
    expect(readdirSync(base).includes(".pending")).toBe(false);
  });

  it("refuses an absolute link target", () => {
    expect(() => withBase((directory) => { directory.publishLink(".pending", "current", outside); })).toThrow();
    expect(readdirSync(base)).toEqual([]);
  });

  it("opens what its own link resolves to, and reports an absent link", () => {
    mkdirSync(join(base, "build"));
    writeFileSync(join(base, "build", "build.json"), "{}");
    withBase((directory) => { directory.publishLink(".pending", "current", "build"); });

    const found = withBase((directory) => {
      const linked = directory.openLinkedChild("current");
      try {
        return linked?.readFile("build.json", 64)?.toString("utf-8");
      } finally {
        linked?.close();
      }
    });
    expect(found).toBe("{}");
    expect(withBase((directory) => directory.openLinkedChild("absent"))).toBeUndefined();
  });

  it("publishes an executable file at the mode the caller names, and counts the names that reach it", () => {
    withBase((directory) => { directory.publishFileThrough(".pending", "flywheel", "#!/bin/sh\n", 0o755); });

    if (POSIX_FILE_MODES) expect(lstatSync(join(base, "flywheel")).mode & 0o777).toBe(0o755);
    const owned = withBase((directory) => directory.readOwnedFile("flywheel", 1024));
    expect(owned?.content.toString("utf-8")).toBe("#!/bin/sh\n");
    expect(owned?.linkCount).toBe(1);
  });

  it("publishes exact bytes only while the expected object remains installed and preserves safe mode bits", () => {
    writeFileSync(join(base, "note.bin"), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]), { mode: 0o6755 });

    withBase((directory) => {
      const before = directory.readFileSnapshot("note.bin", 64);
      expect(before?.content).toEqual(Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0d, 0x0a]));
      expect(before?.metadata.kind).toBe(process.platform === "win32" ? "win32" : "posix");
      directory.publishFileBytesThrough(".pending", "note.bin", Buffer.from([0, 1, 2, 3]), before);
    });

    expect(readFileSync(join(base, "note.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
    if (POSIX_FILE_MODES) expect(lstatSync(join(base, "note.bin")).mode & 0o7777).toBe(0o755);
  });

  it.skipIf(!DESCRIPTOR_RELATIVE)("uses destination evidence for comparison and source metadata for publication", () => {
    writeFileSync(join(base, "destination.txt"), "destination", { mode: 0o600 });
    writeFileSync(join(base, "source.txt"), "source", { mode: 0o755 });

    withBase((directory) => {
      const destination = directory.readFileSnapshot("destination.txt", 64);
      const source = directory.readFileSnapshot("source.txt", 64);
      expect(destination).toBeDefined();
      expect(source?.metadata.kind).toBe("posix");
      directory.publishFileBytesThrough(".pending", "destination.txt", Buffer.from("moved"), destination, source?.metadata);
    });

    expect(readFileSync(join(base, "destination.txt"), "utf8")).toBe("moved");
    if (POSIX_FILE_MODES) expect(lstatSync(join(base, "destination.txt")).mode & 0o777).toBe(0o755);
  });

  it("refuses same-identity byte and access changes", () => {
    writeFileSync(join(base, "note.md"), "before", { mode: 0o644 });

    withBase((directory) => {
      const before = directory.readFileSnapshot("note.md", 64);
      expect(before).toBeDefined();
      writeFileSync(join(base, "note.md"), "changed");
      expect(directory.publishFileBytesThrough(".pending-bytes", "note.md", Buffer.from("after"), before)).toMatchObject({ status: "not_applied", error: expect.any(ContainedPathError) });
      writeFileSync(join(base, "note.md"), "before");
      if (DESCRIPTOR_RELATIVE) {
        const mode = lstatSync(join(base, "note.md")).mode & 0o777;
        chmodSync(join(base, "note.md"), mode === 0o600 ? 0o644 : 0o600);
        expect(directory.publishFileBytesThrough(".pending-mode", "note.md", Buffer.from("after"), before)).toMatchObject({ status: "not_applied", error: expect.any(ContainedPathError) });
      }
    });

    expect(readFileSync(join(base, "note.md"), "utf8")).toBe("before");
  });

  it("deletes only a target that still matches its admitted snapshot", () => {
    writeFileSync(join(base, "note.md"), "before");

    withBase((directory) => {
      const before = directory.readFileSnapshot("note.md", 64);
      expect(before).toBeDefined();
      writeFileSync(join(base, "note.md"), "changed");
      expect(directory.removeFileIfSnapshot("note.md", before!)).toMatchObject({ status: "not_applied", error: expect.any(ContainedPathError) });
      expect(readFileSync(join(base, "note.md"), "utf8")).toBe("changed");
    });
  });

  it("refuses publication after the admitted object identity changes", () => {
    writeFileSync(join(base, "note.md"), "first");

    withBase((directory) => {
      const before = directory.readFileSnapshot("note.md", 64);
      expect(before).toBeDefined();
      renameSync(join(base, "note.md"), join(base, "old.md"));
      writeFileSync(join(base, "note.md"), "replacement");
      expect(directory.publishFileBytesThrough(".pending", "note.md", Buffer.from("changed"), before)).toMatchObject({ status: "not_applied", error: expect.any(Error) });
    });

    expect(readFileSync(join(base, "note.md"), "utf8")).toBe("replacement");
    expect(readdirSync(base).includes(".pending")).toBe(false);
  });
});

describe("filling one entry from a byte stream", () => {
  async function* bytes(...chunks: readonly string[]): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) yield new TextEncoder().encode(chunk);
  }

  // The held descriptor stays open until the write settles: the writer resolves
  // its own cleanup against it.
  async function withHeldBase<T>(use: (directory: ContainedDirectory) => Promise<T>): Promise<T> {
    const directory = ContainedDirectory.open(base, []);
    try {
      return await use(directory);
    } finally {
      directory.close();
    }
  }

  it("creates the entry owner-only, writes every chunk, and reports the byte count", async () => {
    const written = await withHeldBase((directory) => directory.writeStreamExclusive("asset.tar.gz", bytes("head", "tail"), { maxBytes: 64 }));

    expect(written).toBe(8);
    expect(readFileSync(join(base, "asset.tar.gz"), "utf8")).toBe("headtail");
    if (POSIX_FILE_MODES) expect(lstatSync(join(base, "asset.tar.gz")).mode & 0o777).toBe(0o600);
  });

  it("refuses a stream past its byte bound and leaves no entry behind", async () => {
    await expect(withHeldBase((directory) => directory.writeStreamExclusive("asset", bytes("12345", "67890"), { maxBytes: 8 })))
      .rejects.toThrow("8-byte");
    expect(readdirSync(base)).toEqual([]);
  });

  it("removes the entry it created when the source fails", async () => {
    async function* failing(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("partial");
      throw new Error("the connection dropped");
    }

    await expect(withHeldBase((directory) => directory.writeStreamExclusive("asset", failing(), { maxBytes: 64 })))
      .rejects.toThrow("the connection dropped");
    expect(readdirSync(base)).toEqual([]);
  });

  it("stops on an aborted signal and leaves no entry behind", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(withHeldBase((directory) => directory.writeStreamExclusive("asset", bytes("head"), { maxBytes: 64, signal: controller.signal })))
      .rejects.toThrow("cancelled");
    expect(readdirSync(base)).toEqual([]);
  });

  it("refuses a name that is already taken, and writes nothing over it", async () => {
    writeFileSync(join(base, "asset"), "kept");

    await expect(withHeldBase((directory) => directory.writeStreamExclusive("asset", bytes("new"), { maxBytes: 64 })))
      .rejects.toThrow();
    expect(readFileSync(join(base, "asset"), "utf8")).toBe("kept");
  });

  it("refuses a symlink at the name, and writes nothing through it", async () => {
    writeFileSync(join(outside, "evidence.txt"), "not ours");
    symlinkSync(join(outside, "evidence.txt"), join(base, "asset"));

    await expect(withHeldBase((directory) => directory.writeStreamExclusive("asset", bytes("planted"), { maxBytes: 64 })))
      .rejects.toThrow();
    expect(readFileSync(join(outside, "evidence.txt"), "utf8")).toBe("not ours");
  });
});

describe("contained directory public methods", () => {
  it("rejects names that are not one path component", () => {
    withBase((directory) => {
      for (const invalid of ["", ".", "..", "nested/name", "nul\0name"]) {
        expect(() => directory.writeFile(invalid, "content")).toThrow("one path component");
      }
    });
  });

  it("opens existing and new child directories without following links", () => {
    mkdirSync(join(base, "existing"));
    symlinkSync(outside, join(base, "linked"));

    const missing = ContainedDirectory.openExisting(base, ["absent"]);
    expect(missing).toBeUndefined();
    expect(readdirSync(base).sort()).toEqual(["existing", "linked"]);

    const child = withBase((directory) => directory.openChild("created", { privateDirectories: true }));
    try {
      if (POSIX_FILE_MODES) expect(lstatSync(join(base, "created")).mode & 0o777).toBe(0o700);
    } finally {
      child.close();
    }
    if (POSIX_FILE_MODES) {
      const privatePath = join(base, "created");
      const before = lstatSync(privatePath, { bigint: true });
      ContainedDirectory.openExisting(base, ["created"], { privateDirectories: true })?.close();
      withBase((directory) => directory.openChild("created", { privateDirectories: true })).close();
      expect(lstatSync(privatePath, { bigint: true }).ctimeNs).toBe(before.ctimeNs);
      // A new folder can take its parent's group, such as wheel under /tmp. chmod silently drops setgid for a
      // group that the process is not a member of, so give the folder the process's own group first.
      chownSync(privatePath, process.getuid!(), process.getgid!());
      for (const mode of [0o777, 0o2700]) {
        chmodSync(privatePath, mode);
        expect(lstatSync(privatePath).mode & 0o7777).toBe(mode);
        ContainedDirectory.openExisting(base, ["created"], { privateDirectories: true })?.close();
        expect(lstatSync(privatePath).mode & 0o7777).toBe(0o700);
      }
    }

    const existing = withBase((directory) => directory.openExistingChild("existing"));
    expect(existing).toBeDefined();
    existing?.close();
    expect(withBase((directory) => directory.openExistingChild("absent"))).toBeUndefined();
    expect(() => withBase((directory) => directory.openChild("linked"))).toThrow(ContainedPathError);
    expect(() => withBase((directory) => directory.openExistingChild("linked"))).toThrow(ContainedPathError);
  });

  it("reports entry names in filesystem order and separates directory entries", () => {
    mkdirSync(join(base, "child"));
    writeFileSync(join(base, "note.md"), "kept");
    symlinkSync(join(base, "note.md"), join(base, "link.md"));
    const names = readdirSync(base);

    withBase((directory) => {
      expect(directory.entryNames()).toEqual(names);
      expect(directory.directoryEntryNames()).toEqual(names.filter((name) => lstatSync(join(base, name)).isDirectory()));
      expect(directory.regularFileEntries()).toEqual([{
        name: "note.md",
        createdAt: lstatSync(join(base, "note.md")).birthtimeMs,
        updatedAt: lstatSync(join(base, "note.md")).mtimeMs,
      }]);
    });
  });

  it("creates an entry exactly once and reports the hard-link count it owns", () => {
    withBase((directory) => {
      expect(directory.createExclusive("claim", "owned")).toBe(true);
      expect(directory.createExclusive("claim", "rejected")).toBe(false);
      expect(directory.linkFile("claim", "alias")).toBe(true);
      expect(directory.linkFile("claim", "alias")).toBe(false);
      expect(directory.readFile("claim", 64)?.toString("utf8")).toBe("owned");
      expect(directory.readOwnedFile("claim", 64)).toMatchObject({ linkCount: 2 });
    });
    expect(readFileSync(join(base, "claim"), "utf8")).toBe("owned");
    if (POSIX_FILE_MODES) expect(lstatSync(join(base, "claim")).mode & 0o777).toBe(0o600);
  });

  it("bounds regular reads and classifies non-regular entries as containment failures", () => {
    writeFileSync(join(base, "note.md"), "0123456789");
    symlinkSync(join(base, "note.md"), join(base, "link.md"));

    withBase((directory) => {
      expect(directory.readFile("absent", 64)).toBeUndefined();
      expect(() => directory.readFile("note.md", 4)).toThrow("read limit");
      expect(() => directory.readOwnedFile("link.md", 64)).toThrow(ContainedPathError);
      expect(directory.hasEntry("note.md")).toBe(true);
      expect(directory.hasEntry("absent")).toBe(false);
      expect(() => directory.hasEntry("link.md")).toThrow(ContainedPathError);
    });
  });

  it("publishes through a rename and moves entries between held directories", () => {
    mkdirSync(join(base, "source"));
    mkdirSync(join(base, "target"));
    const source = ContainedDirectory.open(base, ["source"]);
    const target = ContainedDirectory.open(base, ["target"]);
    try {
      expect(source.publishFileThrough("pending", "published", "new")).toBeUndefined();
      source.renameInto("published", target, "moved");
      expect(target.readFile("moved", 64)?.toString("utf8")).toBe("new");
      expect(source.entryNames()).toEqual([]);
    } finally {
      source.close();
      target.close();
    }
  });

  it("removes files, trees, and links without touching link targets", () => {
    mkdirSync(join(base, "tree", "inner"), { recursive: true });
    writeFileSync(join(base, "tree", "inner", "note.md"), "gone");
    writeFileSync(join(outside, "evidence.txt"), "not ours");
    symlinkSync(outside, join(base, "tree", "linked"));
    writeFileSync(join(base, "file.md"), "gone");
    symlinkSync(outside, join(base, "link"));

    withBase((directory) => {
      directory.removeFile("file.md");
      directory.removeFile("absent");
      directory.removeFile("link");
      directory.removeTree("tree");
      directory.removeTree("tree");
    });

    expect(readdirSync(base)).toEqual([]);
    expect(readFileSync(join(outside, "evidence.txt"), "utf8")).toBe("not ours");
  });

  // A Go module cache, and other tool caches like it, make each extracted
  // directory read-only (0555) so that a build cannot change it.
  it.skipIf(!POSIX_FILE_MODES)("removes a tree whose directories are read-only", () => {
    const module = join(base, "tree", "gopath", "pkg", "mod", "example.com", "lib@v1.0.0");
    mkdirSync(join(module, "internal"), { recursive: true });
    writeFileSync(join(module, "lib.go"), "package lib");
    writeFileSync(join(module, "internal", "x.go"), "package internal");
    const readOnly = [join(module, "internal"), module, join(base, "tree", "gopath", "pkg", "mod", "example.com")];
    for (const directory of readOnly) chmodSync(directory, 0o555);

    try {
      withBase((directory) => { directory.removeTree("tree"); });
      expect(readdirSync(base)).toEqual([]);
    } finally {
      for (const directory of readOnly.toReversed()) {
        try { chmodSync(directory, 0o755); } catch { /* removed */ }
      }
    }
  });

  it("reports regular-file metadata, admits private files, and flushes them", () => {
    writeFileSync(join(base, "note.md"), "kept", { mode: 0o644 });

    withBase((directory) => {
      expect(directory.regularFileModifiedAt("note.md")).toBe(lstatSync(join(base, "note.md")).mtimeMs);
      expect(directory.admitPrivateFile("note.md")).toBe(true);
      expect(directory.admitPrivateFile("absent")).toBe(false);
      directory.syncFile("note.md");
    });

    if (POSIX_FILE_MODES) expect(lstatSync(join(base, "note.md")).mode & 0o777).toBe(0o600);
  });

  // Admission runs on SQLite databases that a connection of this process can
  // hold open. A close of any descriptor of a file releases every POSIX lock
  // this process holds on it, and the next process to open the database then
  // truncates the -shm under the connection's memory map.
  it.skipIf(!canObserveSqliteLocks)("admits an open database and its sidecars without releasing the connection's locks", () => {
    const dbFile = join(base, "store.sqlite");
    writeFileSync(dbFile, "", { mode: 0o600 });
    const db = new Database(dbFile);
    try {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("create table t (x)");
      withBase((directory) => {
        for (const name of ["store.sqlite", "store.sqlite-wal", "store.sqlite-shm"]) expect(directory.admitPrivateFile(name)).toBe(true);
      });
      expect(sqliteLocksSeenByOtherProcesses(dbFile)).toEqual({ database: true, sharedMemory: true });
    } finally {
      db.close();
    }
  });

  it("requires the held directory to retain its path identity", () => {
    const path = join(base, "held");
    mkdirSync(path);
    const held = ContainedDirectory.open(base, ["held"]);
    try {
      held.requireSamePathAs(path);
      renameSync(path, join(base, "moved"));
      mkdirSync(path);
      expect(() => held.requireSamePathAs(path)).toThrow(ContainedPathError);
    } finally {
      held.close();
    }
  });

  it("creates a held window and closes it after an asynchronous callback", async () => {
    const result = await withContainedDirectory(base, ["window"], {}, async (directory) => {
      directory.writeFile("note.md", "window");
      return directory.readFile("note.md", 64)?.toString("utf8");
    });

    expect(result).toBe("window");
    expect(readFileSync(join(base, "window", "note.md"), "utf8")).toBe("window");
  });
});
