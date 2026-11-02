import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeSync, constants, mkdirSync, openSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openAt } from "../../../src/infra/open-at.js";
import { fileTemporaryDirectory } from "../../helpers/directories.js";

const TMP = fileTemporaryDirectory("flywheel-open-at-test-");
const REAL = join(TMP, "real");
const DECOY = join(TMP, "decoy");

function textOf(fd: number): string {
  try {
    return readFileSync(fd, "utf-8");
  } finally {
    closeSync(fd);
  }
}

function codeOf(open: () => number) {
  try {
    closeSync(open());
    return "(no failure)";
  } catch (err) {
    if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
    return err.code;
  }
}

beforeEach(() => {
  mkdirSync(REAL, { recursive: true });
  mkdirSync(DECOY, { recursive: true });
  writeFileSync(join(REAL, "note.md"), "the bound file");
  writeFileSync(join(DECOY, "note.md"), "the decoy file");
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// Descriptor-relative calls are the POSIX surface this covers: NO_LIBC_REASON in
// src/infra/libc.ts states that Windows exposes none, and the Windows backend
// uses a different mechanism with its own coverage. An errno, a syscall name, or
// a walk stage has no Windows counterpart to assert.
const DESCRIPTOR_RELATIVE = process.platform !== "win32";

describe.skipIf(!DESCRIPTOR_RELATIVE)("openAt", () => {
  it("resolves the entry of the open directory, not of the path it was opened by", () => {
    const bound = openSync(REAL, constants.O_RDONLY | constants.O_DIRECTORY);

    // The directory is renamed and another real directory takes its path: a
    // path-based open would now read the decoy, which is the check-then-use gap
    // a containment walk cannot have.
    renameSync(REAL, join(TMP, "moved"));
    renameSync(DECOY, REAL);

    try {
      expect(textOf(openAt(bound, "note.md", constants.O_RDONLY))).toBe("the bound file");
      expect(readFileSync(join(REAL, "note.md"), "utf-8")).toBe("the decoy file");
    } finally {
      closeSync(bound);
    }
  });

  it("refuses a symlinked entry and reports the libc code", () => {
    symlinkSync(join(DECOY, "note.md"), join(REAL, "link.md"));
    const bound = openSync(REAL, constants.O_RDONLY | constants.O_DIRECTORY);

    try {
      expect(codeOf(() => openAt(bound, "link.md", constants.O_RDONLY | constants.O_NOFOLLOW))).toBe("ELOOP");
      expect(codeOf(() => openAt(bound, "absent.md", constants.O_RDONLY))).toBe("ENOENT");
    } finally {
      closeSync(bound);
    }
  });

  it("takes one path component, never a path to walk", () => {
    const bound = openSync(REAL, constants.O_RDONLY | constants.O_DIRECTORY);

    try {
      for (const name of ["", ".", "..", "sub/note.md", "note\0.md"]) {
        expect(() => openAt(bound, name, constants.O_RDONLY)).toThrow("one path component");
      }
    } finally {
      closeSync(bound);
    }
  });
});
