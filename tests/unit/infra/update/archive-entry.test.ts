import { describe, expect, test } from "bun:test";
import { ArchiveEntryError, archiveTree, confinedEntryPath } from "../../../../src/infra/update/archive-entry.js";

describe("where an archive entry lands", () => {
  test("a name lands where an extractor puts it, with either separator", () => {
    expect(confinedEntryPath("flywheel-linux-x64/build/flywheel-bin")).toBe("flywheel-linux-x64/build/flywheel-bin");
    expect(confinedEntryPath("./root//build/./native/")).toBe("root/build/native");
    expect(confinedEntryPath("root\\build\\fonts\\a.otf")).toBe("root/build/fonts/a.otf");
    expect(confinedEntryPath("root/build/../build/a")).toBe("root/build/a");
    expect(confinedEntryPath("./")).toBe("");
  });

  test("a name of any length, spelling, or character set a file system holds is placed", () => {
    const long = `root/${"d".repeat(200)}/${"f".repeat(240)}.bin`;
    expect(confinedEntryPath(long)).toBe(long);
    expect(confinedEntryPath("root/ünïcødé file (1).txt")).toBe("root/ünïcødé file (1).txt");
  });

  test("a name that would land outside the tree is refused", () => {
    for (const name of ["/etc/passwd", "\\\\server\\share\\x", "C:/Windows/x", "c:x", "../escaped", "root/../../escaped", "root\\..\\..\\escaped", "a\0b"]) {
      expect(() => confinedEntryPath(name)).toThrow(ArchiveEntryError);
    }
  });
});

describe("the tree an archive lists", () => {
  test("a repeated file replaces the earlier one and a repeated directory changes nothing", () => {
    const tree = archiveTree();
    tree.directory("root");
    tree.file("root/a");
    tree.file("root/a");
    tree.directory("root");

    expect(tree.directories()).toEqual(["root"]);
  });

  test("an entry with no listed parent makes its parents, each after its own parent", () => {
    const tree = archiveTree();
    tree.file("root/build/native/linux-x64/lib.so");

    expect(tree.directories()).toEqual(["root", "root/build", "root/build/native", "root/build/native/linux-x64"]);
  });

  test("tens of thousands of entries are listed, because the count is the release's to choose", () => {
    const tree = archiveTree();
    for (let index = 0; index < 20_000; index += 1) tree.file(`root/files/${index}`);

    expect(tree.directories()).toEqual(["root", "root/files"]);
  });

  test("a path listed as both a file and a directory is refused, because no tree holds it", () => {
    const fileFirst = archiveTree();
    fileFirst.file("root/a");
    expect(() => fileFirst.directory("root/a")).toThrow(ArchiveEntryError);
    expect(() => fileFirst.file("root/a/b")).toThrow(ArchiveEntryError);

    const directoryFirst = archiveTree();
    directoryFirst.directory("root/a");
    expect(() => directoryFirst.file("root/a")).toThrow(ArchiveEntryError);
  });

  test("a file at the root of the archive is refused", () => {
    expect(() => archiveTree().file("")).toThrow(ArchiveEntryError);
  });
});
