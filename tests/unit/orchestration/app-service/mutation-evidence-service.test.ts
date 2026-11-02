import { expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
import { Socket, SocketServer } from "effect/unstable/socket"
import { dirname, join, sep } from "node:path"
import { buildSessionContent, buildSessionContentManifest, readSessionContentRange, type SessionContentNode, type StageSessionContentNodes } from "../../../../src/infra/session-content.js"
import type { MutationEvidenceEntry } from "../../../../src/infra/mutation-evidence.js"
import { MutationFilesQuerySchema, MutationPatchWindowQuerySchema, MutationFilesResultSchema, MutationPatchWindowResultSchema, type MutationPatchWindowResult, type MutationFilesResult } from "../../../../src/protocol/mutation-evidence-protocol-types.js"
import { createMutationEvidenceService } from "../../../../src/orchestration/app-service/mutation-evidence-service.js"
import { runtimeProtocolSocketServer } from "../../../../src/orchestration/app-service/runtime-protocol-socket-server.js"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { fakeManager, fakeProjections, fakeSessionStore, runtimeSupervisor } from "./app-service-doubles.js"
import { durableRow, durableSessionFromCatalogRow } from "./_frontend-projection-fixtures.js"

function fixture() {
  const nodes = new Map<string, SessionContentNode>()
  const reads: Array<{ sessionId: string; hash: string }> = []
  const stage: StageSessionContentNodes = async rows => { for (const row of rows) nodes.set(row.sha256, row.node) }
  const readNode = async (sessionId: string, hash: string) => {
    reads.push({ sessionId, hash })
    return sessionId === "session" ? nodes.get(hash) ?? null : null
  }
  const reader = {
    ...fakeProjections().projectionReader,
    readSessionContentNode: readNode,
    readSessionContentRange: (sessionId: string, reference: Parameters<typeof readSessionContentRange>[0], offset: number, length: number) =>
      readSessionContentRange(reference, offset, length, hash => readNode(sessionId, hash)),
  }
  const manager = fakeManager({ read: async sessionId => ["session", "other"].includes(sessionId)
    ? { ...durableSessionFromCatalogRow(durableRow(sessionId))!, executionCwd: process.cwd() }
    : null })
  const service = createMutationEvidenceService({ reader, manager, projectRoot: process.cwd() })
  return { service, stage, nodes, reads }
}

function descriptor(index: number, reference: Parameters<ReturnType<typeof createMutationEvidenceService>["patchWindow"]>[0]["reference"]): MutationEvidenceEntry {
  return { kind: "applied", file: {
    version: 1, mutationId: `mutation-${index}`, path: join(process.cwd(), "nested", `${index}.ts`), displayPath: "stored-other-cwd",
    change: "added", before: null, after: { bytes: reference.bytes, sha256: reference.sha256 },
    retainedLines: 1, renderedLines: 1, omittedLines: 0, addedLines: 1, removedLines: 0,
    patch: { kind: "retained", reference }, conflictMarkers: false,
  } }
}

test("mutation file reads dispatch to their lazy evidence owner", async () => {
  const manifest = await buildSessionContentManifest([], async () => {})
  const query = { type: "mutationFiles" as const, sessionId: "session", manifest, offset: 0, maxFiles: 1, maxBytes: 4096 }
  const result = { kind: "available" as const, sessionId: query.sessionId, manifest, requestedOffset: 0, offset: 0, totalFiles: 0, totalBytes: manifest.bytes, files: [], nextOffset: null }
  let constructions = 0
  const store = fakeSessionStore(new Map())
  const manager = fakeManager()
  const service = createFlywheelAppService({
    ...fakeProjections(), projectRoot: process.cwd(),
    projection: createFrontendProjection({ projectRoot: process.cwd(), sessionStore: store, manager }),
    runtimeSupervisor: runtimeSupervisor(), bus: createRuntimeUiBus(),
    mutationEvidence: async () => { constructions++; return { files: async () => result, patchWindow: async () => { throw new Error("unused") } } },
  })
  expect(constructions).toBe(0)
  expect(await service.query(query)).toEqual(result)
  expect(constructions).toBe(1)
})

test("ordered pages seek only selected manifest leaves and never hydrate patches", async () => {
  const f = fixture()
  const patch = await buildSessionContent("+patch\n", f.stage)
  const entries = Array.from({ length: 300 }, (_, index) => descriptor(index, patch))
  const manifest = await buildSessionContentManifest(entries.map(entry => JSON.stringify(entry)), f.stage)
  const query = { type: "mutationFiles" as const, sessionId: "session", manifest, offset: 0, maxFiles: 128, maxBytes: 4096 }
  const files: MutationEvidenceEntry[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const page = await f.service.files({ ...query, offset })
    expect(page.kind).toBe("available")
    if (page.kind !== "available") throw new Error("Expected available files")
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(query.maxBytes)
    expect(page).toMatchObject({ manifest, requestedOffset: offset, offset, totalFiles: 300, totalBytes: manifest.bytes })
    files.push(...page.files)
    offset = page.nextOffset
  }
  expect(files.map(entry => entry.kind === "applied" && entry.file.mutationId)).toEqual(entries.map(entry => entry.kind === "applied" && entry.file.mutationId))
  f.reads.length = 0
  const middle = await f.service.files({ ...query, offset: 150, maxFiles: 1 })
  expect(middle.kind).toBe("available")
  if (middle.kind !== "available" || middle.files[0]?.kind !== "applied") throw new Error("Expected selected file")
  expect(middle.files[0].file).toMatchObject({ path: join(process.cwd(), "nested", "150.ts"), displayPath: "nested/150.ts", patch: { kind: "retained", reference: patch } })
  expect(f.reads).toHaveLength(2)
  expect(f.reads.every(read => read.sessionId === "session" && read.hash !== patch.root)).toBe(true)
  expect(sep === "/" || !middle.files[0].file.displayPath.includes(sep)).toBe(true)
})

test("a previews page carries each retained file's collapsed preview within its byte bound and fills the window", async () => {
  const f = fixture()
  const header = "Index: a.ts\n===\n--- a.ts\n+++ a.ts\n"
  const long = await buildSessionContent(`${header}@@ -1,30 +1,30 @@\n${Array.from({ length: 30 }, (_, index) => ` line ${index}`).join("\n")}\n`, f.stage)
  const huge = await buildSessionContent(`${header}@@ -1 +1 @@\n+${"\t".repeat(40_000)}\n`, f.stage)
  const cut = await buildSessionContent(`${header}@@ -1,3 +1,3 @@\n line a\n line b\n+${"x".repeat(40_000)}\n`, f.stage)
  const missing = await buildSessionContent("x".repeat(90_000), f.stage)
  const root = f.nodes.get(missing.root)
  if (root?.kind !== "index") throw new Error("Expected indexed patch")
  f.nodes.delete(root.children[0]!.sha256)
  const sensitive = descriptor(4, long)
  if (sensitive.kind !== "applied") throw new Error("Expected applied descriptor")
  const entries = [descriptor(0, long), descriptor(1, huge), descriptor(2, cut), descriptor(3, missing),
    { ...sensitive, file: { ...sensitive.file, patch: { kind: "omitted" as const, reason: "sensitive" as const } } },
    ...Array.from({ length: 20 }, (_, index) => descriptor(5 + index, huge))]
  const manifest = await buildSessionContentManifest(entries.map(entry => JSON.stringify(entry)), f.stage)
  const query = { type: "mutationFiles" as const, sessionId: "session", manifest, offset: 0, maxFiles: 128, maxBytes: 65_536, previews: true }
  const page = Schema.decodeUnknownSync(MutationFilesResultSchema)(await f.service.files(query))
  if (page.kind !== "available") throw new Error("Expected available files")
  const [first, second, third, fourth, fifth] = page.files
  // The preview starts at the first hunk and keeps the collapsed line budget.
  expect(first?.kind === "applied" && first.preview).toBe(`@@ -1,30 +1,30 @@\n${Array.from({ length: 20 }, (_, index) => ` line ${index}`).join("\n")}`)
  // A line longer than the bound is cut to it, measured as encoded text.
  if (second?.kind !== "applied" || second.preview === undefined) throw new Error("Expected a huge preview")
  expect(second.preview.startsWith("@@ -1 +1 @@\n+\t")).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(second.preview))).toBeLessThanOrEqual(16 * 1024)
  expect(Buffer.byteLength(JSON.stringify(second.preview))).toBeGreaterThan(16 * 1024 - 8)
  // A cut line after whole lines is dropped rather than shown as whole.
  expect(third?.kind === "applied" && third.preview).toBe("@@ -1,3 +1,3 @@\n line a\n line b\n")
  expect(fourth).toMatchObject({ kind: "applied", file: { patch: { kind: "unavailable" } } })
  expect(fourth).not.toHaveProperty("preview")
  expect(fifth).not.toHaveProperty("preview")
  // The page holds every file that fits its window, and the next file would not fit.
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(query.maxBytes)
  expect(page.nextOffset).toBe(page.files.length)
  const next = await f.service.files({ ...query, offset: page.files.length, maxFiles: 1 })
  if (next.kind !== "available") throw new Error("Expected the next file")
  expect(Buffer.byteLength(JSON.stringify({ ...page, files: [...page.files, ...next.files] }))).toBeGreaterThan(query.maxBytes)
  const plain = await f.service.files({ ...query, previews: false })
  if (plain.kind !== "available") throw new Error("Expected available files")
  expect(plain.files.some(entry => "preview" in entry)).toBe(false)
})

test("patch windows reconstruct exact long-line UTF-8 bytes with immutable coordinates and proof", async () => {
  const f = fixture()
  const text = "a".repeat(65_533) + "€" + "z".repeat(65_536)
  const reference = await buildSessionContent(text, f.stage)
  const query = { type: "mutationPatchWindow" as const, sessionId: "session", reference, offset: 0, maxBytes: 65_536 }
  const chunks: Buffer[] = []
  let offset: number | null = 0
  while (offset !== null) {
    const result = await f.service.patchWindow({ ...query, offset })
    if (result.kind !== "available") throw new Error("Expected available bytes")
    expect(result).toMatchObject({ reference, requestedOffset: offset, offset, totalBytes: reference.bytes })
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(query.maxBytes)
    const chunk = Buffer.from(result.base64, "base64")
    expect(result.servedBytes).toBe(chunk.length)
    chunks.push(chunk)
    offset = result.nextOffset
  }
  const complete = Buffer.concat(chunks)
  expect(complete.toString()).toBe(text)
  expect(new Bun.CryptoHasher("sha256").update(complete).digest("hex")).toBe(reference.sha256)
  const partial = await f.service.patchWindow({ ...query, offset: 65_534, maxBytes: 1024 })
  if (partial.kind !== "available") throw new Error("Expected partial character")
  expect(Buffer.from(partial.base64, "base64").subarray(0, 2)).toEqual(Buffer.from([0x82, 0xac]))
})

test("display paths follow the execution directory policy without changing stored identities", async () => {
  const f = fixture()
  const patch = await buildSessionContent("patch", f.stage)
  const source = descriptor(0, patch)
  if (source.kind !== "applied") throw new Error("Expected applied descriptor")
  const paths = ["./relative.ts", process.cwd(), join(dirname(process.cwd()), "outside.ts")]
  const manifest = await buildSessionContentManifest(paths.map(path => JSON.stringify({ ...source, file: { ...source.file, path } })), f.stage)
  const page = await f.service.files({ type: "mutationFiles", sessionId: "session", manifest, offset: 0, maxFiles: 3, maxBytes: 4096 })
  if (page.kind !== "available") throw new Error("Expected available file paths")
  expect(page.files.map(entry => entry.kind === "applied" && [entry.file.path, entry.file.displayPath])).toEqual([
    ["./relative.ts", "relative.ts"], [process.cwd(), "."], [join(dirname(process.cwd()), "outside.ts"), "../outside.ts"],
  ])
})

test("session admission and every selected child stay in the requested session scope", async () => {
  const f = fixture()
  const reference = await buildSessionContent("x".repeat(90_000), f.stage)
  const manifest = await buildSessionContentManifest([JSON.stringify(descriptor(0, reference))], f.stage)
  const files = { type: "mutationFiles" as const, sessionId: "session", manifest, offset: 0, maxFiles: 1, maxBytes: 4096 }
  const patch = { type: "mutationPatchWindow" as const, sessionId: "session", reference, offset: 0, maxBytes: 4096 }
  await expect(f.service.files({ ...files, sessionId: "deleted" })).rejects.toThrow("Session is unavailable")
  await expect(f.service.patchWindow({ ...patch, sessionId: "deleted" })).rejects.toThrow("Session is unavailable")
  expect(f.reads).toHaveLength(0)
  expect(await f.service.files({ ...files, sessionId: "other" })).toMatchObject({ kind: "unavailable", manifest, requestedOffset: 0, reason: "missing" })
  expect(await f.service.patchWindow({ ...patch, sessionId: "other" })).toMatchObject({ kind: "unavailable", reference, requestedOffset: 0, reason: "missing" })
  expect(f.reads.every(read => read.sessionId === "other")).toBe(true)
  f.reads.length = 0
  const root = f.nodes.get(reference.root)
  if (root?.kind !== "index") throw new Error("Expected indexed patch")
  f.nodes.delete(root.children[0]!.sha256)
  expect(await f.service.patchWindow(patch)).toMatchObject({ kind: "unavailable", reference, reason: "missing" })
  expect(f.reads.every(read => read.sessionId === "session")).toBe(true)
})

test("missing, corrupt, and malformed selected evidence remains explicitly unavailable; tiny budgets reject", async () => {
  const f = fixture()
  const reference = await buildSessionContent("patch", f.stage)
  const manifest = await buildSessionContentManifest(["not valid JSON"], f.stage)
  const files = { type: "mutationFiles" as const, sessionId: "session", manifest, offset: 0, maxFiles: 1, maxBytes: 4096 }
  const patch = { type: "mutationPatchWindow" as const, sessionId: "session", reference, offset: 0, maxBytes: 4096 }
  const validManifest = await buildSessionContentManifest([JSON.stringify(descriptor(0, reference))], f.stage)
  await expect(f.service.files({ ...files, manifest: validManifest, maxBytes: 1 })).rejects.toThrow("maxBytes")
  await expect(f.service.patchWindow({ ...patch, maxBytes: 1 })).rejects.toThrow("maxBytes")
  expect(await f.service.files(files)).toMatchObject({ kind: "unavailable", reason: "corrupt", manifest })
  f.nodes.set(reference.root, { version: 1, kind: "text", text: "different" })
  expect(await f.service.patchWindow(patch)).toMatchObject({ kind: "unavailable", reason: "corrupt", reference })
  f.nodes.delete(manifest.root)
  expect(await f.service.files(files)).toMatchObject({ kind: "unavailable", reason: "missing" })
  await expect(f.service.files({ ...files, maxBytes: 1 })).rejects.toThrow("maxBytes")
  await expect(f.service.patchWindow({ ...patch, maxBytes: 1 })).rejects.toThrow("maxBytes")
})

const Queries = RpcGroup.make(Rpc.make("RuntimeQuery", {
  payload: Schema.Union([MutationFilesQuerySchema, MutationPatchWindowQuerySchema]), success: Schema.Unknown, error: Schema.String,
}))

function pipe(observe?: (bytes: Uint8Array) => void) {
  let controller: ReadableStreamDefaultController<Uint8Array>
  return {
    readable: new ReadableStream<Uint8Array>({ start(value) { controller = value } }),
    writable: new WritableStream<Uint8Array>({ write(bytes) { observe?.(bytes); controller.enqueue(bytes) } }),
  }
}

/** The fields of an RPC Exit frame that this test reads; `isExitFrame` checks each of them. */
interface ExitFrame {
  readonly requestId: string
  readonly exit: { readonly _tag: "Success"; readonly value: unknown } | { readonly _tag: "Failure"; readonly cause: unknown }
}

/** The codec decodes untyped values; an Exit frame is the server's answer to one request. */
function isExitFrame(raw: unknown): raw is ExitFrame {
  if (typeof raw !== "object" || raw === null || !("_tag" in raw) || raw._tag !== "Exit") return false
  if (!("requestId" in raw) || typeof raw.requestId !== "string" || !("exit" in raw)) return false
  const exit = raw.exit
  if (typeof exit !== "object" || exit === null || !("_tag" in exit)) return false
  return (exit._tag === "Success" && "value" in exit) || (exit._tag === "Failure" && "cause" in exit)
}

test("the public socket codec fits the complete actual response including arbitrary request ids", async () => {
  const f = fixture()
  const reference = await buildSessionContent("€".repeat(30_000), f.stage)
  const entries = Array.from({ length: 50 }, (_, index) => descriptor(index, reference))
  const manifest = await buildSessionContentManifest(entries.map(entry => JSON.stringify(entry)), f.stage)
  const decoder = RpcSerialization.msgPack.makeUnsafe()
  const encoder = RpcSerialization.msgPack.makeUnsafe()
  const pending = new Map<string, { resolve: (response: { bytes: number; frame: ExitFrame }) => void }>()
  const outgoing = pipe(bytes => {
    for (const raw of decoder.decode(bytes)) {
      if (isExitFrame(raw)) pending.get(raw.requestId)?.resolve({ bytes: bytes.length, frame: raw })
    }
  })
  const incoming = pipe()
  const socket = await Effect.runPromise(Socket.fromTransformStream(Effect.succeed({ readable: incoming.readable, writable: outgoing.writable })))
  const server = ManagedRuntime.make(RpcServer.layer(Queries).pipe(
    Layer.provide(Queries.toLayer(Effect.succeed(Queries.of({
      RuntimeQuery: query => Effect.tryPromise({
        try: async (): Promise<MutationFilesResult | MutationPatchWindowResult> => query.type === "mutationFiles" ? f.service.files(query) : f.service.patchWindow(query),
        catch: String,
      }),
    })))),
    Layer.provide(runtimeProtocolSocketServer), Layer.provide(RpcSerialization.layerMsgPack),
    Layer.provide(Layer.succeed(SocketServer.SocketServer, SocketServer.SocketServer.of({
      address: { _tag: "UnixAddress", path: "memory" },
      run: handler => Effect.flatMap(Effect.orDie(handler(socket)), () => Effect.never),
    }))),
  ))
  await server.runPromise(Effect.void)
  const writer = incoming.writable.getWriter()
  try {
    const queries = [
      { type: "mutationFiles" as const, sessionId: "session", manifest, offset: 4, maxFiles: 40, maxBytes: 4096 },
      { type: "mutationPatchWindow" as const, sessionId: "session", reference, offset: 1, maxBytes: 1024 },
    ]
    for (const [index, query] of queries.entries()) {
      const id = "9".repeat(300 + index)
      const response = Promise.withResolvers<{ bytes: number; frame: ExitFrame }>()
      pending.set(id, response)
      const request = encoder.encode({ _tag: "Request", id, tag: "RuntimeQuery", payload: query, headers: [] })
      if (!(request instanceof Uint8Array)) throw new Error("Expected binary RPC codec")
      await writer.write(request)
      const actual = await response.promise
      expect(actual.bytes).toBeLessThanOrEqual(query.maxBytes)
      expect(actual.frame.exit._tag).toBe("Success")
      if (actual.frame.exit._tag !== "Success") throw new Error("Expected public success")
      const result = query.type === "mutationFiles"
        ? Schema.decodeUnknownSync(MutationFilesResultSchema)(actual.frame.exit.value)
        : Schema.decodeUnknownSync(MutationPatchWindowResultSchema)(actual.frame.exit.value)
      expect(result).toMatchObject({ kind: "available", requestedOffset: query.offset, offset: query.offset })
      if (result.kind === "available" && "servedBytes" in result) {
        expect(result.servedBytes).toBeGreaterThan(0)
        expect(result.nextOffset).toBe(result.offset + result.servedBytes)
        expect(Buffer.from(result.base64, "base64")).toEqual(Buffer.from("€".repeat(30_000)).subarray(result.offset, result.offset + result.servedBytes))
      }
    }
    const refused = Promise.withResolvers<{ bytes: number; frame: ExitFrame }>()
    const oversizedId = "8".repeat(3000)
    pending.set(oversizedId, refused)
    const request = encoder.encode({ _tag: "Request", id: oversizedId, tag: "RuntimeQuery", payload: { ...queries[1]!, maxBytes: 512 }, headers: [] })
    if (!(request instanceof Uint8Array)) throw new Error("Expected binary RPC codec")
    await writer.write(request)
    const rejection = await refused.promise
    expect(rejection.frame.requestId).toBe(oversizedId)
    expect(rejection.frame.exit._tag).toBe("Failure")
    expect(JSON.stringify(rejection.frame.exit)).toContain("maxBytes")
  } finally {
    writer.releaseLock()
    await server.dispose()
  }
})
