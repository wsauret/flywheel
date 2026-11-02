import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findNonKebabFiles } from "../../../scripts/check-filenames.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

function tmpRoot(): string {
  return temporaryDirectory("flywheel-filenames-");
}

describe("check-filenames", () => {
  it("flags a snake_case source file", () => {
    const root = tmpRoot();
    const file = join(root, "my_module.ts");
    writeFileSync(file, "export const x = 1\n");
    expect(findNonKebabFiles(root)).toEqual([{ file, base: "my_module" }]);
  });

  it("accepts kebab-case .ts and .tsx files", () => {
    const root = tmpRoot();
    writeFileSync(join(root, "event-bus.ts"), "export const x = 1\n");
    writeFileSync(join(root, "tabs-bar.tsx"), "export const y = 1\n");
    expect(findNonKebabFiles(root)).toEqual([]);
  });

  it("strips compound extensions before checking the stem", () => {
    const root = tmpRoot();
    writeFileSync(join(root, "vendor.d.ts"), "export {}\n");
    writeFileSync(join(root, "thing.test.ts"), "export const x = 1\n");
    expect(findNonKebabFiles(root)).toEqual([]);
  });

  it("recurses into subdirectories", () => {
    const root = tmpRoot();
    const sub = join(root, "nested");
    mkdirSync(sub);
    const file = join(sub, "BadName.ts");
    writeFileSync(file, "export const x = 1\n");
    expect(findNonKebabFiles(root)).toEqual([{ file, base: "BadName" }]);
  });
});
