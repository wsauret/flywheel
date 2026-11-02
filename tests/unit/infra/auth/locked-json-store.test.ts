import { describe, expect, test } from "bun:test";
import { POSIX_FILE_MODES } from "../../../helpers/posix-modes.js";
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  AccountStorageAccessError,
  lockedJsonStorePath,
  MalformedLockedJsonError,
  mutateLockedJsonStore,
  readLockedJsonStore,
  type LockedJsonStoreOptions,
} from "../../../../src/infra/auth/locked-json-store.js";
import { ContainedDirectory, ContainedPathError } from "../../../../src/infra/descriptor-directory.js";
import { temporaryDirectories } from "../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

/** One store located the way an account secret is: a base the account owns, and
 *  the Flywheel-owned components below it that every operation walks without
 *  following a link. */
function options(): LockedJsonStoreOptions<{ [key: string]: number }> {
  // The symlink cases write their outside target beside the base directory, so
  // the base directory is one level inside the temporary directory that the
  // cleanup removes.
  const dir = join(temporaryDirectory("locked-json-store-test-"), "account");
  mkdirSync(dir);
  return {
    location: { baseDir: dir, relativePath: "auth/credentials.json" },
    empty: () => ({}),
    decode(value) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected object");
      const decoded: { [key: string]: number } = {};
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry !== "number") throw new Error("expected number");
        decoded[key] = entry;
      }
      return decoded;
    },
    encode: (value) => value,
  };
}

describe("locked JSON store", () => {
  test("distinguishes absent, valid, and malformed files", async () => {
    const store = options();
    const absent = readLockedJsonStore(store);
    expect(absent).toMatchObject({ tag: "absent", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    await mutateLockedJsonStore(store, (value) => { value.count = 1; });
    const valid = readLockedJsonStore(store);
    expect(valid).toMatchObject({ tag: "valid", value: { count: 1 }, revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(valid.revision).not.toBe(absent.revision);
    writeFileSync(storeFile(store), "not-json\n");
    const malformed = readLockedJsonStore(store);
    expect(malformed).toMatchObject({ tag: "malformed", revision: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(malformed.revision).not.toBe(valid.revision);
  });

  test("writes atomically with 0600 permissions", async () => {
    const store = options();
    await mutateLockedJsonStore(store, (value) => { value.count = 1; });
    if (POSIX_FILE_MODES) expect(statSync(dirname(storeFile(store))).mode & 0o777).toBe(0o700);
    if (POSIX_FILE_MODES) expect(statSync(storeFile(store)).mode & 0o777).toBe(0o600);
    expect(readdirSync(dirname(storeFile(store)))).toEqual(["credentials.json"]);
  });

  test("preserves malformed bytes and returns a redacted actionable error", async () => {
    const store = options();
    const malformed = "{\"token\":\"do-not-report\"";
    mkdirSync(dirname(storeFile(store)), { recursive: true });
    writeFileSync(storeFile(store), malformed);
    const failure = await mutateLockedJsonStore(store, (value) => { value.count = 1; }).catch((error) => error);
    expect(failure).toBeInstanceOf(MalformedLockedJsonError);
    expect(String(failure)).not.toContain("do-not-report");
    expect(readFileSync(storeFile(store), "utf-8")).toBe(malformed);
  });

  test("serializes concurrent read-mutate-write operations", async () => {
    const store = options();
    await Promise.all(Array.from({ length: 10 }, () => mutateLockedJsonStore(store, async (value) => {
      const before = value.count ?? 0;
      await Promise.resolve();
      value.count = before + 1;
    })));
    expect(readLockedJsonStore(store)).toMatchObject({ tag: "valid", value: { count: 10 } });
  });

  test("rejects a failed publication and keeps the previous bytes", async () => {
    const store = options();
    await mutateLockedJsonStore(store, (value) => { value.count = 1; });
    const publish = ContainedDirectory.prototype.writeFile;
    const failure = new Error("ENOSPC: no space left on device");
    ContainedDirectory.prototype.writeFile = function (name, content) {
      return name === "credentials.json" ? failure : publish.call(this, name, content);
    };
    try {
      await expect(mutateLockedJsonStore(store, (value) => { value.count = 2; })).rejects.toBe(failure);
    } finally {
      ContainedDirectory.prototype.writeFile = publish;
    }
    expect(readLockedJsonStore(store)).toMatchObject({ tag: "valid", value: { count: 1 } });
  });

  test("preserves a containment error thrown by the mutation callback", async () => {
    const store = options();
    const callbackFailure = new ContainedPathError("callback failure");

    await expect(mutateLockedJsonStore(store, () => { throw callbackFailure; })).rejects.toBe(callbackFailure);
  });
});

/** A secret store is Flywheel's own state inside a directory other processes can
 *  write. Every component from the account data directory down is refused when it
 *  is a link, in both directions: no credential is read from a file an attacker
 *  chose, and no credential is written outside the account. */
describe("locked JSON store refuses a replaced component", () => {
  test("refuses a store file that is a symlink and writes nothing through it", async () => {
    const store = options();
    const outside = join(dirname(store.location.baseDir), `outside-${Date.now()}.json`);
    writeFileSync(outside, JSON.stringify({ count: 99 }));
    mkdirSync(dirname(storeFile(store)), { recursive: true });
    symlinkSync(outside, storeFile(store));

    expect(() => readLockedJsonStore(store)).toThrow(AccountStorageAccessError);
    await expect(mutateLockedJsonStore(store, (value) => { value.count = 1; })).rejects.toThrow(AccountStorageAccessError);
    expect(readFileSync(outside, "utf-8")).toBe(JSON.stringify({ count: 99 }));
  });

  test("identifies an unsafe auth directory without exposing its target", async () => {
    const store = options();
    const outside = join(dirname(store.location.baseDir), `outside-${Date.now()}`);
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, dirname(storeFile(store)));

    const readFailure = (() => {
      try {
        return readLockedJsonStore(store);
      } catch (error) {
        return error;
      }
    })();
    const writeFailure = await mutateLockedJsonStore(store, (value) => { value.count = 1; }).catch((error) => error);

    for (const failure of [readFailure, writeFailure]) {
      expect(failure).toBeInstanceOf(AccountStorageAccessError);
      expect(failure).toMatchObject({ path: storeFile(store), code: expect.any(String), cause: expect.any(ContainedPathError) });
      expect(String(failure)).toContain("Repair or move the unsafe path and try again");
      expect(String(failure)).not.toContain(outside);
    }
    expect(readdirSync(outside)).toEqual([]);
  });

  test("refuses an account data directory that is a symlink and creates nothing inside it", async () => {
    const dir = temporaryDirectory("locked-json-store-test-");
    const outside = join(dir, "outside");
    mkdirSync(outside, { recursive: true });
    const store = { ...options(), location: { baseDir: join(dir, "data"), relativePath: "auth/credentials.json" } };
    symlinkSync(outside, store.location.baseDir);

    expect(() => readLockedJsonStore(store)).toThrow();
    await expect(mutateLockedJsonStore(store, (value) => { value.count = 1; })).rejects.toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });
});

function storeFile(store: LockedJsonStoreOptions<{ [key: string]: number }>): string {
  return lockedJsonStorePath(store.location);
}