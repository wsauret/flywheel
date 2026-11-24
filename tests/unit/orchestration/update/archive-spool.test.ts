import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openContainedDirectory } from "../../../../src/infra/descriptor-directory.js";
import { extractArchive } from "../../../../src/orchestration/update/archive-spool.js";
import { temporaryDirectories } from "../../../helpers/directories.js";
import { paxRecords, tarBlocks, type TarEntrySpec } from "../../../helpers/tar-archive.js";

const UNSAFE_ARCHIVE = /^The archive is not safe to extract: /;
const temporary = temporaryDirectories();

/** The entry that makes an archive hold a build, so a case differs from an
 *  archive that extracts only by the entries under test. */
const BUILD: TarEntrySpec = { name: "root/build.json", typeflag: "0", mode: 0o644, content: "{}" };

function file(name: string, content = "x"): TarEntrySpec {
  return { name, typeflag: "0", mode: 0o644, content };
}

function directory(name: string): TarEntrySpec {
  return { name, typeflag: "5", mode: 0o755 };
}

/** A file whose name only a pax record can state: one longer than the
 *  header's name field, or one that holds a NUL. */
function paxFile(name: string, content = "x"): readonly TarEntrySpec[] {
  return [{ name: "PaxHeader", typeflag: "x", mode: 0o644, content: paxRecords({ path: name }) }, file("placeholder", content)];
}

/** Extracts an archive of `entries` and answers the payload directory it
 *  wrote. */
async function extract(entries: readonly TarEntrySpec[]): Promise<string> {
  const base = temporary("fw-archive-spool-");
  const staging = openContainedDirectory(base, ["staging"]);
  const spool = staging.openChild("spool", { privateDirectories: true });
  const archive = gzipSync(tarBlocks(entries));
  try {
    await extractArchive(staging, spool, (async function* () { yield archive; })(), new AbortController().signal);
  } finally {
    spool.close();
    staging.close();
  }
  return join(base, "staging", "payload");
}

describe("where an archive entry lands", () => {
  test("a name lands where an extractor puts it, with either separator", async () => {
    const payload = await extract([
      BUILD,
      directory("./root//build/./native/"),
      file("root\\build\\fonts\\a.otf", "font"),
      file("root/build/../build/a", "a"),
      directory("./"),
    ]);

    expect(statSync(join(payload, "root", "build", "native")).isDirectory()).toBe(true);
    expect(readFileSync(join(payload, "root", "build", "fonts", "a.otf"), "utf8")).toBe("font");
    expect(readFileSync(join(payload, "root", "build", "a"), "utf8")).toBe("a");
  });

  test("a name of any length, spelling, or character set a file system holds is placed", async () => {
    const long = `root/${"d".repeat(200)}/${"f".repeat(240)}.bin`;
    const payload = await extract([BUILD, ...paxFile(long, "long"), file("root/ünïcødé file (1).txt", "unicode")]);

    expect(readFileSync(join(payload, ...long.split("/")), "utf8")).toBe("long");
    expect(readFileSync(join(payload, "root", "ünïcødé file (1).txt"), "utf8")).toBe("unicode");
  });

  test("a name that would land outside the tree is refused", async () => {
    for (const name of ["/etc/passwd", "\\\\server\\share\\x", "C:/Windows/x", "c:x", "../escaped", "root/../../escaped", "root\\..\\..\\escaped"]) {
      await expect(extract([BUILD, file(name)])).rejects.toThrow(UNSAFE_ARCHIVE);
    }
    await expect(extract([BUILD, ...paxFile("root/a\0b")])).rejects.toThrow(UNSAFE_ARCHIVE);
  });
});

describe("the tree an archive lists", () => {
  test("a repeated file replaces the earlier one and a repeated directory changes nothing", async () => {
    const payload = await extract([BUILD, directory("root/"), file("root/a", "first"), file("root/a", "second"), directory("root/")]);

    expect(readFileSync(join(payload, "root", "a"), "utf8")).toBe("second");
  });

  test("an entry with no listed parent makes its parents", async () => {
    const payload = await extract([BUILD, file("root/build/native/linux-x64/lib.so", "lib")]);

    expect(readFileSync(join(payload, "root", "build", "native", "linux-x64", "lib.so"), "utf8")).toBe("lib");
  });

  test("tens of thousands of entries are listed, because the count is the release's to choose", async () => {
    const payload = await extract([BUILD, ...Array.from({ length: 20_000 }, () => directory("root/files/"))]);

    expect(statSync(join(payload, "root", "files")).isDirectory()).toBe(true);
  });

  test("a path listed as both a file and a directory is refused, because no tree holds it", async () => {
    await expect(extract([BUILD, file("root/a"), directory("root/a/")])).rejects.toThrow(UNSAFE_ARCHIVE);
    await expect(extract([BUILD, file("root/a"), file("root/a/b")])).rejects.toThrow(UNSAFE_ARCHIVE);
    await expect(extract([BUILD, directory("root/a/"), file("root/a")])).rejects.toThrow(UNSAFE_ARCHIVE);
  });

  test("a file at the root of the archive is refused", async () => {
    await expect(extract([BUILD, file("./")])).rejects.toThrow(UNSAFE_ARCHIVE);
  });
});
