import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ContainedDirectory } from "../src/infra/descriptor-directory.js";
import { acquireLockSyncIn, releaseLockIn } from "../src/infra/ownership-file-lock.js";
import { withConfigOwnership, withConfigOwnershipBlocking } from "../src/orchestration/config/config-file.js";

test("a symbolic link lock refuses admission and preserves both entries", async () => {
  const directory = mkdtempSync(join(tmpdir(), "config-battery-"));
  const location = { configPath: join(directory, "flywheel.toml") };
  const lock = location.configPath + ".lock";
  const target = join(directory, "unrelated.txt");
  writeFileSync(target, "do not modify", { mode: 0o600 });
  symlinkSync(target, lock);
  let calls = 0;
  try {
    const result = await withConfigOwnership(location, () => { calls++; return 17; }).then(value => ({ value }), error => ({ error }));
    expect(calls).toBe(0);
    expect("error" in result).toBe(true);
    expect(lstatSync(lock).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("do not modify");
    expect(readdirSync(directory).sort()).toEqual(["flywheel.toml.lock", "unrelated.txt"]);
    rmSync(lock);
    expect(await withConfigOwnership(location, config => config.write("ok = true\n"))).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a directory lock refuses admission without removing the directory", async () => {
  const directory = mkdtempSync(join(tmpdir(), "config-battery-"));
  const location = { configPath: join(directory, "flywheel.toml") };
  const lock = location.configPath + ".lock";
  mkdirSync(lock, { mode: 0o700 });
  writeFileSync(join(lock, "marker"), "keep", { mode: 0o600 });
  let calls = 0;
  try {
    const result = await withConfigOwnership(location, () => { calls++; }).then(value => ({ value }), error => ({ error }));
    expect(calls).toBe(0);
    expect("error" in result).toBe(true);
    expect(readFileSync(join(lock, "marker"), "utf8")).toBe("keep");
    expect(readdirSync(directory)).toEqual(["flywheel.toml.lock"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("a callback exception is not retried and leaves native ownership reusable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "config-battery-"));
  const location = { configPath: join(directory, "flywheel.toml") };
  const failure = new Error("admitted callback failed");
  let calls = 0;
  try {
    const result = await withConfigOwnership(location, () => { calls++; throw failure; }).then(value => ({ value }), error => ({ error }));
    expect(result).toEqual({ error: failure });
    expect(calls).toBe(1);
    expect(readdirSync(directory)).toEqual([]);
    expect(withConfigOwnershipBlocking(location, config => config.write("ok = true\n"))).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
