import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findOversizedFiles, SRC_MAX_LINES, TEST_MAX_LINES } from "../../../scripts/check-file-sizes.js";

function tmpRoot(): string {
  return mkdtempSync("/tmp/flywheel-file-size-");
}

describe("check-file-sizes", () => {
  it("flags a file over the code-line limit", () => {
    const root = tmpRoot();
    try {
      const file = join(root, "huge.ts");
      writeFileSync(file, `${"const x = 1\n".repeat(SRC_MAX_LINES + 1)}`);
      const violations = findOversizedFiles(root, SRC_MAX_LINES);
      expect(violations).toEqual([{ file, lines: SRC_MAX_LINES + 1, max: SRC_MAX_LINES }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not flag a code file at the limit", () => {
    const root = tmpRoot();
    try {
      const file = join(root, "at-limit.ts");
      writeFileSync(file, `${"const x = 1\n".repeat(SRC_MAX_LINES)}`);
      expect(findOversizedFiles(root, SRC_MAX_LINES)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not count blank lines or comments against the limit", () => {
    const root = tmpRoot();
    try {
      const file = join(root, "commented.ts");
      // Code at exactly the cap, padded with the comment shapes agents.md
      // requires (// lines, /** */ blocks) plus blanks: still compliant.
      const comments = "// why: some invariant\n/**\n * block comment line\n */\n\n".repeat(100);
      writeFileSync(file, comments + "const x = 1\n".repeat(SRC_MAX_LINES));
      expect(findOversizedFiles(root, SRC_MAX_LINES)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores docs markdown files even when long", () => {
    const root = tmpRoot();
    try {
      const docsDir = join(root, "docs");
      mkdirSync(docsDir);
      writeFileSync(join(docsDir, "long.md"), `${"line\n".repeat(SRC_MAX_LINES + 100)}`);
      expect(findOversizedFiles(root, SRC_MAX_LINES)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("test cap permits longer files under TEST_MAX_LINES", () => {
    const root = tmpRoot();
    try {
      const file = join(root, "fixture.test.ts");
      writeFileSync(file, `${"const x = 1\n".repeat(TEST_MAX_LINES)}`);
      expect(findOversizedFiles(root, TEST_MAX_LINES)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags test files that exceed TEST_MAX_LINES", () => {
    const root = tmpRoot();
    try {
      const file = join(root, "fixture.test.ts");
      writeFileSync(file, `${"const x = 1\n".repeat(TEST_MAX_LINES + 1)}`);
      expect(findOversizedFiles(root, TEST_MAX_LINES)).toEqual([
        { file, lines: TEST_MAX_LINES + 1, max: TEST_MAX_LINES },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
