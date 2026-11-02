import { describe, expect, test } from "bun:test"

import { ASSET_CHUNK_BYTES } from "../../../src/protocol/modules/remote/relay-protocol.js"
import { CLIENT_CACHE_LIMITS, clientFileType, newestClientIdentity, readClientAsset, storeClientAsset, type ClientCacheStorage } from "./client-cache.js"

/** The relay's client cache, over an in-memory stand-in for Durable Object
 *  storage that enforces the two limits the edge has and local workerd does
 *  not: at most 128 keys per call, and no row larger than one chunk. */

function memoryStorage() {
  const rows = new Map<string, unknown>()
  const calls: string[] = []
  const bounded = (keys: readonly string[]) => {
    if (keys.length > 128) throw new Error("more than 128 keys in one call")
  }
  const storage: ClientCacheStorage = {
    async get(keys: string[]) {
      bounded(keys)
      calls.push(`get ${keys.length}`)
      const found = new Map<string, unknown>()
      for (const key of keys) if (rows.has(key)) found.set(key, rows.get(key))
      return found
    },
    async put(entries: { readonly [key: string]: unknown }) {
      bounded(Object.keys(entries))
      calls.push(`put ${Object.keys(entries).length}`)
      for (const [key, value] of Object.entries(entries)) {
        if (value instanceof Uint8Array && value.byteLength > ASSET_CHUNK_BYTES) throw new Error("row over the per-row limit")
        rows.set(key, value)
      }
    },
    async delete(keys: string[]) {
      bounded(keys)
      let deleted = 0
      for (const key of keys) if (rows.delete(key)) deleted += 1
      return deleted
    },
    async list(options: { readonly prefix: string }) {
      const found = new Map<string, unknown>()
      for (const [key, value] of rows) if (key.startsWith(options.prefix)) found.set(key, value)
      return found
    },
  }
  return { storage, rows, calls }
}

const A = "a".repeat(64)
const B = "b".repeat(64)
const C = "c".repeat(64)
/** Every test identity stays announced unless a test says otherwise. */
const ALL = new Set([A, B, C])

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) out[index] = (index * 31 + seed) % 251
  return out
}

function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

describe("the relay's client cache", () => {
  test("round-trips a file across chunk boundaries whatever sizes the frames arrived in", async () => {
    const { storage, calls } = memoryStorage()
    const file = bytes(ASSET_CHUNK_BYTES * 2 + 12_345, 7)
    // The machine's frames need not line up with the rows: one small frame,
    // then one frame that spans a row boundary.
    const frames = [file.subarray(0, 1000), file.subarray(1000, ASSET_CHUNK_BYTES + 5000), file.subarray(ASSET_CHUNK_BYTES + 5000)]
    expect(await storeClientAsset(storage, A, "webview.js", frames, ALL)).toBe(true)
    // The head, three chunk rows, and the newest-identity row, in one write.
    expect(calls.filter((call) => call.startsWith("put"))).toEqual(["put 5"])
    const cached = await readClientAsset(storage, A, "webview.js")
    expect(cached?.every((chunk) => chunk.byteLength <= ASSET_CHUNK_BYTES)).toBe(true)
    expect(joined(cached ?? [])).toEqual(file)
  })

  test("stores an exact multiple of the chunk size and an empty file", async () => {
    const { storage } = memoryStorage()
    const exact = bytes(ASSET_CHUNK_BYTES * 2, 3)
    await storeClientAsset(storage, A, "webview.js", [exact], ALL)
    expect((await readClientAsset(storage, A, "webview.js"))?.length).toBe(2)
    await storeClientAsset(storage, A, "webview.css", [], ALL)
    expect(await readClientAsset(storage, A, "webview.css")).toEqual([])
  })

  test("answers nothing for a file it never stored or whose rows are torn", async () => {
    const { storage, rows } = memoryStorage()
    expect(await readClientAsset(storage, A, "webview.js")).toBeUndefined()
    await storeClientAsset(storage, A, "webview.js", [bytes(ASSET_CHUNK_BYTES + 1, 1)], ALL)
    for (const key of rows.keys()) if (key.endsWith(":0001")) rows.delete(key)
    expect(await readClientAsset(storage, A, "webview.js")).toBeUndefined()
  })

  test("keeps the identities it is told to keep and drops every other", async () => {
    const { storage } = memoryStorage()
    for (const identity of [A, B, C]) {
      await storeClientAsset(storage, identity, "webview.js", [bytes(10, 1)], ALL)
      await storeClientAsset(storage, identity, "webview.css", [bytes(10, 2)], ALL)
    }
    // Storing C's file again while only A is announced drops B.
    await storeClientAsset(storage, C, "webview.css", [bytes(10, 2)], new Set([A]))
    expect(await readClientAsset(storage, A, "webview.js")).toBeDefined()
    expect(await readClientAsset(storage, B, "webview.js")).toBeUndefined()
    expect(await readClientAsset(storage, B, "webview.css")).toBeUndefined()
    expect(await readClientAsset(storage, C, "webview.css")).toBeDefined()
  })

  test("evicts more rows than one storage call may name", async () => {
    const { storage, rows } = memoryStorage()
    // A runtime before the cache limits could leave this many rows.
    for (let index = 0; index < 200; index += 1) rows.set(`asset:${B}:file-${index}.js:0000`, bytes(1, index))
    await storeClientAsset(storage, A, "webview.js", [bytes(1, 1)], new Set())
    expect([...rows.keys()].filter((key) => key.includes(B))).toEqual([])
  })

  test("names the identity it stored most recently, which eviction always keeps", async () => {
    const { storage } = memoryStorage()
    expect(await newestClientIdentity(storage)).toBeUndefined()
    await storeClientAsset(storage, A, "webview.js", [bytes(10, 1)], ALL)
    await storeClientAsset(storage, B, "webview.js", [bytes(10, 2)], ALL)
    expect(await newestClientIdentity(storage)).toBe(B)
    await storeClientAsset(storage, B, "webview.css", [bytes(10, 2)], new Set())
    expect(await newestClientIdentity(storage)).toBe(B)
    expect(await readClientAsset(storage, A, "webview.js")).toBeUndefined()
  })

  test("refuses a file that would take one runtime's cache past its byte or file limit, and stores nothing of it", async () => {
    const { storage, rows } = memoryStorage()
    const identities = Array.from({ length: CLIENT_CACHE_LIMITS.files / 2 + 1 }, (_, index) => index.toString(16).padStart(64, "0"))
    const announced = new Set(identities)
    // Every identity but the last fills two files, which reaches the file limit.
    for (const identity of identities.slice(0, -1)) {
      expect(await storeClientAsset(storage, identity, "webview.js", [bytes(10, 1)], announced)).toBe(true)
      expect(await storeClientAsset(storage, identity, "webview.css", [bytes(10, 2)], announced)).toBe(true)
    }
    const before = new Map(rows)
    expect(await storeClientAsset(storage, identities.at(-1)!, "webview.js", [bytes(10, 3)], announced)).toBe(false)
    expect(rows).toEqual(before)
    // The same file again replaces its own rows, so it fits.
    expect(await storeClientAsset(storage, identities[0]!, "webview.js", [bytes(10, 4)], announced)).toBe(true)

    // Bytes: a file that, with what is kept, passes the byte limit.
    const big = memoryStorage()
    const half = bytes(CLIENT_CACHE_LIMITS.bytes / 2, 5)
    expect(await storeClientAsset(big.storage, A, "webview.js", [half], ALL)).toBe(true)
    expect(await storeClientAsset(big.storage, B, "webview.js", [half], ALL)).toBe(true)
    expect(await storeClientAsset(big.storage, C, "webview.css", [bytes(1, 6)], ALL)).toBe(false)
    expect(await readClientAsset(big.storage, C, "webview.css")).toBeUndefined()
    // Once A is no longer announced, its bytes go first and C fits.
    expect(await storeClientAsset(big.storage, C, "webview.css", [bytes(1, 6)], new Set([B]))).toBe(true)
  })

  test("types only the phone shell's two files, by name", () => {
    expect(clientFileType("webview.js")).toBe("text/javascript; charset=utf-8")
    expect(clientFileType("webview.css")).toBe("text/css; charset=utf-8")
    for (const file of ["index.html", "webview.html", "evil.js", "webview.svg", "webview.wasm", "webview.js.map", "WEBVIEW.JS"]) expect(clientFileType(file)).toBeUndefined()
  })
})
