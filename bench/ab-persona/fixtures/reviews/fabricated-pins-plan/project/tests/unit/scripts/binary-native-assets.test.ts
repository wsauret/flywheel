import { describe, expect, it } from "bun:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  nativeEnv,
  nativeRuntimePackages,
  platformArchForTarget,
  resolveRipgrepStagingPath,
  targetNativePackagesToInstall,
  TREE_SITTER_WASM_FILES,
} from "../../../scripts/binary-native-assets.js";

describe("ripgrep staging output boundary", () => {
  const root = resolve("/repo");

  it("derives the canonical addon filename inside dist staging", () => {
    expect(resolveRipgrepStagingPath(root, "dist/flywheel-linux-x64/build/native/linux-x64", "linux-x64")).toBe(
      join(root, "dist", "flywheel-linux-x64", "build", "native", "linux-x64", "flywheel-ripgrep.linux-x64.node"),
    );
  });

  it("refuses lexical escapes and absolute paths outside dist", () => {
    expect(() => resolveRipgrepStagingPath(root, "dist/../crates/ripgrep", "linux-x64")).toThrow(/dist/);
    expect(() => resolveRipgrepStagingPath(root, "/outside/native", "linux-x64")).toThrow(/dist/);
  });
});

describe("binary native asset target mapping", () => {
  it("normalizes Bun Windows targets to npm win32 package names", () => {
    expect(platformArchForTarget("bun-windows-x64")).toBe("win32-x64");
    expect(platformArchForTarget("bun-windows-arm64")).toBe("win32-arm64");
  });

  it("preserves Linux musl target suffixes", () => {
    expect(platformArchForTarget("bun-linux-x64-musl")).toBe("linux-x64-musl");
  });

  it("includes Windows sharp runtime packages", () => {
    expect(nativeRuntimePackages("win32-x64")).toContain("@img/sharp-win32-x64");
    expect(nativeRuntimePackages("win32-x64")).toContain("@img/sharp-libvips-win32-x64");
  });

  it("publishes the native asset directory without a package-specific override", () => {
    expect(nativeEnv("C:/flywheel/native")).toEqual({ FLYWHEEL_NATIVE_DIR: "C:/flywheel/native" });
  });

  it("ships every semantic parser grammar under a canonical name", () => {
    expect(TREE_SITTER_WASM_FILES).toEqual([
      "tree-sitter.wasm",
      "tree-sitter-bash.wasm",
      "tree-sitter-javascript.wasm",
      "tree-sitter-typescript.wasm",
      "tree-sitter-tsx.wasm",
    ]);
  });

  it("replaces a target package whose version does not match its runtime dependency", async () => {
    const root = mkdtempSync(join("/tmp", "flywheel-native-packages-"));
    const writePackage = (name: string, version: string, optionalDependencies?: { [key: string]: string }) => {
      const packageDir = join(root, "node_modules", ...name.split("/"));
      mkdirSync(packageDir, { recursive: true });
      writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name, version, optionalDependencies }));
    };

    try {
      writePackage("@opentui/core", "0.5.1", { "@opentui/core-win32-x64": "0.5.1" });
      writePackage("sharp", "0.35.3", {
        "@img/sharp-win32-x64": "0.35.3",
        "@img/sharp-libvips-win32-x64": "1.2.4",
      });
      writePackage("@opentui/core-win32-x64", "0.2.15");
      writePackage("@img/sharp-win32-x64", "0.35.3");
      writePackage("@img/sharp-libvips-win32-x64", "1.2.4");

      expect(await targetNativePackagesToInstall(root, "win32-x64")).toEqual([
        { name: "@opentui/core-win32-x64", version: "0.5.1" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
