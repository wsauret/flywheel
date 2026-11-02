import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import { closeSync, constants, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { componentBuffer } from "../../../src/infra/descriptor-directory-posix-component.js";
import { isDirectoryEntryAt, posixContainedDirectoryBackend } from "../../../src/infra/descriptor-directory-posix.js";
import type { ContainedDirectoryContract } from "../../../src/infra/descriptor-directory-contract.js";

const isPosix = process.platform === "linux" || process.platform === "darwin";
let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "flywheel-descriptor-posix-"));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function withBase<T>(use: (directory: ContainedDirectoryContract) => T): T {
  const directory = posixContainedDirectoryBackend.open(base, [], {});
  try {
    return use(directory);
  } finally {
    directory.close();
  }
}

describe("POSIX component encoding", () => {
  it.skipIf(!isPosix)("encodes one validated component without rewriting legal backslashes", () => {
    expect(componentBuffer("folder\\name")).toEqual(Buffer.from("folder\\name\0"));

    withBase((directory) => {
      expect(directory.writeFile("folder\\name", "content")).toBeUndefined();
      expect(directory.readFile("folder\\name", 64)?.toString("utf8")).toBe("content");
    });
  });

  it.skipIf(!isPosix)("rejects names that cannot be passed to libc", () => {
    for (const invalid of ["", ".", "..", "nested/name", "nul\0name"]) {
      expect(() => componentBuffer(invalid)).toThrow("one path component");
    }
  });
});

describe("POSIX directory entry classification", () => {
  it.skipIf(!isPosix)("resolves entries whose directory stream reports no useful type", () => {
    mkdirSync(join(base, "child"));
    writeFileSync(join(base, "note.md"), "content");
    symlinkSync(join(base, "child"), join(base, "linked"));
    const fd = openSync(base, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      expect(isDirectoryEntryAt(fd, { name: "child", type: "other" })).toBe(true);
      expect(isDirectoryEntryAt(fd, { name: "note.md", type: "other" })).toBe(false);
      expect(isDirectoryEntryAt(fd, { name: "linked", type: "other" })).toBe(false);
      expect(isDirectoryEntryAt(fd, { name: "missing", type: "other" })).toBe(false);
    } finally {
      closeSync(fd);
    }
  });
});

describe("POSIX linked directory resolution", () => {
  it.skipIf(!isPosix)("reports an unresolved linked child as absent", () => {
    withBase((directory) => {
      const missing = join(base, "missing");
      const link = join(base, "linked");
      symlinkSync(missing, link);
      expect(directory.openLinkedChild("linked")).toBeUndefined();
    })
  })
})

describe("POSIX bounded descriptor reads", () => {
  it.skipIf(!isPosix).each([
    ["readOwnedFile", "grow"],
    ["readOwnedFile", "truncate"],
    ["readFileSnapshot", "grow"],
    ["readFileSnapshot", "truncate"],
  ] as const)("%s reads only admitted bytes after %s", (method, mutation) => {
    const file = join(base, "record");
    writeFileSync(file, "head");
    withBase((directory) => {
      const original = fs.fstatSync;
      function measure(fd: number, options?: fs.StatOptions & { bigint?: false }): fs.Stats;
      function measure(fd: number, options: fs.StatOptions & { bigint: true }): fs.BigIntStats;
      function measure(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats;
      function measure(fd: number, options?: fs.StatOptions): fs.Stats | fs.BigIntStats {
        const measured = original(fd, options);
        if (mutation === "grow") fs.appendFileSync(file, "tailtail");
        else fs.truncateSync(file, 2);
        return measured;
      }
      const stat = spyOn(fs, "fstatSync").mockImplementationOnce(measure);
      try {
        const result = directory[method]("record", 4);
        expect(stat).toHaveBeenCalledTimes(1);
        expect(result?.content.toString()).toBe(mutation === "grow" ? "head" : "he");
        expect(result?.linkCount).toBe(1);
        expect(fs.statSync(file).size).toBe(mutation === "grow" ? 12 : 2);
      } finally {
        stat.mockRestore();
      }
    });
  });
});
