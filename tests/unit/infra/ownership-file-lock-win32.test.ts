import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setContainedDirectoryBackendForTests } from "../../../src/infra/descriptor-directory.js";
import { win32ContainedDirectoryBackend } from "../../../src/infra/descriptor-directory-win32.js";
import { withPackageLocks } from "../../../src/infra/package-directory-lock.js";

let workspace: string;
let packageDir: string;

beforeEach(() => {
  setContainedDirectoryBackendForTests(win32ContainedDirectoryBackend);
  workspace = mkdtempSync(join(tmpdir(), "flywheel package lock win32-"));
  packageDir = join(workspace, "skills", "package");
  mkdirSync(packageDir, { recursive: true });
});

afterEach(() => {
  setContainedDirectoryBackendForTests(undefined);
  rmSync(workspace, { recursive: true, force: true });
});

describe("skill package locks on the Windows backend", () => {
  it("refuses a pre-existing .locks reparse point", async () => {
    const outside = join(workspace, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(workspace, "skills", ".locks"));

    await expect(withPackageLocks([packageDir], async () => undefined)).rejects.toThrow();
    expect(readdirSync(outside)).toEqual([]);
  });

  it("holds and releases a lock inside a contained .locks child", async () => {
    await withPackageLocks([packageDir], async () => {
      expect(readdirSync(join(workspace, "skills", ".locks"))).toHaveLength(1);
    });

    expect(readdirSync(join(workspace, "skills", ".locks"))).toEqual([]);
  });
});
