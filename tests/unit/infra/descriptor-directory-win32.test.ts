import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWin32ContainedDirectoryBackend,
  win32ContainedDirectoryBackend,
} from "../../../src/infra/descriptor-directory-win32.js";
import { ContainedPathError, type ContainedDirectoryBackend, type ContainedDirectoryContract } from "../../../src/infra/descriptor-directory-contract.js";
import type { NativeWindowsDirectory } from "../../../src/infra/descriptor-directory-win32-native.js";
import { pathError } from "../../../src/infra/descriptor-directory-win32-path.js";

let workspace: string;
let base: string;
let outside: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "flywheel win32 descriptor-"));
  base = join(workspace, "root with spaces");
  outside = join(workspace, "outside");
  mkdirSync(base);
  mkdirSync(outside);
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** The path-held Windows backend on any host, with the pointer rename it
 *  publishes a link through. */
function pathBackend(renamePointer?: (pendingPath: string, targetPath: string) => void): ContainedDirectoryBackend {
  return createWin32ContainedDirectoryBackend({ retainedAuthority: false, applyPrivateDirectoryAcl: () => {}, ...(renamePointer === undefined ? {} : { renamePointer }) });
}

function withDirectory<T>(backend: ContainedDirectoryBackend, use: (directory: ContainedDirectoryContract) => T): T {
  const directory = backend.open(base, [], {});
  try {
    return use(directory);
  } finally {
    directory.close();
  }
}

describe("Windows contained path validation", () => {
  it("protects an existing private root before admission and refuses ACL failures without changing its contents", () => {
    mkdirSync(join(base, "private"));
    writeFileSync(join(base, "private", "kept"), "preserved");
    const admissions: string[] = [];
    let refuse = false;
    const backend = createWin32ContainedDirectoryBackend({
      retainedAuthority: false,
      applyPrivateDirectoryAcl: (directory) => {
        admissions.push(directory);
        if (refuse) throw new Error("ACL denied");
      },
    });
    backend.open(base, ["private"], { privateDirectories: true }).close();
    refuse = true;
    expect(() => backend.open(base, ["private"], { privateDirectories: true })).toThrow("ACL denied");
    expect(admissions).toEqual([realpathSync(join(base, "private")), realpathSync(join(base, "private"))]);
    expect(readFileSync(join(base, "private", "kept"), "utf8")).toBe("preserved");
  });

  it("preserves the code and cause of operational path failures", () => {
    const cause = Object.assign(new Error("inspection denied"), { code: "EACCES" });
    const error = pathError("cannot inspect child", cause);
    expect(error).toBeInstanceOf(ContainedPathError);
    expect(error).toMatchObject({ code: "EACCES" });
    expect(error.cause).toBe(cause);
    expect(pathError("no cause")).not.toHaveProperty("code");
  });

  it("classifies symlink and non-directory children without treating them as missing", () => {
    symlinkSync(outside, join(base, "linked"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(base, "file"), "not a directory");
    withDirectory(pathBackend(), (directory) => {
      for (const method of ["openChild", "openExistingChild"] as const) {
        for (const [name, code] of [["linked", "ELOOP"], ["file", "ENOTDIR"]] as const) {
          expect(() => directory[method](name)).toThrow(ContainedPathError);
          try {
            directory[method](name);
          } catch (error) {
            expect(error).toMatchObject({ code });
          }
        }
      }
      expect(directory.openExistingChild("missing")).toBeUndefined();
    });
  });

  it("rejects separators, drive syntax, absolute names, and ADS names", () => {
    const backend = pathBackend();
    for (const name of ["folder\\name", "folder/name", "C:stream", "C:\\file", "/absolute", "\\absolute", "file:stream"]) {
      expect(() => withDirectory(backend, (directory) => directory.writeFile(name, "nope"))).toThrow();
    }
    expect(readdirSync(base)).toEqual([]);
  });

  it("holds a resolved directory under a path containing spaces", () => {
    const backend = pathBackend();
    const directory = backend.open(base, ["one", "two"], { privateDirectories: true });
    try {
      expect(directory.writeFile("note.txt", "held")).toBeUndefined();
      expect(directory.readFile("note.txt", 16)?.toString("utf8")).toBe("held");
    } finally {
      directory.close();
    }
    expect(readFileSync(join(base, "one", "two", "note.txt"), "utf8")).toBe("held");
  });

  it("does not follow a reparse point while opening a child on Windows", () => {
    if (process.platform !== "win32") return;
    symlinkSync(outside, join(base, "linked"), "junction");
    const backend = win32ContainedDirectoryBackend;
    expect(() => withDirectory(backend, (directory) => directory.openChild("linked"))).toThrow(ContainedPathError);
    expect(() => withDirectory(backend, (directory) => directory.openExistingChild("linked"))).toThrow(ContainedPathError);
  });
});

describe("Windows link publication", () => {
  it("is a pointer file whose text is the relative target in Windows separators, which opens the directory it names", () => {
    mkdirSync(join(base, "versions", "0.0.10", "build"), { recursive: true });
    writeFileSync(join(base, "versions", "0.0.10", "build", "build.json"), "{}");
    const backend = pathBackend();
    withDirectory(backend, (directory) => directory.publishLink(".pending", "current", "versions/0.0.10/build"));

    expect(readFileSync(join(base, "current"), "utf8")).toBe("versions\\0.0.10\\build");
    const linked = withDirectory(backend, (directory) => directory.openLinkedChild("current"));
    try {
      expect(linked?.canonicalPath()).toBe(realpathSync(join(base, "versions", "0.0.10", "build")));
      expect(linked?.readFile("build.json", 16)?.toString("utf8")).toBe("{}");
    } finally {
      linked?.close();
    }
    expect(new Set(readdirSync(base))).toEqual(new Set(["current", "versions"]));
  });

  it("reads either separator and trailing white space, as the launcher reads them, and names nothing for a target that is not there", () => {
    mkdirSync(join(base, "build"));
    writeFileSync(join(base, "current"), "build\r\n");
    const backend = pathBackend();
    const linked = withDirectory(backend, (directory) => directory.openLinkedChild("current"));
    linked?.close();
    expect(linked).toBeDefined();

    writeFileSync(join(base, "current"), "missing");
    expect(withDirectory(backend, (directory) => directory.openLinkedChild("current"))).toBeUndefined();
    expect(withDirectory(backend, (directory) => directory.openLinkedChild("absent"))).toBeUndefined();
  });

  it("rejects absolute, traversing, and Windows-form link targets, written or read", () => {
    const backend = pathBackend();
    for (const target of ["", "/absolute", "C:\\outside", "../outside", "build/../outside", "build\\outside", "build:stream"]) {
      expect(() => withDirectory(backend, (directory) => directory.publishLink(".pending", "current", target))).toThrow();
    }
    expect(readdirSync(base)).toEqual([]);
    for (const text of ["..\\outside", "C:\\outside", "\\\\server\\share"]) {
      writeFileSync(join(base, "current"), text);
      expect(() => withDirectory(backend, (directory) => directory.openLinkedChild("current"))).toThrow();
    }
  });

  it("replaces the pointer only through its bounded rename, and leaves it whole when that rename fails", () => {
    mkdirSync(join(base, "first"));
    mkdirSync(join(base, "second"));
    withDirectory(pathBackend(), (directory) => directory.publishLink(".pending", "current", "first"));
    const refusing = pathBackend(() => { throw Object.assign(new Error("held by a reader"), { code: "EPERM" }); });

    expect(() => withDirectory(refusing, (directory) => directory.publishLink(".pending", "current", "second"))).toThrow("held by a reader");
    expect(readFileSync(join(base, "current"), "utf8")).toBe("first");
    expect(new Set(readdirSync(base))).toEqual(new Set(["current", "first", "second"]));
  });

  it("refuses to publish over a directory at the link's name", () => {
    mkdirSync(join(base, "build"));
    mkdirSync(join(base, "current"));
    expect(() => withDirectory(pathBackend(), (directory) => directory.publishLink(".pending", "current", "build"))).toThrow(ContainedPathError);
    expect(new Set(readdirSync(base))).toEqual(new Set(["current", "build"]));
  });

  it("refuses a junction at the link's name instead of following it on Windows", () => {
    if (process.platform !== "win32") return;
    symlinkSync(outside, join(base, "current"), "junction");
    expect(() => withDirectory(win32ContainedDirectoryBackend, (directory) => directory.openLinkedChild("current"))).toThrow(ContainedPathError);
    expect(() => withDirectory(win32ContainedDirectoryBackend, (directory) => directory.publishLink(".pending", "current", "outside"))).toThrow(ContainedPathError);
  });

  it("does not delete a link target when the rename source is absent", () => {
    mkdirSync(join(base, "build"));
    const backend = pathBackend();
    withDirectory(backend, (directory) => directory.publishLink(".pending", "current", "build"));

    const source = backend.open(base, [], {});
    const target = backend.open(base, [], {});
    try {
      expect(() => source.renameInto("missing", target, "current")).toThrow();
      const linked = target.openLinkedChild("current");
      expect(linked).toBeDefined();
      linked?.close();
    } finally {
      source.close();
      target.close();
    }
  });
});

describe("Windows contained directory operations", () => {
  it("creates exclusive files, hard links them, and reports identity metadata", () => {
    const backend = pathBackend();
    withDirectory(backend, (directory) => {
      expect(directory.createExclusive("claim", "owned")).toBe(true);
      expect(directory.createExclusive("claim", "rejected")).toBe(false);
      expect(directory.linkFile("claim", "alias")).toBe(true);
      expect(directory.linkFile("claim", "alias")).toBe(false);
      expect(directory.readOwnedFile("claim", 64)).toMatchObject({ content: Buffer.from("owned"), linkCount: 2 });
      expect(directory.hasEntry("claim")).toBe(true);
      expect(directory.hasEntry("absent")).toBe(false);
      expect(directory.regularFileModifiedAt("claim")).toBe(lstatSync(join(base, "claim")).mtimeMs);
      expect(directory.regularFileEntries()).toEqual(expect.arrayContaining([{
        name: "claim",
        createdAt: lstatSync(join(base, "claim")).birthtimeMs,
        updatedAt: lstatSync(join(base, "claim")).mtimeMs,
      }]));
      expect(directory.admitPrivateFile("claim")).toBe(true);
      directory.syncFile("claim");
      for (const code of ["ENOENT", "EPERM"]) {
        directory.createExclusive("sidecar", "temporary");
        const failure = Object.assign(new Error("sidecar removed during admission"), { code });
        const chmod = spyOn(fs, "chmodSync").mockImplementation(() => {
          directory.removeFile("sidecar");
          throw failure;
        });
        try {
          expect(directory.admitPrivateFile("sidecar")).toBe(false);
        } finally {
          chmod.mockRestore();
        }
      }
      const denial = Object.assign(new Error("permission denied"), { code: "EPERM" });
      const chmod = spyOn(fs, "chmodSync").mockImplementation(() => { throw denial; });
      try {
        expect(() => directory.admitPrivateFile("claim")).toThrow(denial);
      } finally {
        chmod.mockRestore();
      }
    });
  });

  it("bounds stream writes and removes partial output", async () => {
    const backend = pathBackend();
    async function* bytes(): AsyncIterable<Uint8Array> {
      yield new TextEncoder().encode("head");
      yield new TextEncoder().encode("tail");
    }
    const directory = backend.open(base, [], {});
    try {
      await expect(directory.writeStreamExclusive("asset", bytes(), { maxBytes: 16 })).resolves.toBe(8);
      expect(readFileSync(join(base, "asset"), "utf8")).toBe("headtail");
    } finally {
      directory.close();
    }

    const limited = backend.open(base, [], {});
    try {
      await expect(limited.writeStreamExclusive("too-large", bytes(), { maxBytes: 4 })).rejects.toThrow("4-byte");
    } finally {
      limited.close();
    }
    expect(readdirSync(base)).toEqual(["asset"]);
  });

  it("enumerates, renames, and removes trees without following links", () => {
    const backend = pathBackend();
    mkdirSync(join(base, "child"));
    writeFileSync(join(base, "note.md"), "kept");
    const source = backend.open(base, ["child"], {});
    const target = backend.open(base, [], {});
    try {
      expect(source.entryNames()).toEqual([]);
      source.writeFile("moved", "new");
      source.renameInto("moved", target, "renamed");
      expect(target.readFile("renamed", 16)?.toString("utf8")).toBe("new");
      expect(target.directoryEntryNames()).toEqual(["child"]);
      target.removeFile("renamed");
      target.removeTree("child");
      expect(target.removeEmptyChild("absent")).toBe(true);
    } finally {
      source.close();
      target.close();
    }
    expect(readdirSync(base)).toEqual(["note.md"]);
  });

  it("removes a junction as a reparse point instead of its target on Windows", () => {
    if (process.platform !== "win32") return;
    writeFileSync(join(outside, "evidence.txt"), "safe");
    symlinkSync(outside, join(base, "linked"), "junction");
    withDirectory(win32ContainedDirectoryBackend, (directory) => {
      directory.removeTree("linked");
    });
    expect(readFileSync(join(outside, "evidence.txt"), "utf8")).toBe("safe");
    expect(readdirSync(base)).toEqual([]);
  });

  it("checks held directory identity after its name moves", () => {
    const backend = pathBackend();
    const heldPath = join(base, "held");
    mkdirSync(heldPath);
    const held = backend.open(base, ["held"], {});
    try {
      held.requireSamePathAs(heldPath);
      renameSync(heldPath, join(base, "moved"));
      mkdirSync(heldPath);
      expect(() => held.requireSamePathAs(heldPath)).toThrow(ContainedPathError);
    } finally {
      held.close();
    }
  });
});

describe("Windows native retained child creation", () => {
  it("reads, enumerates, and renames through retained native directories instead of reopening lexical paths", () => {
    const renames: { name: string; target: NativeWindowsDirectory; targetName: string }[] = [];
    const native: NativeWindowsDirectory = {
      openChild: () => undefined,
      identity: () => "native-directory",
      entries: () => [
        { name: "claim", kind: "file", createdAt: 100, updatedAt: 200 },
        { name: "child", kind: "directory", createdAt: 300, updatedAt: 400 },
        { name: "junction", kind: "reparse", createdAt: 500, updatedAt: 600 },
      ],
      readFileSnapshot: () => ({ content: Buffer.from("native"), identity: "file", linkCount: 1, dacl: Buffer.from("acl") }),
      publishFileBytes: () => ({ status: "published" }),
      deleteFile: () => ({ status: "published" }),
      renameInto: (name, target, targetName) => { renames.push({ name, target, targetName }); },
      close: () => {},
    };
    const backend = createWin32ContainedDirectoryBackend({
      retainedAuthority: true,
      openNativeDirectory: () => native,
    });
    const directory = backend.open(base, [], {});
    const target = backend.open(outside, [], {});
    const nonNative = pathBackend().open(base, [], {});
    try {
      renameSync(base, join(workspace, "moved"));
      symlinkSync(outside, base, process.platform === "win32" ? "junction" : "dir");
      writeFileSync(join(outside, "foreign"), "not admitted");
      expect(directory.entryNames()).toEqual(["claim", "child", "junction"]);
      expect(directory.directoryEntryNames()).toEqual(["child"]);
      expect(directory.regularFileEntries()).toEqual([{ name: "claim", createdAt: 100, updatedAt: 200 }]);
      expect(directory.readOwnedFile("claim", 64)).toEqual({ content: Buffer.from("native"), linkCount: 1, executable: false });
      directory.renameInto("claim", target, "moved");
      expect(renames).toEqual([{ name: "claim", target: native, targetName: "moved" }]);
      expect(() => directory.renameInto("../claim", target, "moved")).toThrow();
      expect(() => directory.renameInto("claim", target, "../moved")).toThrow();
      expect(() => directory.renameInto("claim", nonNative, "moved")).toThrow("same authority backend");
      expect(() => nonNative.renameInto("claim", directory, "moved")).toThrow("same authority backend");
      target.close();
      expect(() => directory.renameInto("claim", target, "moved")).toThrow("closed");
      expect(renames).toHaveLength(1);
    } finally {
      nonNative.close();
      target.close();
      directory.close();
    }
    expect(() => directory.entryNames()).toThrow("closed");
    expect(() => directory.directoryEntryNames()).toThrow("closed");
    expect(() => directory.regularFileEntries()).toThrow("closed");
  });

  it("uses native create-or-open without path-based creation", () => {
    const calls: string[] = [];
    const native: NativeWindowsDirectory = {
      openChild(name, create) {
        calls.push(`${name}:${create}`);
        return this;
      },
      identity: () => "native-directory",
      entries: () => [],
      readFileSnapshot: () => undefined,
      publishFileBytes: () => ({ status: "published" }),
      deleteFile: () => ({ status: "published" }),
      renameInto: () => {},
      close: () => {},
    };
    const backend = createWin32ContainedDirectoryBackend({
      retainedAuthority: true,
      openNativeDirectory: () => native,
    });
    const directory = backend.open(base, [], {});
    const child = directory.openChild("native-child");
    try {
      expect(calls).toEqual(["native-child:true"]);
      expect(() => lstatSync(join(base, "native-child"))).toThrow();
      expect(child.identity()).toBe("native-directory");
    } finally {
      child.close();
      directory.close();
    }
  });

  it("checks held identity through the native authority", () => {
    const identities = new Map<string, string>([[base, "base-identity"], [outside, "outside-identity"]]);
    const backend = createWin32ContainedDirectoryBackend({
      retainedAuthority: true,
      openNativeDirectory: (baseDir) => {
        const identity = identities.get(baseDir);
        if (identity === undefined) throw new Error(`no directory at ${baseDir}`);
        return {
          openChild: () => undefined,
          identity: () => identity,
          entries: () => [],
          readFileSnapshot: () => undefined,
          publishFileBytes: () => ({ status: "published" }),
          deleteFile: () => ({ status: "published" }),
          renameInto: () => {},
          close: () => {},
        };
      },
    });
    const directory = backend.open(base, [], {});
    try {
      directory.requireSamePathAs(base);
      expect(() => directory.requireSamePathAs(outside)).toThrow(ContainedPathError);
      expect(() => directory.requireSamePathAs(join(workspace, "missing"))).toThrow(ContainedPathError);
    } finally {
      directory.close();
    }
  });
});
