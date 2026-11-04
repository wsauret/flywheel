// Rewrites one bundled script so its native asset references resolve next to
// the executable on disk instead of inside Bun's standalone-binary virtual FS.
//
// Bun.build() emits sibling wasm/scm/dylib/so/dll assets, and Worker scripts
// such as OpenTUI's tree-sitter parser worker, with hashed names and
// rewrites each asset import into a module-level string binding, e.g.
// `var tree_sitter_default = "./tree-sitter-abc.wasm";`. `bun build --compile`
// only embeds files referenced via `with { type: "file" }` in source, so the
// string-literal reference is not embedded and the relative path resolves to
// the mount root (missing) at runtime. The installer copies the assets next to
// the binary; this patch makes the runtime look there, at FLYWHEEL_NATIVE_DIR
// or <dirname(execPath)>/native/<platformArch>, through `path.join` so the
// expression is correct on every platform.

export interface BundleAssetPatchOptions {
  readonly platformArch: string
  /** Assets the native staging step places under their unhashed names. A
   *  hashed reference to one of these is pointed at the canonical name so the
   *  hashed duplicate need not ship. */
  readonly canonicalAssetNames: ReadonlySet<string>
}

export interface BundleAssetPatchResult {
  readonly source: string
  readonly assetReferences: number
  readonly attributedChunkImports: number
  /** Hashed asset names that were redirected to a canonical name. */
  readonly canonicalizedAssets: ReadonlySet<string>
}

// Bun numbers a binding (`highlights_default2`) when asset basenames collide.
const assetBindingPattern = /(var \w+_default\d* = )"\.\/([^"\\]+\.(?:wasm|scm|dylib|so|dll|js))"/g

// Splitting moves a dynamically imported asset into its own chunk but keeps
// the import attribute on the rewritten specifier, e.g.
// `import("./chunk-abc.js", { with: { type: "file" } })`. The compile stage
// would then embed that JavaScript chunk as an opaque file and hand its mount
// path to dlopen or the wasm loader. The chunk already exports the patched
// absolute path as its default, so the attribute is dropped and the chunk is
// imported as code.
const attributedChunkImportPattern = /import\("(\.\/chunk-[^"]+\.js)", \{ with: \{ type: "(?:file|wasm)" \} \}\)/g

// Every relative string binding Bun emits for a `type: "file"` import,
// whatever its extension.
const relativeAssetBindingPattern = /var \w+_default\d* = "(\.\/[^"\\]+)"/g

const hashedAssetPattern = /-[a-z0-9]{8}(\.[a-z0-9]+)$/

export function nativeAssetPathExpression(platformArch: string, name: string): string {
  const nativeDir = `process.env.FLYWHEEL_NATIVE_DIR || require("path").join(require("path").dirname(process.execPath), "native", ${JSON.stringify(platformArch)})`
  return `require("path").join(${nativeDir}, ${JSON.stringify(name)})`
}

export function patchBundleScript(source: string, options: BundleAssetPatchOptions): BundleAssetPatchResult {
  let assetReferences = 0
  let attributedChunkImports = 0
  const canonicalizedAssets = new Set<string>()
  const resolveAssetName = (name: string): string => {
    const canonical = name.replace(hashedAssetPattern, "$1")
    if (!options.canonicalAssetNames.has(canonical)) return name
    canonicalizedAssets.add(name)
    return canonical
  }
  const patched = source
    .replace(assetBindingPattern, (_match, binding: string, name: string) => {
      assetReferences++
      return `${binding}${nativeAssetPathExpression(options.platformArch, resolveAssetName(name))}`
    })
    .replace(attributedChunkImportPattern, (_match, specifier: string) => {
      attributedChunkImports++
      return `import(${JSON.stringify(specifier)})`
    })
  return { source: patched, assetReferences, attributedChunkImports, canonicalizedAssets }
}

/** The relative paths of file-asset bindings left in a patched script. Each
 *  one resolves inside the executable's virtual FS, where no asset exists, so
 *  any result means the asset never loads at runtime. */
export function unrewrittenAssetBindings(source: string): string[] {
  return [...source.matchAll(relativeAssetBindingPattern)].map((match) => match[1] ?? "")
}
