import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { temporaryDirectories } from "../../helpers/directories.js";

// The factory registers its removal before the hook below. Bun runs the
// afterEach hooks of one scope in registration order, and a file usually
// opens the factory first. A hook registered later closes a store or a
// process that writes into the directory. On Windows a removal while the
// store is open fails with EBUSY.
const temporary = temporaryDirectories();

let directory: string | undefined;
let closedInside = false;

afterEach(() => {
  if (directory === undefined) return;
  // A store that flushes its last bytes when it closes.
  writeFileSync(join(directory, "closing.sqlite"), "flushed");
  closedInside = true;
});

describe("temporary directories", () => {
  test("a case creates a directory that it owns", () => {
    directory = temporary("flywheel-directories-test-");
    expect(existsSync(directory)).toBe(true);
  });

  test("the directory stays until every afterEach hook of its case ran, then goes", () => {
    expect(closedInside).toBe(true);
    expect(directory !== undefined && existsSync(directory)).toBe(false);
    directory = undefined;
  });
});

let unfinishedDirectory: string | undefined;

// Bun skips the finish callbacks of a case when an afterEach hook throws, and
// a skipped case runs no afterEach hook at all. A failing hook cannot be
// shown here without a failing file, so a skipped case stands in for it: the
// directory below is still recorded when its scope ends.
describe("a scope whose case never finishes", () => {
  const scoped = temporaryDirectories();
  unfinishedDirectory = scoped("flywheel-directories-sweep-");

  test.skip("a skipped case runs no afterEach hook", () => {});
});

test("a directory that no finished case removed goes when its scope ends", () => {
  expect(unfinishedDirectory !== undefined && existsSync(unfinishedDirectory)).toBe(false);
});
