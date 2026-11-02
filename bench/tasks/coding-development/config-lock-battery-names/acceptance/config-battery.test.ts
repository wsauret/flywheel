import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, lstatSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ContainedDirectory } from "../src/infra/descriptor-directory.js";
import { acquireLockSyncIn, releaseLockIn } from "../src/infra/ownership-file-lock.js";
import { withConfigOwnership, withConfigOwnershipBlocking } from "../src/orchestration/config/config-file.js";

test("different config names have independent synchronous ownership", () => {
  const directory = mkdtempSync(join(tmpdir(), "config-battery-"));
  try {
    const alpha = { configPath: join(directory, "alpha.toml") };
    const beta = { configPath: join(directory, "beta.toml") };
    let failure: unknown;
    try {
      withConfigOwnershipBlocking(alpha, first => {
        first.write("alpha = 1\n");
        withConfigOwnershipBlocking(beta, second => second.write("beta = 2\n"));
        expect(first.readText()).toBe("alpha = 1\n");
      });
    } catch (error) { failure = error; }
    expect(failure).toBeUndefined();
    expect(readFileSync(beta.configPath, "utf8")).toBe("beta = 2\n");
    expect(readdirSync(directory).sort()).toEqual(["alpha.toml", "beta.toml"]);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("asynchronous ownership waits on the selected file while another file stays writable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "config-battery-"));
  const native = ContainedDirectory.open(dirname(directory), [basename(directory)], { privateDirectories: true });
  const hold = acquireLockSyncIn(native, "beta.toml.lock");
  let released = false;
  let called = false;
  const timer = setTimeout(() => { releaseLockIn(native, hold); released = true; }, 10);
  const waiting = withConfigOwnership({ configPath: join(directory, "beta.toml") }, config => {
    called = true;
    config.write("beta = 3\n");
    return released;
  }).then(value => ({ value }), error => ({ error }));
  const calledBeforeRelease = called;
  let siblingError: unknown;
  try {
    withConfigOwnershipBlocking({ configPath: join(directory, "alpha.toml") }, config => config.write("alpha = 4\n"));
  } catch (error) { siblingError = error; }
  try {
    const result = await waiting;
    expect(calledBeforeRelease).toBe(false);
    expect(siblingError).toBeUndefined();
    expect(result).toEqual({ value: true });
    expect(readFileSync(join(directory, "alpha.toml"), "utf8")).toBe("alpha = 4\n");
    expect(readFileSync(join(directory, "beta.toml"), "utf8")).toBe("beta = 3\n");
  } finally {
    clearTimeout(timer);
    if (!released) releaseLockIn(native, hold);
    native.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("synchronous ownership refuses an existing owner of the selected file", () => {
  const directory = mkdtempSync(join(tmpdir(), "config-battery-"));
  const native = ContainedDirectory.open(dirname(directory), [basename(directory)], { privateDirectories: true });
  const hold = acquireLockSyncIn(native, "beta.toml.lock");
  const record = native.readFile("beta.toml.lock", 8192);
  let called = false;
  let failure: unknown;
  try {
    try {
      withConfigOwnershipBlocking({ configPath: join(directory, "beta.toml") }, () => { called = true; });
    } catch (error) { failure = error; }
    expect(called).toBe(false);
    expect(failure).toBeInstanceOf(Error);
    expect(native.readFile("beta.toml.lock", 8192)).toEqual(record);
  } finally {
    releaseLockIn(native, hold);
    native.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("callback failure releases the selected file and preserves its error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "config-battery-"));
  const location = { configPath: join(directory, "beta.toml") };
  const failure = new Error("selected callback failed");
  try {
    const result = await withConfigOwnership(location, () => { throw failure; }).then(value => ({ value }), error => ({ error }));
    expect(result).toEqual({ error: failure });
    expect(readdirSync(directory)).toEqual([]);
    expect(withConfigOwnershipBlocking(location, config => config.write("beta = 5\n"))).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
