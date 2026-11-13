import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSettings } from "../src/settings/load";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

test("an unknown symbol takes the default with a warning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "till-"));
  dirs.push(dir);
  await Bun.write(join(dir, "settings.json"), JSON.stringify({ shopName: "Corner", locale: "en-GB", currencySymbol: "¥" }));
  const warnings: string[] = [];
  const settings = await loadSettings(join(dir, "settings.json"), (message) => warnings.push(message));
  expect(settings.currencySymbol).toBe("$");
  expect(warnings.length).toBe(1);
});
