import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { ContainedDirectory } from "../src/infra/descriptor-directory.js";
import { acquireLockSyncIn, releaseLockIn } from "../src/infra/ownership-file-lock.js";
import { withConfigOwnership, withConfigOwnershipBlocking } from "../src/orchestration/config/config-file.js";

test("an asynchronous config read does not block the next synchronous settings write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "config-ownership-"));
  const location = { configPath: join(directory, "flywheel.toml") };
  const text = '[roles.explorer]\nmodel = "gpt-5.5"\neffort = "high"\n';
  const reading = withConfigOwnership(location, config => config.readText());
  let writeOutcome: unknown;
  try {
    try {
      writeOutcome = withConfigOwnershipBlocking(location, config => config.write(text));
    } catch (error) {
      writeOutcome = error;
    }
    const readOutcome = await reading;
    expect(writeOutcome).toBeUndefined();
    expect(readOutcome).toBe("");
    expect(withConfigOwnershipBlocking(location, config => config.readText())).toBe(text);
  } finally {
    await reading.catch(() => {});
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed config callback releases ownership before a sibling write", async () => {
  const directory = mkdtempSync(join(tmpdir(), "config-ownership-"));
  const location = { configPath: join(directory, "flywheel.toml") };
  const failure = new Error("config callback failed");
  const failed = withConfigOwnership(location, () => { throw failure; });
  const observed = failed.then(value => ({ value }), error => ({ error }));
  let writeOutcome: unknown;
  try {
    try {
      writeOutcome = withConfigOwnershipBlocking(location, config => config.write("show_thinking = true\n"));
    } catch (error) {
      writeOutcome = error;
    }
    const callbackOutcome = await observed;
    expect(callbackOutcome).toEqual({ error: failure });
    expect(writeOutcome).toBeUndefined();
    expect(withConfigOwnershipBlocking(location, config => config.readText())).toBe("show_thinking = true\n");
  } finally {
    await observed;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("asynchronous config ownership waits for a lock released by the event loop", async () => {
  const directory = mkdtempSync(join(tmpdir(), "config-ownership-"));
  const held = ContainedDirectory.open(dirname(directory), [basename(directory)], { privateDirectories: true });
  const hold = acquireLockSyncIn(held, "flywheel.toml.lock");
  const location = { configPath: join(directory, "flywheel.toml") };
  const text = "show_thinking = true\n";
  let released = false;
  let called = false;
  let published = false;
  let siblingOutcome: unknown;
  let resolveObservation!: () => void;
  const observation = new Promise<void>(resolve => { resolveObservation = resolve; });
  const linkFile = ContainedDirectory.prototype.linkFile;
  const publication = spyOn(ContainedDirectory.prototype, "linkFile").mockImplementation(function (this: ContainedDirectory, existing, name) {
    const linked = linkFile.call(this, existing, name);
    if (linked && name === "flywheel.toml.lock" && released && !published) {
      published = true;
      queueMicrotask(() => {
        try {
          siblingOutcome = withConfigOwnershipBlocking(location, config => config.write(text));
        } catch (error) {
          siblingOutcome = error;
        } finally {
          resolveObservation();
        }
      });
    }
    return linked;
  });
  const timer = setTimeout(() => {
    releaseLockIn(held, hold);
    released = true;
  }, 10);
  try {
    const waiting = withConfigOwnership(location, config => {
      called = true;
      return { released, text: config.readText() };
    }).then(value => ({ value }), error => ({ error }));
    expect(called).toBe(false);
    expect(await waiting).toEqual({ value: { released: true, text: "" } });
    expect(published).toBe(true);
    await observation;
    expect(siblingOutcome).toBeUndefined();
    expect(withConfigOwnershipBlocking(location, config => config.readText())).toBe(text);
  } finally {
    publication.mockRestore();
    clearTimeout(timer);
    if (!released) releaseLockIn(held, hold);
    held.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
