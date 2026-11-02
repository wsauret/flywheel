/** The contained write boundary: every component below a trusted base is
 *  resolved relative to its parent's descriptor and never followed through a
 *  link, and a publication that cannot land leaves nothing behind. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { CONTAINMENT_REFUSAL } from "../../helpers/containment-refusal.js";
import { POSIX_FILE_MODES } from "../../helpers/posix-modes.js";
import { mkdirSync, mkdtempSync, lstatSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContainedPathError } from "../../../src/infra/descriptor-directory.js";
import {
  directoryComponents,
  ensureDirectoryUnder,
  readFileUnder,
  removeFileUnder,
  removeTreeUnder,
  requireContainedDirectory,
  writeFileUnder,
} from "../../../src/infra/write-file-under.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "flywheel-write-file-under-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Temporary entries this boundary writes before a publication lands. */
function temporaries(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith(".flywheel-write."));
}

describe("writeFileUnder", () => {
  it("publishes a file and creates its directories privately", () => {
    writeFileUnder(base, "nested/store/note.md", "kept", { privateDirectories: true });

    expect(readFileSync(join(base, "nested", "store", "note.md"), "utf8")).toBe("kept");
    expect(temporaries(join(base, "nested", "store"))).toEqual([]);
  });

  it("removes the temporary entry when the publication cannot land", () => {
    // A directory where the file belongs: the rename fails after the temporary
    // entry exists, which is the one window where a leftover could survive.
    mkdirSync(join(base, "occupied"));

    expect(() => writeFileUnder(base, "occupied", "never published")).toThrow(ContainedPathError);
    expect(temporaries(base)).toEqual([]);
  });

  it("refuses a directory component that is a symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "flywheel-write-outside-"));
    try {
      writeFileSync(join(outside, "note.md"), "outside secret");
      symlinkSync(outside, join(base, "linked"));

      expect(() => writeFileUnder(base, "linked/note.md", "overwritten")).toThrow(CONTAINMENT_REFUSAL);
      expect(readFileSync(join(outside, "note.md"), "utf8")).toBe("outside secret");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("readFileUnder", () => {
  it("returns undefined for an absent file and refuses one over its limit", () => {
    expect(readFileUnder(base, "absent/note.md", { maxBytes: 16 })).toBeUndefined();
    writeFileSync(join(base, "big.md"), "x".repeat(64));
    expect(() => readFileUnder(base, "big.md", { maxBytes: 16 })).toThrow("read limit");
  });

  it("refuses a file that is a symlink", () => {
    writeFileSync(join(base, "target.md"), "target bytes");
    symlinkSync(join(base, "target.md"), join(base, "link.md"));

    expect(() => readFileUnder(base, "link.md", { maxBytes: 1024 })).toThrow(CONTAINMENT_REFUSAL);
  });
});

describe("requireContainedDirectory", () => {
  it("admits an existing tree and an absent one, and creates nothing", () => {
    mkdirSync(join(base, "present", "store"), { recursive: true });

    expect(() => requireContainedDirectory(base, "present/store")).not.toThrow();
    expect(() => requireContainedDirectory(base, "absent/store")).not.toThrow();
    expect(readdirSync(base)).toEqual(["present"]);
  });

  it("refuses a tree reached through a symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "flywheel-require-outside-"));
    try {
      symlinkSync(outside, join(base, "linked"));

      expect(() => requireContainedDirectory(base, "linked")).toThrow(ContainedPathError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("removeTreeUnder", () => {
  it("removes a tree below the base and reports absence as success", () => {
    mkdirSync(join(base, "tree", "inner"), { recursive: true });
    writeFileSync(join(base, "tree", "inner", "note.md"), "gone");

    removeTreeUnder(base, "tree");
    removeTreeUnder(base, "tree");

    expect(readdirSync(base)).toEqual([]);
  });

  it("unlinks a symlink inside the tree instead of deleting what it points at", () => {
    const outside = mkdtempSync(join(tmpdir(), "flywheel-remove-outside-"));
    try {
      writeFileSync(join(outside, "note.md"), "outside secret");
      mkdirSync(join(base, "tree"), { recursive: true });
      symlinkSync(outside, join(base, "tree", "linked"));

      removeTreeUnder(base, "tree");

      expect(readdirSync(base)).toEqual([]);
      expect(readFileSync(join(outside, "note.md"), "utf8")).toBe("outside secret");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a tree whose own name is a symlink and deletes nothing through it", () => {
    const outside = mkdtempSync(join(tmpdir(), "flywheel-remove-outside-"));
    try {
      writeFileSync(join(outside, "note.md"), "outside secret");
      symlinkSync(outside, join(base, "linked"));

      // The link itself is this directory's entry, so it is unlinked where it
      // stands: what it points at is another tree and is left whole.
      removeTreeUnder(base, "linked");

      expect(readdirSync(base)).toEqual([]);
      expect(readFileSync(join(outside, "note.md"), "utf8")).toBe("outside secret");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses a directory component of the path that is a symlink", () => {
    const outside = mkdtempSync(join(tmpdir(), "flywheel-remove-outside-"));
    try {
      mkdirSync(join(outside, "tree"), { recursive: true });
      writeFileSync(join(outside, "tree", "note.md"), "outside secret");
      symlinkSync(outside, join(base, "linked"));

      expect(() => removeTreeUnder(base, "linked/tree")).toThrow(ContainedPathError);
      expect(readFileSync(join(outside, "tree", "note.md"), "utf8")).toBe("outside secret");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("relative path boundaries", () => {
  it("validates relative POSIX paths while preserving backslash components", () => {
    expect(directoryComponents(".")).toEqual([]);
    expect(directoryComponents("folder\\name")).toEqual(["folder\\name"]);

    for (const invalid of ["", "/absolute", "nested//store", "nested/./store", "nested/../store"]) {
      expect(() => directoryComponents(invalid)).toThrow();
    }
    expect(() => writeFileUnder(base, "folder\\name", "rejected")).toThrow("plain relative POSIX path");
  });

  it("creates private directory trees and publishes replacements", () => {
    ensureDirectoryUnder(base, "nested/store", { privateDirectories: true });
    if (POSIX_FILE_MODES) expect((lstatSync(join(base, "nested")).mode & 0o777)).toBe(0o700);
    if (POSIX_FILE_MODES) expect((lstatSync(join(base, "nested", "store")).mode & 0o777)).toBe(0o700);

    writeFileUnder(base, "nested/store/note.md", "first");
    writeFileUnder(base, "nested/store/note.md", "second");
    expect(readFileSync(join(base, "nested", "store", "note.md"), "utf8")).toBe("second");
  });
});

describe("one-shot file removal", () => {
  it("removes one file, treats absence as success, and refuses a directory", () => {
    writeFileSync(join(base, "note.md"), "gone");
    mkdirSync(join(base, "tree"));

    removeFileUnder(base, "note.md");
    removeFileUnder(base, "absent.md");
    expect(readdirSync(base)).toEqual(["tree"]);
    // Both platforms refuse a directory, in their own words: POSIX names the
    // failing syscall, and Windows has no unlinkat to name.
    expect(() => removeFileUnder(base, "tree")).toThrow(
      process.platform === "win32" ? /remove target is a directory/ : /operation=unlinkat/,
    );
  });

  it("rejects backslash separators at the path wrapper boundary", () => {
    writeFileUnder(base, "folder/name.md", "nested");
    expect(() => writeFileUnder(base, "folder\\name.md", "not accepted by path wrapper")).toThrow();
    expect(readFileUnder(base, "folder/name.md", { maxBytes: 64 })?.toString("utf8")).toBe("nested");
  });
});
