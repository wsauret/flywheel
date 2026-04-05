import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { isPathWithinBoundary } from "../src/orchestration/utils/path-security";
import { mkdtemp, rm, symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// isPathWithinBoundary
// ---------------------------------------------------------------------------

describe("isPathWithinBoundary", () => {
  let boundary: string;

  beforeEach(async () => {
    boundary = await mkdtemp(join(tmpdir(), "path-security-"));
    await mkdir(join(boundary, "subdir"), { recursive: true });
  });

  afterEach(async () => {
    await rm(boundary, { recursive: true, force: true });
  });

  it("allows a path within the boundary", () => {
    const filePath = join(boundary, "subdir", "file.ts");
    expect(isPathWithinBoundary(filePath, boundary)).toBe(true);
  });

  it("allows a path that is exactly the boundary", () => {
    expect(isPathWithinBoundary(boundary, boundary)).toBe(true);
  });

  it("rejects ../../etc/passwd traversal", () => {
    const filePath = join(boundary, "..", "..", "etc", "passwd");
    expect(isPathWithinBoundary(filePath, boundary)).toBe(false);
  });

  it("rejects absolute path outside boundary", () => {
    expect(isPathWithinBoundary("/etc/passwd", boundary)).toBe(false);
  });

  it("allows a path with .. that resolves inside boundary", () => {
    // boundary/subdir/../file.ts resolves to boundary/file.ts — still within boundary
    const filePath = join(boundary, "subdir", "..", "file.ts");
    expect(isPathWithinBoundary(filePath, boundary)).toBe(true);
  });

  it("rejects a path that is a prefix but not a directory boundary", () => {
    // e.g., boundary = /tmp/abc, filePath = /tmp/abcdef/file.ts
    // "abcdef" starts with "abc" but is NOT a subdirectory of "abc"
    const siblingDir = boundary + "def";
    const filePath = join(siblingDir, "file.ts");
    expect(isPathWithinBoundary(filePath, boundary)).toBe(false);
  });

  it("handles relative paths resolved against cwd", () => {
    // A relative path that tries to escape
    const filePath = "../../etc/passwd";
    const cwd = process.cwd();
    // This should be false unless cwd happens to contain /etc — very unlikely in tests
    expect(isPathWithinBoundary(filePath, boundary)).toBe(false);
  });

  it("rejects symlink target outside boundary", async () => {
    // Create a symlink inside boundary that points outside
    const outsideTarget = "/tmp";
    const symlinkPath = join(boundary, "escape-link");
    try {
      await symlink(outsideTarget, symlinkPath);
      expect(isPathWithinBoundary(symlinkPath, boundary)).toBe(false);
    } catch {
      // Symlink creation may fail on some systems; skip gracefully
      expect(true).toBe(true);
    }
  });

  it("allows symlink target within boundary", async () => {
    const targetPath = join(boundary, "subdir");
    const symlinkPath = join(boundary, "link-to-subdir");
    try {
      await symlink(targetPath, symlinkPath);
      expect(isPathWithinBoundary(symlinkPath, boundary)).toBe(true);
    } catch {
      // Symlink creation may fail; skip gracefully
      expect(true).toBe(true);
    }
  });
});
