import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findNonKebabFiles } from "../../../scripts/check-filenames.js";

function tmpRoot(): string {
  return mkdtempSync("/tmp/flywheel-filenames-");
}

describe("check-filenames", () => {
  it("flags a camelCase source file", () => {
    const root = tmpRoot();
    try {
      const file = join(root, "myModule.ts");
      writeFileSync(file, "export const x = 1\n");
      expect(findNonKebabFiles(root)).toEqual([{ file, base: "myModule" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("flags a snake_case source file", () => {
    const root = tmpRoot();
    try {
      const file = join(root, "my_module.ts");
      writeFileSync(file, "export const x = 1\n");
      expect(findNonKebabFiles(root)).toEqual([{ file, base: "my_module" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts kebab-case .ts and .tsx files", () => {
    const root = tmpRoot();
    try {
      writeFileSync(join(root, "event-bus.ts"), "export const x = 1\n");
      writeFileSync(join(root, "tabs-bar.tsx"), "export const y = 1\n");
      expect(findNonKebabFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("strips compound extensions before checking the stem", () => {
    const root = tmpRoot();
    try {
      writeFileSync(join(root, "vendor.d.ts"), "export {}\n");
      writeFileSync(join(root, "thing.test.ts"), "export const x = 1\n");
      expect(findNonKebabFiles(root)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recurses into subdirectories", () => {
    const root = tmpRoot();
    try {
      const sub = join(root, "nested");
      mkdirSync(sub);
      const file = join(sub, "BadName.ts");
      writeFileSync(file, "export const x = 1\n");
      expect(findNonKebabFiles(root)).toEqual([{ file, base: "BadName" }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
