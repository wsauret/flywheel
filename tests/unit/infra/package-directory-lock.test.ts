import { expect, test } from "bun:test";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { tryWithPackageLocksSync, withPackageRead } from "../../../src/infra/package-directory-lock.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

// An attempt that the file system fails still closes the lock directory it
// opened, because a caller such as a migration retries on its next pass. A
// package name this long leaves room for its lock's name but not for the
// owner file that publishes the lock's record, so every attempt fails there.
test.skipIf(process.platform === "win32")("a single attempt that fails closes the lock directory it opened", () => {
  const packageDir = join(temporaryDirectory("package-lock-test-"), "skills", "p".repeat(220));
  mkdirSync(packageDir, { recursive: true });
  // The first attempt creates the lock directory, so the count below compares
  // two attempts that open the same entries.
  expect(() => tryWithPackageLocksSync([packageDir], () => {})).toThrow("ENAMETOOLONG");
  const descriptors = readdirSync("/dev/fd").length;
  expect(() => tryWithPackageLocksSync([packageDir], () => {})).toThrow("ENAMETOOLONG");
  expect(readdirSync("/dev/fd").length).toBe(descriptors);
});

// A synchronous writer, such as a migration, makes one attempt and never
// waits, so a package that a reader still holds must count as held.
test("a single attempt finds a package held while a reader holds it", async () => {
  const packageDir = join(temporaryDirectory("package-lock-test-"), "skills", "pdf");
  mkdirSync(packageDir, { recursive: true });
  let attempt: boolean | undefined;
  await withPackageRead(packageDir, async () => {
    attempt = tryWithPackageLocksSync([packageDir], () => {});
  });
  expect(attempt).toBe(false);
  expect(tryWithPackageLocksSync([packageDir], () => {})).toBe(true);
});
