import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { closeSync, constants, mkdirSync, openSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFullSync } from "../../../src/infra/read-full.js";
import { fileTemporaryDirectory } from "../../helpers/directories.js";

const TMP = fileTemporaryDirectory("flywheel-read-full-test-");
const FILE = join(TMP, "note.md");

function withFile<T>(use: (fd: number) => T): T {
  const fd = openSync(FILE, constants.O_RDONLY);
  try {
    return use(fd);
  } finally {
    closeSync(fd);
  }
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(FILE, "abcdefghij");
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("readFullSync", () => {
  it("fills the buffer from the position it is given", () => {
    const buffer = Buffer.alloc(4);

    withFile((fd) => readFullSync(fd, buffer, 3, "note.md"));

    expect(buffer.toString("utf8")).toBe("defg");
  });

  it("refuses a read the file is too short to fill, naming how far it got", () => {
    const buffer = Buffer.alloc(10);

    expect(() => withFile((fd) => {
      truncateSync(FILE, 4);
      readFullSync(fd, buffer, 0, "note.md");
    })).toThrow("note.md ended after 4 of 10 bytes");
  });

  it("refuses a read that starts past the end of the file", () => {
    const buffer = Buffer.alloc(2);

    expect(() => withFile((fd) => readFullSync(fd, buffer, 10, "note.md"))).toThrow("ended after 0 of 2 bytes");
  });

  it("reads nothing for an empty buffer", () => {
    expect(() => withFile((fd) => readFullSync(fd, Buffer.alloc(0), 99, "note.md"))).not.toThrow();
  });
});
