import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createTestTempGuard, formatTempLeaks, tempEntryPrefix } from "../../../scripts/test-temp-guard.js";
import { privateTemporaryRootName } from "../../../src/infra/private-temporary-root.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporary = temporaryDirectories();
const guards: ReturnType<typeof createTestTempGuard>[] = [];

afterEach(() => {
  for (const guard of guards.splice(0)) guard.dispose();
});

function guardIn(root: string) {
  const guard = createTestTempGuard(root);
  guards.push(guard);
  return guard;
}

describe("test temporary directory guard", () => {
  test("gives each test process its own empty temporary directory", () => {
    const guard = guardIn(temporary("flywheel-temp-guard-"));

    const first = guard.env("band-1");
    const second = guard.env("band-2");

    expect(first.TMPDIR).not.toBe(second.TMPDIR);
    expect(first.TEMP).toBe(first.TMPDIR);
    expect(first.TMP).toBe(first.TMPDIR);
    expect(readdirSync(first.TMPDIR)).toEqual([]);
  });

  test("names each directory by its physical path when the root is reached through a link", () => {
    const parent = temporary("flywheel-temp-guard-");
    const physical = join(parent, "physical");
    const linked = join(parent, "linked");
    mkdirSync(physical);
    // A junction on Windows needs no privilege; other platforms ignore the type.
    symlinkSync(physical, linked, "junction");

    const dir = guardIn(linked).env("band-1").TMPDIR;

    expect(dir.startsWith(join(realpathSync.native(physical), ""))).toBe(true);
  });

  test("reports what a test process left behind and removes it", () => {
    const guard = guardIn(temporary("flywheel-temp-guard-"));
    const dir = guard.env("band-1").TMPDIR;
    mkdirSync(join(dir, "auth-store-test-Ab12Cd"));
    writeFileSync(join(dir, "outside-secret.txt"), "");

    expect(guard.collect("band-1")).toEqual({ label: "band-1", names: ["auth-store-test-Ab12Cd", "outside-secret.txt"] });
    expect(existsSync(dir)).toBe(false);
  });

  test("a directory made after a collection never reuses a live one", () => {
    const guard = guardIn(temporary("flywheel-temp-guard-"));
    guard.env("band-1");
    const second = guard.env("band-2").TMPDIR;
    guard.collect("band-1");

    expect(guard.env("band-3").TMPDIR).not.toBe(second);
  });

  test("reports what is inside a root that Flywheel keeps, not the root", () => {
    const guard = guardIn(temporary("flywheel-temp-guard-"));
    const dir = guard.env("band-1").TMPDIR;
    mkdirSync(join(dir, privateTemporaryRootName("fw-ipc")));
    mkdirSync(join(dir, privateTemporaryRootName("flywheel-spools"), "spool-Ab12Cd"), { recursive: true });

    expect(guard.collect("band-1")).toEqual({ label: "band-1", names: [`${privateTemporaryRootName("flywheel-spools")}/spool-Ab12Cd`] });
  });

  test("a clean test process reports nothing", () => {
    const guard = guardIn(temporary("flywheel-temp-guard-"));
    guard.env("band-1");

    expect(guard.collect("band-1")).toBeUndefined();
  });

  test("disposal removes every directory the guard made", () => {
    const root = temporary("flywheel-temp-guard-");
    const guard = createTestTempGuard(root);
    mkdirSync(join(guard.env("band-1").TMPDIR, "leftover"));

    guard.dispose();

    expect(readdirSync(root)).toEqual([]);
  });
});

describe("temporary leak report", () => {
  test("strips the random suffix that mkdtemp adds", () => {
    expect(tempEntryPrefix("auth-store-test-Ab12Cd")).toBe("auth-store-test-*");
    expect(tempEntryPrefix("flywheel windows install 4aNa1E")).toBe("flywheel windows install *");
    expect(tempEntryPrefix(".bench-home")).toBe(".bench-home");
    expect(tempEntryPrefix("flywheel-agent-bg-06edcd88.log")).toBe("flywheel-agent-bg-06edcd88.log");
  });

  test("groups leaked entries by prefix with the processes that left them", () => {
    const text = formatTempLeaks([
      { label: "band-1", names: ["auth-store-test-Ab12Cd", "auth-store-test-Xy34Zw"] },
      { label: "band-2", names: ["auth-store-test-Qq11Rr", "profile-locks"] },
    ]);

    expect(text).toContain("Tests left 4 temporary entries in TMPDIR.");
    expect(text).toContain("  auth-store-test-* (3, band-1 band-2)");
    expect(text).toContain("  profile-locks (1, band-2)");
  });
});
