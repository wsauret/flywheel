import { describe, expect, it } from "bun:test"

import { nativeAssetPathExpression, patchBundleScript } from "../../../scripts/bundle-asset-patch.js"

const canonicalAssetNames = new Set(["libopentui.dll", "libopentui.dylib", "tree-sitter.wasm"])

describe("bundle asset patch", () => {
  it("redirects split-bundle asset bindings to the native directory and canonical names", () => {
    const source = [
      `var tree_sitter_default = "./tree-sitter-abc12345.wasm";`,
      `var highlights_default = "./highlights-0a1b2c3d.scm";`,
      `var libopentui_default = "./libopentui-baxzgttp.dll";`,
    ].join("\n")

    const patched = patchBundleScript(source, { platformArch: "win32-x64", canonicalAssetNames })

    expect(patched.assetReferences).toBe(3)
    expect(patched.attributedChunkImports).toBe(0)
    expect([...patched.canonicalizedAssets].sort()).toEqual(["libopentui-baxzgttp.dll", "tree-sitter-abc12345.wasm"])
    expect(patched.source).not.toContain('"./')

    // Hashed references to canonical assets take the canonical name; every
    // other asset keeps its hashed name. The target arch, not the build host,
    // names the native directory.
    expect(patched.source.split("\n")).toEqual([
      `var tree_sitter_default = ${nativeAssetPathExpression("win32-x64", "tree-sitter.wasm")};`,
      `var highlights_default = ${nativeAssetPathExpression("win32-x64", "highlights-0a1b2c3d.scm")};`,
      `var libopentui_default = ${nativeAssetPathExpression("win32-x64", "libopentui.dll")};`,
    ])
  })

  it("builds the native path at runtime from the platform's own path module", () => {
    // The expression runs inside the executable, so it joins with the
    // platform's separators and never bakes in the build host's layout.
    expect(nativeAssetPathExpression("win32-x64", "libopentui.dll")).toBe(
      `require("path").join(process.env.FLYWHEEL_NATIVE_DIR || require("path").join(require("path").dirname(process.execPath), "native", "win32-x64"), "libopentui.dll")`,
    )
  })

  it("drops file and wasm import attributes from chunk imports so the compile stage loads them as code", () => {
    const source = [
      `var module = await import("./chunk-dakzpg8p.js", { with: { type: "file" } });`,
      `return resolveBundledFilePath(KEY, () => import("./chunk-9ryxfnme.js", { with: { type: "wasm" } }), () => import.meta.resolve(KEY), import.meta.url);`,
      `import(specifier, { with: { type: "wasm" } })`,
      `var libopentui_default = "./libopentui-baxzgttp.dylib";`,
    ].join("\n")

    const patched = patchBundleScript(source, { platformArch: "darwin-arm64", canonicalAssetNames })

    expect(patched.attributedChunkImports).toBe(2)
    expect(patched.source).toContain(`await import("./chunk-dakzpg8p.js");`)
    expect(patched.source).toContain(`() => import("./chunk-9ryxfnme.js"),`)
    // A runtime-computed specifier is not a chunk the bundler rewrote; its
    // attribute is the importer's own contract and stays.
    expect(patched.source).toContain(`import(specifier, { with: { type: "wasm" } })`)
  })
})
