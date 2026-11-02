import { readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Language, Parser } from "web-tree-sitter"
import { runsThroughBun } from "./cli-subprocess.js"
import { nativeAssetDir } from "./native-assets.js"

export type TreeSitterLanguage = "bash" | "javascript" | "typescript" | "tsx" | "python"

const parsers = new Map<TreeSitterLanguage, Parser>()
const parserLoads = new Map<TreeSitterLanguage, Promise<Parser>>()
let runtimeLoad: Promise<void> | null = null

/** Returns the packaged grammar name. Parser loading resolves real files, so the
 * package-name invariant cannot be observed through the production wrapper. */
export function treeSitterWasmFile(language: TreeSitterLanguage): string {
  return `tree-sitter-${language}.wasm`
}

function grammarSpecifier(language: TreeSitterLanguage): string {
  return `@vscode/tree-sitter-wasm/wasm/${treeSitterWasmFile(language)}`
}

function resolveWasm(asset: string): string {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  return fileURLToPath(new URL(asset, import.meta.url))
}

function nativeWasm(file: string): string | null {
  const nativeDir = runsThroughBun(process.execPath) ? null : nativeAssetDir()
  if (!nativeDir) return null
  const entries = readdirSync(nativeDir)
  if (entries.includes(file)) return join(nativeDir, file)
  const stem = file.slice(0, -".wasm".length)
  const hashedFile = new RegExp(`^${stem}-[a-z0-9]{8}\\.wasm$`)
  const matches = entries.filter((entry) => hashedFile.test(entry))
  if (matches.length === 0) throw new Error(`Missing ${file} in ${nativeDir}`)
  if (matches.length > 1) throw new Error(`Ambiguous ${file} in ${nativeDir}: ${matches.join(", ")}`)
  const match = matches[0]
  if (!match) throw new Error(`Missing ${file} in ${nativeDir}`)
  return join(nativeDir, match)
}

async function resolveWasmSpecifier(specifier: string, file: string): Promise<string> {
  const nativeAsset = nativeWasm(file)
  if (nativeAsset) return nativeAsset
  const { default: wasm } = await import(specifier, { with: { type: "wasm" } })
  return resolveWasm(wasm)
}

async function loadRuntime(): Promise<void> {
  if (runtimeLoad) return runtimeLoad
  runtimeLoad = (async () => {
    const runtimeSpecifier: string = "web-tree-sitter/tree-sitter.wasm"
    const runtimeWasm = await resolveWasmSpecifier(runtimeSpecifier, "tree-sitter.wasm")
    await Parser.init({ locateFile: () => runtimeWasm })
  })()
  try {
    await runtimeLoad
  } catch (error) {
    runtimeLoad = null
    throw error
  }
}

export async function loadTreeSitterParser(language: TreeSitterLanguage): Promise<Parser> {
  const loaded = parsers.get(language)
  if (loaded) return loaded
  const pending = parserLoads.get(language)
  if (pending) return pending

  const load = (async () => {
    await loadRuntime()
    const file = treeSitterWasmFile(language)
    const specifier: string = grammarSpecifier(language)
    const languageWasm = await resolveWasmSpecifier(specifier, file)
    const grammar = await Language.load(languageWasm)
    const parser = new Parser()
    parser.setLanguage(grammar)
    parsers.set(language, parser)
    return parser
  })()
  parserLoads.set(language, load)
  try {
    return await load
  } catch (error) {
    parserLoads.delete(language)
    throw error
  }
}

export function getTreeSitterParser(language: TreeSitterLanguage): Parser | null {
  return parsers.get(language) ?? null
}
