import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { zstdDecompressSync } from "node:zlib"
import tokenizerFingerprint from "../../crates/tokenizer/tokenizer-prebuilt.json" with { type: "json" }
import { runsThroughBun } from "./cli-subprocess.js"
import type { ClaudeTokenizerIdentity } from "./llm/model-id.js"
import { nativeAssetDir } from "./native-assets.js"

const ARTIFACT_FILE = "flywheel-tokenizer.wasm.zst"
const SOURCE_ARTIFACT = fileURLToPath(new URL(`../../crates/tokenizer/${ARTIFACT_FILE}`, import.meta.url))
const ARTIFACT_PATH = runsThroughBun(process.execPath) ? SOURCE_ARTIFACT : join(nativeAssetDir(), ARTIFACT_FILE)
const Encoding = {
  O200k: 0,
  ClaudeV3: 1,
  ClaudeV47: 2,
  ClaudeV5: 3,
  ClaudeV5Sonnet: 4,
} as const

type Encoding = (typeof Encoding)[keyof typeof Encoding]

const ENCODING_IDENTITIES = ["O200kBase", "ClaudeV3", "ClaudeV47", "ClaudeV5", "ClaudeV5Sonnet"] as const

export type LocalTokenizerIdentity = (typeof ENCODING_IDENTITIES)[Encoding]

export interface LocalTokenizer {
  readonly identity: LocalTokenizerIdentity
  count(text: string): number
}

type TokenizerExports = {
  memory: WebAssembly.Memory
  allocate(length: number): number
  count(encoding: number, pointer: number, length: number): number
  release(pointer: number, length: number): void
}

let tokenizer: TokenizerExports | undefined
let preparation: Promise<void> | undefined

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

const O200K_MODEL_ENCODINGS: ReadonlyArray<RegExp> = [
  /^gpt-4o(?:-mini)?(?:-(?:20\d{6}|\d{4}-\d{2}-\d{2}))?$/,
  /^gpt-4\.(?:1|5)(?:$|-)/,
  /^gpt-5(?:\.[1-5])?(?:-(?:mini|nano|chat(?:-latest)?|pro))?(?:-(?:20\d{6}|\d{4}-\d{2}-\d{2}))?$/,
  /^gpt-(?:6-(?:luna|astra)|6\.1-sol)(?:-(?:20\d{6}|\d{4}-\d{2}-\d{2}))?$/,
  /^o1(?:-(?:mini|preview|pro))?(?:-(?:20\d{6}|\d{4}-\d{2}-\d{2}))?$/,
  /^o3(?:$|-)/,
  /^o4-mini(?:$|-)/,
]

const CLAUDE_ENCODINGS = {
  ClaudeV3: Encoding.ClaudeV3,
  ClaudeV47: Encoding.ClaudeV47,
  ClaudeV5: Encoding.ClaudeV5,
  ClaudeV5Sonnet: Encoding.ClaudeV5Sonnet,
} as const satisfies Readonly<{ [Identity in ClaudeTokenizerIdentity]: Encoding }>

function encodingForCanonicalModel(model: string, claudeIdentity?: ClaudeTokenizerIdentity): Encoding | undefined {
  if (claudeIdentity) return CLAUDE_ENCODINGS[claudeIdentity]
  return O200K_MODEL_ENCODINGS.some((pattern) => pattern.test(model)) ? Encoding.O200k : undefined
}

/**
 * Returns the typed exports of a compiled and instantiated tokenizer module, or throws
 * "Local tokenizer ABI mismatch" when it has imports, other exports, another memory size, or other function arities.
 */
export function checkedExports(module: WebAssembly.Module, instance: WebAssembly.Instance): TokenizerExports {
  if (WebAssembly.Module.imports(module).length !== 0) throw new Error("Local tokenizer ABI mismatch")
  const exports = WebAssembly.Module.exports(module)
  const expected = ["memory:memory", "allocate:function", "count:function", "release:function"]
  if (exports.map(({ name, kind }) => `${name}:${kind}`).join(",") !== expected.join(",")) {
    throw new Error("Local tokenizer ABI mismatch")
  }
  const memory = instance.exports["memory"]
  const allocate = instance.exports["allocate"]
  const count = instance.exports["count"]
  const release = instance.exports["release"]
  if (
    !(memory instanceof WebAssembly.Memory) ||
    !(memory.buffer instanceof ArrayBuffer) ||
    memory.buffer.byteLength !== 49 * 65_536 ||
    typeof allocate !== "function" || allocate.length !== 1 ||
    typeof count !== "function" || count.length !== 3 ||
    typeof release !== "function" || release.length !== 2
  ) {
    throw new Error("Local tokenizer ABI mismatch")
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: SAFETY: the digest-pinned Wasm ABI and export arities establish these native signatures.
  return { memory, allocate, count, release } as TokenizerExports
}

async function loadTokenizer(): Promise<void> {
  try {
    const compressed = await readFile(ARTIFACT_PATH)
    if (digest(compressed) !== tokenizerFingerprint.artifact.compressedSha256) throw new Error("digest")
    const wasm = zstdDecompressSync(compressed)
    if (digest(wasm) !== tokenizerFingerprint.artifact.wasmSha256) throw new Error("digest")
    const module = await WebAssembly.compile(wasm)
    const instance = await WebAssembly.instantiate(module, {})
    tokenizer = checkedExports(module, instance)
  } catch {
    throw new Error("Local tokenizer preparation failed")
  }
}

/** Loads and verifies the process-selected local tokenizer asset once. Concurrent callers share the same preparation. */
export async function prepareLocalTokenizer(): Promise<void> {
  preparation ??= loadTokenizer()
  try {
    await preparation
  } catch (error) {
    preparation = undefined
    throw error
  }
}

/** Counts local tokens for an approved canonical model ID, or returns undefined when the model has no approved mapping. */
export function localTokenizerForModel(canonicalModel: string, claudeIdentity?: ClaudeTokenizerIdentity): LocalTokenizer | undefined {
  const encoding = encodingForCanonicalModel(canonicalModel, claudeIdentity)
  if (encoding === undefined) return undefined
  return tokenizerForEncoding(encoding)
}

/** Counts O200kBase comparison tokens independently of a model. Requires explicit preparation. */
export function commonLocalTokenizer(): LocalTokenizer {
  return tokenizerForEncoding(Encoding.O200k)
}

function tokenizerForEncoding(encoding: Encoding): LocalTokenizer {
  if (!tokenizer) throw new Error("Local tokenizer is not prepared")
  const engine = tokenizer
  return {
    identity: ENCODING_IDENTITIES[encoding],
    count(text) {
      const units = text.length
      const pointer = engine.allocate(units)
      try {
        const memory = new Uint16Array(engine.memory.buffer, pointer, units)
        for (let index = 0; index < units; index += 1) memory[index] = text.charCodeAt(index)
        return engine.count(encoding, pointer, units)
      } finally {
        engine.release(pointer, units)
      }
    },
  }
}

/** Counts local tokens for an approved canonical model ID, or returns undefined when the model has no approved mapping. */
export function countLocalTokens(canonicalModel: string, text: string, claudeIdentity?: ClaudeTokenizerIdentity): number | undefined {
  return localTokenizerForModel(canonicalModel, claudeIdentity)?.count(text)
}
