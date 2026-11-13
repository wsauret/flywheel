import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseNote } from "../src/notes/store";
import { loadIndex } from "../src/search/index-file";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

test("an index of another version is rebuilt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notes-"));
  dirs.push(dir);
  const path = join(dir, ".notes-index.json");
  await Bun.write(path, JSON.stringify({ version: 0, fingerprint: "x", words: {} }));
  const index = await loadIndex(path, [parseNote("a.md", "# Garden\nplant tomatoes")]);
  expect(index.words.tomatoes).toEqual(["a.md"]);
});
