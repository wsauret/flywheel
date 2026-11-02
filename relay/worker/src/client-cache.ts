import { ASSET_CHUNK_BYTES } from "../../../src/protocol/modules/remote/relay-protocol.js"

/** The client files a runtime's Durable Object has streamed from its machine,
 *  kept so a phone with a cold cache still loads the client while the machine
 *  is asleep (POC 10).
 *
 *  One file is one head row and its chunk rows: `asset:<identity>:<file>:head`
 *  holds the chunk count, `asset:<identity>:<file>:0000` onward hold at most
 *  one chunk of bytes each. The edge refuses a row over 2 MB and local
 *  workerd does not, so no row may depend on a file's size. Every row of a
 *  file is written in one `put`, and the head names every chunk, so a read
 *  finds a whole file or nothing. The same `put` records the identity as the
 *  newest stored, which the relay answers for a runtime with no machine
 *  connected.
 *
 *  Anyone can mint a runtime identity, so the cache serves and keeps only
 *  what a real phone shell is: the files below, typed by the relay, within
 *  the limits below. */

/** The phone shell's files and the one type each is served with.
 *  `webview/build.ts` emits every file of a host shell as `webview.<ext>`,
 *  and the phone shell is these two (2.4 MB of script and 124 KB of style on
 *  2026-10-27). The relay types a file by its name, never by what the
 *  machine says, and serves no other name, so no runtime can make the
 *  relay's domain host a page, an image, or a download. A new file in the
 *  phone shell needs a line here, deployed before the build that emits it. */
const CLIENT_FILE_TYPES: ReadonlyMap<string, string> = new Map([
  ["webview.js", "text/javascript; charset=utf-8"],
  ["webview.css", "text/css; charset=utf-8"],
])

/** The type the relay serves `file` with, or nothing for a file it never serves. */
export function clientFileType(file: string): string | undefined {
  return CLIENT_FILE_TYPES.get(file)
}

/** The largest client file the relay streams or keeps: 3.4 times the 2.4 MB
 *  script of the phone shell today. */
export const CLIENT_FILE_MAX_BYTES = 8 * 1024 * 1024

/** What one runtime's cache may hold. A machine keeps one identity per lane
 *  it announces (an installed build and a development lane are two), and one
 *  phone shell is two files and about 2.6 MB, so these hold eight shells by
 *  count and twelve by size. A file that would pass either limit is served
 *  but not kept. */
export const CLIENT_CACHE_LIMITS = { bytes: 32 * 1024 * 1024, files: 16 } as const

/** The slice of `DurableObjectStorage` the cache uses, so the rules above can
 *  be held to without a Worker runtime. Rows come back as `unknown`: the
 *  cache checks the shape of every row it reads. */
export interface ClientCacheStorage {
  get(keys: string[]): Promise<Map<string, unknown>>
  put(entries: { readonly [key: string]: unknown }): Promise<void>
  delete(keys: string[]): Promise<number>
  list(options: { readonly prefix: string }): Promise<Map<string, unknown>>
}

/** Rows written before 2026-10-27 also carry the type the machine named;
 *  the relay no longer reads it. */
interface HeadRow {
  readonly chunks: number
}

const PREFIX = "asset:"
/** Outside `PREFIX`, so eviction reads it apart from the file rows. */
const NEWEST_KEY = "asset-newest"
/** The most keys one storage call may name at the edge. */
const KEYS_PER_CALL = 128

const fileKey = (identity: string, file: string) => `${PREFIX}${identity}:${file}`
const identityOf = (key: string) => key.slice(PREFIX.length, key.indexOf(":", PREFIX.length))
const chunkKey = (identity: string, file: string, index: number) => `${fileKey(identity, file)}:${String(index).padStart(4, "0")}`

function isHeadRow(value: unknown): value is HeadRow {
  return typeof value === "object" && value !== null && "chunks" in value && typeof value.chunks === "number"
}

/** Cuts what arrived, in whatever frame sizes, into rows of at most one chunk. */
function rows(frames: readonly Uint8Array[]): Uint8Array[] {
  const total = frames.reduce((sum, frame) => sum + frame.byteLength, 0)
  const whole = new Uint8Array(total)
  let offset = 0
  for (const frame of frames) {
    whole.set(frame, offset)
    offset += frame.byteLength
  }
  const out: Uint8Array[] = []
  for (let start = 0; start < total; start += ASSET_CHUNK_BYTES) out.push(whole.slice(start, start + ASSET_CHUNK_BYTES))
  return out
}

function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let start = 0; start < items.length; start += size) out.push(items.slice(start, start + size))
  return out
}

/** Stores one whole file of `identity`, and drops every stored identity
 *  that is neither `identity` nor in `keep`. Stores nothing and answers
 *  false when the file would take the cache past `CLIENT_CACHE_LIMITS`.
 *
 *  It reads every row the cache holds to find what stays and what that
 *  costs. The limits bound that read, and a file is stored once per build,
 *  never per phone. */
export async function storeClientAsset(storage: ClientCacheStorage, identity: string, file: string, frames: readonly Uint8Array[], keep: ReadonlySet<string>): Promise<boolean> {
  const kept = new Set([...keep, identity])
  const replaced = `${fileKey(identity, file)}:`
  const stale: string[] = []
  let bytes = 0
  let files = 1
  for (const [key, value] of await storage.list({ prefix: PREFIX })) {
    if (!kept.has(identityOf(key))) stale.push(key)
    else if (key.startsWith(replaced)) continue
    else if (key.endsWith(":head")) files += 1
    else if (value instanceof Uint8Array) bytes += value.byteLength
  }
  const newest = await newestClientIdentity(storage)
  if (newest !== undefined && !kept.has(newest)) stale.push(NEWEST_KEY)
  for (const batch of batches(stale, KEYS_PER_CALL)) await storage.delete(batch)
  const chunks = rows(frames)
  bytes += chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  if (bytes > CLIENT_CACHE_LIMITS.bytes || files > CLIENT_CACHE_LIMITS.files) return false
  const head: HeadRow = { chunks: chunks.length }
  await storage.put(Object.fromEntries([[NEWEST_KEY, identity], [`${fileKey(identity, file)}:head`, head], ...chunks.map((chunk, index) => [chunkKey(identity, file, index), chunk] as const)]))
  return true
}

/** The identity whose file was stored most recently, or nothing before any was. */
export async function newestClientIdentity(storage: ClientCacheStorage): Promise<string | undefined> {
  const newest = (await storage.get([NEWEST_KEY])).get(NEWEST_KEY)
  return typeof newest === "string" ? newest : undefined
}

/** The chunks of one file of `identity` as it was stored, or nothing when it
 *  never was or its rows are not all there. */
export async function readClientAsset(storage: ClientCacheStorage, identity: string, file: string): Promise<readonly Uint8Array[] | undefined> {
  const headKey = `${fileKey(identity, file)}:head`
  const head = (await storage.get([headKey])).get(headKey)
  if (!isHeadRow(head)) return undefined
  const keys = Array.from({ length: head.chunks }, (_, index) => chunkKey(identity, file, index))
  const chunks: Uint8Array[] = []
  for (const batch of batches(keys, KEYS_PER_CALL)) {
    const found = await storage.get(batch)
    for (const key of batch) {
      const chunk = found.get(key)
      if (!(chunk instanceof Uint8Array)) return undefined
      chunks.push(chunk)
    }
  }
  return chunks
}
