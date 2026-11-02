import { Schema } from "effect"
import { SessionContentReferenceSchema, SessionContentManifestReferenceSchema, SESSION_CONTENT_WINDOW_BYTES } from "./session-content-schema.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const SESSION_CONTENT_NODE_BYTES = 64 * 1024
export const SESSION_CONTENT_STAGE_BYTES = 1024 * 1024
const MAX_CHILDREN = 128

export type SessionContentReference = typeof SessionContentReferenceSchema.Type
const LinkSchema = Schema.Struct({ sha256: Hash, bytes: Count, entries: Count })
type Link = typeof LinkSchema.Type
export const SessionContentNodeSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("records"), records: Schema.Array(Schema.String) }),
  Schema.Struct({ version: Schema.Literal(1), kind: Schema.Literal("index"), tree: Schema.Literals(["text", "records"]), children: Schema.Array(LinkSchema) }),
])
export type SessionContentNode = typeof SessionContentNodeSchema.Type
export const SessionContentNodeRowSchema = Schema.Struct({ sha256: Hash, node: SessionContentNodeSchema })
export type SessionContentNodeRow = typeof SessionContentNodeRowSchema.Type
export type StageSessionContentNodes = (nodes: readonly SessionContentNodeRow[]) => Promise<void>
// oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: immutable stored nodes must reach the shared hash and length validator, including malformed bytes.
export type ReadSessionContentNode = (sha256: string) => Promise<unknown | null>
export type SessionContentManifestReference = typeof SessionContentManifestReferenceSchema.Type
export interface SessionContentUnavailable { readonly kind: "unavailable"; readonly reason: "missing" | "corrupt" }
export type SessionContentRange = SessionContentUnavailable | {
  readonly kind: "available"
  readonly offset: number
  /** Raw bytes preserve partial UTF-8 characters across range boundaries. */
  readonly base64: string
  readonly nextOffset: number | null
}
export type SessionContentRecords = SessionContentUnavailable | {
  readonly kind: "available"; readonly records: readonly string[]; readonly nextOffset: number | null
}
const decodeNode = Schema.decodeUnknownSync(SessionContentNodeSchema, { onExcessProperty: "error" })
const decodeRow = Schema.decodeUnknownSync(SessionContentNodeRowSchema, { onExcessProperty: "error" })
const decodeReference = Schema.decodeUnknownSync(SessionContentReferenceSchema, { onExcessProperty: "error" })
const decodeManifest = Schema.decodeUnknownSync(SessionContentManifestReferenceSchema, { onExcessProperty: "error" })
const hashOf = (value: string | Uint8Array): string => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))
const recordsResponseBytes = (records: readonly string[], nextOffset: number): number =>
  encodedBytes({ kind: "available", records, nextOffset })

function measureNode(node: SessionContentNode, encoded = JSON.stringify(node)): Pick<Link, "bytes" | "entries"> {
  if (Buffer.byteLength(encoded) > SESSION_CONTENT_NODE_BYTES) throw new Error("Session content node exceeds its encoded limit")
  if (node.kind === "text") {
    if (!node.text.isWellFormed()) throw new Error("Session content must be strict UTF-8")
    return { bytes: Buffer.byteLength(node.text), entries: 0 }
  }
  if (node.kind === "records") {
    if (node.records.length > MAX_CHILDREN || node.records.some(record => !record.isWellFormed())) throw new Error("Invalid session content records")
    if (recordsResponseBytes(node.records, Number.MAX_SAFE_INTEGER) > SESSION_CONTENT_NODE_BYTES) throw new Error("Session content records exceed their response limit")
    return { bytes: node.records.reduce((sum, record) => sum + Buffer.byteLength(record), 0), entries: node.records.length }
  }
  if (node.children.length === 0 || node.children.length > MAX_CHILDREN) throw new Error("Invalid session content index")
  const bytes = node.children.reduce((sum, child) => sum + child.bytes, 0)
  const entries = node.children.reduce((sum, child) => sum + child.entries, 0)
  if (!Number.isSafeInteger(bytes) || !Number.isSafeInteger(entries)) throw new Error("Session content size is not a safe integer")
  if (node.children.some(child => child.bytes === 0 && child.entries === 0)) throw new Error("Empty session content index child")
  if (node.tree === "text" && entries !== 0) throw new Error("Text index contains records")
  return { bytes, entries }
}

/** Admit a node at the state writer. Validate strict shape, encoded size, local
 * lengths and canonical JSON hash. Referenced children require closure proof. */
export function parseSessionContentNodeRow(value: unknown): SessionContentNodeRow {
  const row = decodeRow(value)
  measureNode(row.node)
  if (hashOf(JSON.stringify(row.node)) !== row.sha256) throw new Error("Session content node hash mismatch")
  return row
}

// oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: writer closure proof validates raw stored nodes before admitting references.
export type ReadSessionContentNodeSync = (sha256: string) => unknown | null

function* completeLeaves(link: Link, tree: "text" | "records", read: ReadSessionContentNodeSync): Generator<SessionContentNode> {
  const raw = read(link.sha256)
  if (raw === null) throw new Unavailable("missing")
  const { node } = parseSessionContentNodeRow({ sha256: link.sha256, node: raw })
  const size = measureNode(node)
  if (size.bytes !== link.bytes || size.entries !== link.entries || (node.kind === "index" ? node.tree : node.kind) !== tree) {
    throw new Unavailable("corrupt")
  }
  if (node.kind === "index") {
    for (const child of node.children) yield* completeLeaves(child, tree, read)
  } else yield node
}

/** Admit an index only after its measured children have been staged. */
export function assertSessionContentNodeChildren(row: SessionContentNodeRow, read: ReadSessionContentNodeSync): void {
  if (row.node.kind !== "index") return
  for (const child of row.node.children) {
    const raw = read(child.sha256)
    if (raw === null) throw new Unavailable("missing")
    const { node } = parseSessionContentNodeRow({ sha256: child.sha256, node: raw })
    const size = measureNode(node)
    if (size.bytes !== child.bytes || size.entries !== child.entries || (node.kind === "index" ? node.tree : node.kind) !== row.node.tree) {
      throw new Unavailable("corrupt")
    }
  }
}

/** Synchronous closure proof for the writer's SQLite transaction. */
export function assertSessionContentReferenceSync(reference: SessionContentReference, read: ReadSessionContentNodeSync): void {
  const ref = decodeReference(reference)
  const hasher = new Bun.CryptoHasher("sha256")
  for (const node of completeLeaves({ sha256: ref.root, bytes: ref.bytes, entries: 0 }, "text", read)) {
    if (node.kind !== "text") throw new Unavailable("corrupt")
    hasher.update(node.text)
  }
  if (hasher.digest("hex") !== ref.sha256) throw new Unavailable("corrupt")
}

/** Prove every manifest page and inspect records without materializing the manifest. */
export function assertSessionContentManifestSync(
  reference: SessionContentManifestReference, read: ReadSessionContentNodeSync, record?: (value: string) => void,
): void {
  const ref = decodeManifest(reference)
  for (const node of completeLeaves({ sha256: ref.root, bytes: ref.bytes, entries: ref.entries }, "records", read)) {
    if (node.kind !== "records") throw new Unavailable("corrupt")
    if (record) for (const value of node.records) record(value)
  }
}

async function stageNode(node: SessionContentNode, stage: StageSessionContentNodes): Promise<Link> {
  const canonical = decodeNode(node)
  const encoded = JSON.stringify(canonical)
  const size = measureNode(canonical, encoded)
  const sha256 = hashOf(encoded)
  await stage([{ sha256, node: canonical }])
  return { sha256, ...size }
}

async function indexTree(leaves: Link[], tree: "text" | "records", stage: StageSessionContentNodes): Promise<Link> {
  let links = leaves
  while (links.length > 1) {
    const parents: Link[] = []
    for (let offset = 0; offset < links.length; offset += MAX_CHILDREN) {
      parents.push(await stageNode({ version: 1, kind: "index", tree, children: links.slice(offset, offset + MAX_CHILDREN) }, stage))
    }
    links = parents
  }
  const root = links[0]
  if (!root) throw new Error("Session content tree has no root")
  return root
}

/** Stage immutable UTF-8 leaves before their indexes. Reject malformed Unicode.
 * The returned root is not a durable settlement; the writer must prove its closure. */
export async function buildSessionContent(text: string, stage: StageSessionContentNodes): Promise<SessionContentReference> {
  if (!text.isWellFormed()) throw new Error("Session content must be strict UTF-8")
  const bytes = Buffer.from(text, "utf8")
  const leaves: Link[] = []
  let previous: { bytes: Buffer; link: Link } | undefined
  const textBudget = SESSION_CONTENT_NODE_BYTES - encodedBytes({ version: 1, kind: "text", text: "" })
  for (let offset = 0; offset < bytes.length;) {
    if (previous && bytes.subarray(offset, offset + previous.bytes.length).equals(previous.bytes)) {
      leaves.push(previous.link)
      offset += previous.bytes.length
      continue
    }
    let end = offset
    let encoded = 0
    const limit = Math.min(bytes.length, offset + SESSION_CONTENT_WINDOW_BYTES)
    while (end < limit) {
      const byte = bytes.readUInt8(end)
      const size = byte === 34 || byte === 92 ? 2
        : byte >= 32 ? 1
        : byte === 8 || byte === 9 || byte === 10 || byte === 12 || byte === 13 ? 2 : 6
      if (encoded + size > textBudget) break
      encoded += size
      end += 1
    }
    while (end < bytes.length && (bytes.readUInt8(end) & 0xc0) === 0x80) end -= 1
    const chunk = bytes.subarray(offset, end)
    const link = await stageNode({ version: 1, kind: "text", text: chunk.toString("utf8") }, stage)
    previous = { bytes: chunk, link }
    leaves.push(link)
    offset = end
  }
  if (leaves.length === 0) leaves.push(await stageNode({ version: 1, kind: "text", text: "" }, stage))
  const root = await indexTree(leaves, "text", stage)
  return { version: 1, root: root.sha256, bytes: bytes.length, sha256: hashOf(bytes) }
}

/** Build measured record pages. Records are opaque strings, not text-content patches.
 * A record that cannot fit one bounded leaf is refused, never truncated. */
export async function buildSessionContentManifest(records: Iterable<string>, stage: StageSessionContentNodes): Promise<SessionContentManifestReference> {
  const leaves: Link[] = []
  let page: string[] = []
  // A JSON array of k encoded records costs its empty encoding plus every record
  // plus k - 1 commas. A running sum keeps admission exact and O(1) per record;
  // stageNode still measures each closed page in full.
  const emptyNodeBytes = encodedBytes({ version: 1, kind: "records", records: [] })
  const emptyResponseBytes = recordsResponseBytes([], Number.MAX_SAFE_INTEGER)
  const emptyPageBytes = Math.max(emptyNodeBytes, emptyResponseBytes)
  let pageRecordBytes = 0
  for (const record of records) {
    const recordBytes = encodedBytes(record)
    if (page.length > 0 && (page.length === MAX_CHILDREN || emptyPageBytes + pageRecordBytes + recordBytes + page.length > SESSION_CONTENT_NODE_BYTES)) {
      leaves.push(await stageNode({ version: 1, kind: "records", records: page }, stage))
      page = []
      pageRecordBytes = 0
    }
    if (!record.isWellFormed()) throw new Error("Invalid session content records")
    if (page.length === 0) {
      if (emptyNodeBytes + recordBytes > SESSION_CONTENT_NODE_BYTES) throw new Error("Session content node exceeds its encoded limit")
      if (emptyResponseBytes + recordBytes > SESSION_CONTENT_NODE_BYTES) throw new Error("Session content records exceed their response limit")
    }
    page.push(record)
    pageRecordBytes += recordBytes
  }
  if (page.length > 0 || leaves.length === 0) leaves.push(await stageNode({ version: 1, kind: "records", records: page }, stage))
  const root = await indexTree(leaves, "records", stage)
  return { version: 1, root: root.sha256, bytes: root.bytes, entries: root.entries }
}

class Unavailable extends Error {
  constructor(readonly reason: "missing" | "corrupt") { super("Change evidence is unavailable") }
}

async function loadNode(link: Link, tree: "text" | "records", read: ReadSessionContentNode): Promise<SessionContentNode> {
  const raw = await read(link.sha256)
  if (raw === null) throw new Unavailable("missing")
  try {
    const { node } = parseSessionContentNodeRow({ sha256: link.sha256, node: raw })
    const size = measureNode(node)
    if (size.bytes !== link.bytes || size.entries !== link.entries) throw new Error("Node identity mismatch")
    if ((node.kind === "index" ? node.tree : node.kind) !== tree) throw new Error("Wrong tree kind")
    return node
  } catch {
    throw new Unavailable("corrupt")
  }
}

async function copyTree(link: Link, tree: "text" | "records", read: ReadSessionContentNode, stage: StageSessionContentNodes): Promise<void> {
  const node = await loadNode(link, tree, read)
  if (node.kind === "index") for (const child of node.children) await copyTree(child, tree, read, stage)
  await stage([{ sha256: link.sha256, node }])
}

/** Stage the exact nodes of one text tree that `read` holds through `stage`,
 * children before parents, so a fact in another session can prove the same
 * reference. Missing or invalid nodes throw unavailable and stage no root. */
export async function copySessionContent(reference: SessionContentReference, read: ReadSessionContentNode, stage: StageSessionContentNodes): Promise<void> {
  const ref = decodeReference(reference)
  await copyTree({ sha256: ref.root, bytes: ref.bytes, entries: 0 }, "text", read, stage)
}

async function* selectedLeaves(link: Link, tree: "text" | "records", start: number, end: number, read: ReadSessionContentNode): AsyncGenerator<{ node: SessionContentNode; start: number; end: number }> {
  const node = await loadNode(link, tree, read)
  if (node.kind !== "index") {
    yield { node, start, end }
    return
  }
  let offset = 0
  for (const child of node.children) {
    const size = tree === "text" ? child.bytes : child.entries
    if (offset < end && offset + size > start) {
      yield* selectedLeaves(child, tree, Math.max(0, start - offset), Math.min(size, end - offset), read)
    }
    offset += size
  }
}

function validateRange(offset: number, length: number, total: number, maximum: number): number {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || offset > total || length < 0 || length > maximum) throw new Error("Invalid session content range")
  return Math.min(total, offset + length)
}

/** Read at most 64 KiB of exact logical bytes. Partial characters stay raw base64.
 * Missing or invalid selected nodes return unavailable. Read-service failures propagate. */
export async function readSessionContentRange(reference: SessionContentReference, offset: number, length: number, read: ReadSessionContentNode): Promise<SessionContentRange> {
  const ref = decodeReference(reference)
  const end = validateRange(offset, length, ref.bytes, SESSION_CONTENT_WINDOW_BYTES)
  try {
    const parts: Buffer[] = []
    for await (const leaf of selectedLeaves({ sha256: ref.root, bytes: ref.bytes, entries: 0 }, "text", offset, end, read)) {
      if (leaf.node.kind !== "text") throw new Unavailable("corrupt")
      parts.push(Buffer.from(leaf.node.text).subarray(leaf.start, leaf.end))
    }
    const bytes = Buffer.concat(parts)
    if (bytes.length !== end - offset || (offset === 0 && end === ref.bytes && hashOf(bytes) !== ref.sha256)) throw new Unavailable("corrupt")
    return { kind: "available", offset, base64: bytes.toString("base64"), nextOffset: end < ref.bytes ? end : null }
  } catch (error) {
    if (error instanceof Unavailable) return { kind: "unavailable", reason: error.reason }
    throw error
  }
}

/** Seek by record ordinal without fetching unrelated leaves. Encoded response data
 * stays within 64 KiB; nextOffset identifies the first record not returned. */
export async function readSessionContentRecords(reference: SessionContentManifestReference, offset: number, limit: number, read: ReadSessionContentNode): Promise<SessionContentRecords> {
  const ref = decodeManifest(reference)
  const end = validateRange(offset, limit, ref.entries, MAX_CHILDREN)
  try {
    const records: string[] = []
    for await (const leaf of selectedLeaves({ sha256: ref.root, bytes: ref.bytes, entries: ref.entries }, "records", offset, end, read)) {
      if (leaf.node.kind !== "records") throw new Unavailable("corrupt")
      for (const record of leaf.node.records.slice(leaf.start, leaf.end)) {
        if (recordsResponseBytes([...records, record], offset + records.length + 1) > SESSION_CONTENT_NODE_BYTES) {
          if (records.length === 0) throw new Unavailable("corrupt")
          return { kind: "available", records, nextOffset: offset + records.length }
        }
        records.push(record)
      }
    }
    if (records.length !== end - offset) throw new Unavailable("corrupt")
    return { kind: "available", records, nextOffset: end < ref.entries ? end : null }
  } catch (error) {
    if (error instanceof Unavailable) return { kind: "unavailable", reason: error.reason }
    throw error
  }
}

