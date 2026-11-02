import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { RuntimeQuerySchema, runtimeQueryResultSchema, RUNTIME_READ_DOMAINS } from "../../../src/protocol/runtime-protocol-schemas.js"
import { runtimeCallPolicies } from "../../../src/protocol/runtime-client-deadlines.js"
import { queryExposure } from "../../../src/protocol/client/editor-protocol-coverage.js"
import { OUTPUT_HISTORY_RPC_DEADLINE_MS } from "../../../src/infra/with-deadline.js"

const hash = "a".repeat(64)
const manifest = { version: 1 as const, root: hash, bytes: 1000, entries: 3 }
const reference = { version: 1 as const, root: hash, bytes: 7, sha256: "b".repeat(64) }
const queries = [
  { type: "mutationFiles", sessionId: "session", manifest, offset: 1, maxFiles: 2, maxBytes: 4096 },
  { type: "mutationFiles", sessionId: "session", manifest, offset: 1, maxFiles: 2, maxBytes: 4096, previews: true },
  { type: "mutationPatchWindow", sessionId: "session", reference, offset: 2, maxBytes: 1 },
] as const

describe("public mutation evidence queries", () => {
  test.each([...queries])("roundtrips an immutable bounded $type request through the public codec", (input) => {
    const query = Schema.decodeUnknownSync(RuntimeQuerySchema)(JSON.parse(JSON.stringify(input)))
    expect(query).toEqual(input)
    expect(Schema.encodeSync(RuntimeQuerySchema)(query)).toEqual(input)
    expect(queryExposure(query)).toBe("exposed")
    expect(runtimeCallPolicies[query.type]).toEqual({ _tag: "BestEffort", deadlineMs: OUTPUT_HISTORY_RPC_DEADLINE_MS })
    expect(RUNTIME_READ_DOMAINS[query.type]).toEqual([])
  })

  test("roundtrips file identities, descriptor counts, previews, and continuation without inline patch bytes", () => {
    const result = {
      kind: "available", sessionId: "session", manifest,
      requestedOffset: 1, offset: 1, totalFiles: 3, totalBytes: 1000, nextOffset: 2,
      files: [{
        kind: "applied", file: {
          version: 1, mutationId: "mutation", path: "/workspace/a.ts", displayPath: "a.ts", change: "modified",
          before: { bytes: 1, sha256: hash }, after: { bytes: 2, sha256: hash },
          retainedLines: 2, renderedLines: 2, omittedLines: 0, addedLines: 1, removedLines: 1,
          patch: { kind: "retained", reference }, conflictMarkers: false,
        },
        preview: "@@ -1 +1 @@\n-a\n+b",
      }],
    }
    const codec = runtimeQueryResultSchema("mutationFiles")
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(result))).toEqual(result)
  })

  test("roundtrips byte windows that end inside a UTF-8 character and preserve full-content proof", () => {
    const result = {
      kind: "available", sessionId: "session", reference,
      requestedOffset: 2, offset: 2, totalBytes: 7, servedBytes: 1,
      base64: "4g==", nextOffset: 3,
    }
    const codec = runtimeQueryResultSchema("mutationPatchWindow")
    expect(Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(result))).toEqual(result)
    expect(Buffer.from(result.base64, "base64")).toEqual(Buffer.from([0xe2]))
  })

  test.each([...queries])("roundtrips explicit unavailable $type evidence with its requested identity", (query) => {
    const common = { kind: "unavailable" as const, sessionId: query.sessionId, requestedOffset: query.offset, reason: "corrupt" as const }
    if (query.type === "mutationFiles") {
      const result = { ...common, manifest }
      const codec = runtimeQueryResultSchema("mutationFiles")
      expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(result))).toEqual(result)
    } else {
      const result = { ...common, reference }
      const codec = runtimeQueryResultSchema("mutationPatchWindow")
      expect(Schema.decodeUnknownSync(codec)(Schema.encodeUnknownSync(codec)(result))).toEqual(result)
    }
  })

  test("rejects invalid roots, unbounded windows, and whole evidence summaries at the read boundary", () => {
    const decode = Schema.decodeUnknownSync(RuntimeQuerySchema)
    for (const invalid of [
      { ...queries[0], manifest: { ...manifest, root: "not-a-hash" } },
      { ...queries[0], maxFiles: 129 },
      { ...queries[0], manifest: { version: 2, manifest, applied: 3 } },
      { ...queries[1], offset: -1 },
      { ...queries[1], maxBytes: 65_537 },
      { ...queries[1], maxBytes: 0 },
    ]) expect(() => decode(invalid)).toThrow()
  })

  test("rejects oversized descriptor pages and byte windows at the result boundary", () => {
    const filesPage = {
      kind: "available", sessionId: "session", manifest,
      requestedOffset: 0, offset: 0, totalFiles: 3, totalBytes: 1000, nextOffset: null,
    }
    const entry = { kind: "not_applied", path: "/workspace/a.ts", reason: "not applicable" }
    const decodeFiles = Schema.decodeUnknownSync(runtimeQueryResultSchema("mutationFiles"))
    expect(() => decodeFiles({ ...filesPage, files: Array.from({ length: 129 }, () => entry) })).toThrow()
    expect(() => decodeFiles({ ...filesPage, files: [{ ...entry, reason: "x".repeat(65_536) }] })).toThrow()
    const applied = { kind: "applied", file: {
      version: 1, mutationId: "mutation", path: "/workspace/a.ts", displayPath: "a.ts", change: "added", before: null, after: null,
      retainedLines: 1, renderedLines: 1, omittedLines: 0, addedLines: 1, removedLines: 0, patch: { kind: "retained", reference }, conflictMarkers: false,
    } }
    // The bound is on encoded text, so escaped characters count at their encoded size.
    expect(() => decodeFiles({ ...filesPage, files: [{ ...applied, preview: "\t".repeat(8_191) }] })).not.toThrow()
    expect(() => decodeFiles({ ...filesPage, files: [{ ...applied, preview: "\t".repeat(8_192) }] })).toThrow()
    expect(() => decodeFiles({ ...filesPage, files: [{ ...entry, preview: "" }] })).toThrow()
    const decodePatch = Schema.decodeUnknownSync(runtimeQueryResultSchema("mutationPatchWindow"))
    expect(() => decodePatch({
      kind: "available", sessionId: "session", reference, requestedOffset: 0, offset: 0,
      totalBytes: 7, servedBytes: 1, base64: "not base64", nextOffset: 1,
    })).toThrow()
  })
})
