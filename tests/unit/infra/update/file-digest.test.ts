import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sha256File } from "../../../../src/infra/update/file-digest.js";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-file-digest-"));

afterAll(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

function fixture(name: string, contents: Buffer | string): string {
  const file = path.join(TMP, name);
  fs.writeFileSync(file, contents);
  return file;
}

describe("file digest", () => {
  test("a known fixture digests to its published SHA-256", async () => {
    expect(await sha256File(fixture("hello", "hello world"))).toBe("b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  });

  test("a payload larger than one stream chunk digests as one byte sequence", async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
    const expected = createHash("sha256").update(bytes).digest("hex");

    expect(await sha256File(fixture("large.bin", bytes))).toBe(expected);
  });

  test("an absent file fails instead of digesting nothing", async () => {
    expect(sha256File(path.join(TMP, "absent"))).rejects.toBeDefined();
  });
});
