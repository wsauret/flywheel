import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { createStore } from "solid-js/store"
import type { MutationEvidenceEntry } from "../../../../src/infra/mutation-evidence.js"
import type { SessionContentReference } from "../../../../src/infra/session-content.js"
import type { RuntimeQuery } from "../../../../src/protocol/app-service-types.js"
import { createMutationEvidenceReader } from "../../../../src/protocol/client/mutation-evidence.js"
import { RuntimeQuerySchema } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { createTranscriptStore } from "../../../../src/protocol/client/transcript-store.js"
import { fakeConnection, SESSION, toolBlock } from "./_transcript-store-fixtures.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"

const manifest = { version: 1 as const, root: "a".repeat(64), bytes: 100, entries: 2 }
const utf8 = new TextEncoder()
function reference(text: string): SessionContentReference {
  return { version: 1, root: "b".repeat(64), bytes: utf8.encode(text).length, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") }
}
function file(ref: SessionContentReference, path = "a.ts"): MutationEvidenceEntry {
  return { kind: "applied", file: { version: 1, mutationId: path, path, displayPath: path, change: "modified", before: null, after: null, retainedLines: 1, renderedLines: 1, omittedLines: 0, addedLines: 1, removedLines: 0, patch: { kind: "retained", reference: ref }, conflictMarkers: false } }
}
function fixture(text: string, windowBytes = 65_000) {
  const calls: RuntimeQuery[] = []
  const ref = reference(text)
  const entries = [file(ref), file(reference("other"), "other.ts")]
  const content = new Map([[ref.sha256, utf8.encode(text)], [reference("other").sha256, utf8.encode("other")]])
  let fail: "missing" | "corrupt" | "error" | "offset" | "hash" | "utf8" | undefined
  let gate: Promise<void> | undefined
  /** Records the read, holds it while the test holds reads, and fails it while the runtime is offline. */
  async function admit(query: RuntimeQuery): Promise<void> {
    calls.push(query)
    await gate
    if (fail === "error") throw new Error("offline")
  }
  const queryEvidence = runtimeQuery({
    mutationFiles: async (query) => {
      await admit(query)
      return { kind: "available", sessionId: SESSION, manifest: query.manifest, requestedOffset: query.offset, offset: query.offset, totalFiles: entries.length, totalBytes: 100, files: entries.slice(query.offset, query.offset + 1), nextOffset: query.offset + 1 === entries.length ? null : query.offset + 1 }
    },
    mutationPatchWindow: async (query) => {
      await admit(query)
      if (fail === "missing" || fail === "corrupt") return { kind: "unavailable", sessionId: SESSION, reference: query.reference, requestedOffset: query.offset, reason: fail }
      const bytes = content.get(query.reference.sha256)!
      const chunk = bytes.slice(query.offset, query.offset + windowBytes)
      if (fail === "hash" && chunk.length > 0) chunk[0] = 120
      if (fail === "utf8" && chunk.length > 0) chunk[0] = 255
      const end = query.offset + chunk.length
      return { kind: "available", sessionId: SESSION, reference: query.reference, requestedOffset: query.offset, offset: query.offset + (fail === "offset" ? 1 : 0), totalBytes: bytes.length, servedBytes: chunk.length, base64: btoa(String.fromCharCode(...chunk)), nextOffset: end === bytes.length ? null : end }
    },
  })
  const connection = { query: queryEvidence }
  const reader = createMutationEvidenceReader({ connection, sessionId: SESSION })
  return { reader, connection, calls, entries, ref, setFailure(value: typeof fail) { fail = value }, hold(value: Promise<void> | undefined) { gate = value } }
}

describe("mutation evidence reader", () => {
  test("sends references read from a client store as values the protocol can encode", async () => {
    const f = fixture("+a\n")
    const [store] = createStore({ manifest, patch: f.ref })
    await f.reader.open("tool:a", store.manifest).loadFiles()
    await f.reader.openPatch("net:a", store.patch).continue()
    expect(f.calls.map(call => call.type)).toEqual(["mutationFiles", "mutationPatchWindow"])
    for (const call of f.calls) expect(() => Schema.encodeUnknownSync(RuntimeQuerySchema)(call)).not.toThrow()
    f.reader.dispose()
  })

  test("opens standalone derived patches without inventing a mutation or reading a manifest", async () => {
    const f = fixture("+a€\n+next\n", 3)
    const patch = f.reader.openPatch("net:a", f.ref)
    expect(f.calls).toEqual([])
    expect(f.reader.openPatch("net:a", { ...f.ref })).toBe(patch)
    await patch.continue(20)
    expect(patch.view).toMatchObject({ status: "ready", text: "+a€\n+next\n", complete: true })
    expect(f.calls.every(call => call.type === "mutationPatchWindow")).toBe(true)
    const other = f.reader.openPatch("net:b", f.ref)
    await other.continue()
    f.reader.release("net:a")
    expect(patch.view.text).toBe("")
    expect(other.view.text).toBe("+a€\n+next\n")
    f.reader.retainOwners(new Set())
    expect(f.reader.heldBytes).toBe(0)
    await other.continue()
    f.reader.dispose()
  })
  test("keeps acquired metadata and visible previews under one tool owner", async () => {
    const f = fixture("+first\n+second\n", 7)
    f.entries.push(file(reference("unrequested"), "third.ts"))
    const h = f.reader.open("tool", { ...manifest, entries: 3 })
    await h.loadFiles()
    await h.loadFiles()
    const first = h.patch(f.entries[0]!)!
    const second = h.patch(f.entries[1]!)!
    const gate = Promise.withResolvers<void>()
    f.hold(gate.promise)
    const reads = [first.continue(1), second.continue(1)]
    expect(f.calls.filter(call => call.type === "mutationPatchWindow")).toMatchObject([
      { reference: f.ref, offset: 0 },
      { reference: reference("other"), offset: 0 },
    ])
    const nextPage = h.loadFiles()
    expect(h.files.files).toEqual(f.entries.slice(0, 2))
    gate.resolve()
    await Promise.all([...reads, nextPage])
    expect(h.files.files).toEqual(f.entries)
    expect(h.files.nextOffset).toBeNull()
    expect(first.view).toMatchObject({ status: "ready", text: "+first\n", complete: false })
    expect(second.view).toMatchObject({ status: "ready", text: "other", complete: true })
    expect(h.patch({ ...f.entries[0]! })).toBe(first)
    f.reader.retainOwners(new Set(["tool"]))
    expect(first.view.text).toBe("+first\n")
    expect(second.view.text).toBe("other")
    await first.continue(1)
    expect(first.view.text).toBe("+first\n+second")
    expect(second.view.text).toBe("other")
    const beforeRelease = f.reader.heldBytes
    let publications = 0
    f.reader.onChange(() => publications++)
    first.release()
    expect(first.view.text).toBe("")
    expect(f.reader.heldBytes).toBeLessThan(beforeRelease)
    expect(publications).toBe(1)
    expect(second.view.text).toBe("other")
    const calls = f.calls.length
    await first.continue()
    await h.loadFiles()
    expect(f.calls).toHaveLength(calls)
    expect(h.patch(f.entries[0]!)).not.toBe(first)
    const replacement = f.reader.open("tool", { ...manifest, entries: 3, root: "c".repeat(64) })
    expect(second.view.text).toBe("")
    expect(h.files.files).toEqual([])
    expect(h.patch(f.entries[0]!)).toBeUndefined()
    expect(replacement.files.status).toBe("idle")
    f.reader.dispose()
  })

  test("shares only pending root reads while owners and equal-content file handles remain independent", async () => {
    const f = fixture("+same\n")
    const a = f.reader.open("tool-a", manifest)
    const b = f.reader.open("tool-b", manifest)
    expect(f.reader.open("tool-a", { ...manifest })).toBe(a)
    const gate = Promise.withResolvers<void>()
    f.hold(gate.promise)
    const pages = [a.loadFiles(), b.loadFiles()]
    expect(f.calls).toHaveLength(1)
    const first = a.patch(f.entries[0]!)!
    const equalContent = a.patch(file(f.ref, "equal.ts"))!
    const otherOwner = b.patch(f.entries[0]!)!
    expect(equalContent).not.toBe(first)
    const reads = [first.continue(), equalContent.continue(), otherOwner.continue()]
    expect(f.calls).toHaveLength(2)
    first.release()
    f.reader.release("tool-b")
    gate.resolve()
    await Promise.all([...pages, ...reads])
    expect(equalContent.view).toMatchObject({ status: "ready", text: "+same\n", complete: true })
    expect(first.view.text).toBe("")
    expect(otherOwner.view.text).toBe("")
    expect(b.files.files).toEqual([])
    const reopened = a.patch(f.entries[0]!)!
    await reopened.continue()
    expect(f.calls).toHaveLength(3)
    expect(reopened.view.text).toBe("+same\n")
    f.reader.dispose()
  })

  test("asks for previews only for an opener that renders collapsed rows, and a preview handle serves every opener", async () => {
    const f = fixture("+hello\n")
    const plain = f.reader.open("tool", manifest)
    await plain.loadFiles()
    expect(f.calls.at(-1)).not.toHaveProperty("previews")
    const previews = f.reader.open("tool", manifest, { previews: true })
    expect(previews).not.toBe(plain)
    expect(previews.files.status).toBe("idle")
    await previews.loadFiles()
    expect(f.calls.at(-1)).toMatchObject({ type: "mutationFiles", offset: 0, previews: true })
    expect(() => Schema.encodeUnknownSync(RuntimeQuerySchema)(f.calls.at(-1))).not.toThrow()
    expect(f.reader.open("tool", manifest)).toBe(previews)
    expect(f.reader.open("tool", manifest, { previews: true })).toBe(previews)
    expect(f.calls).toHaveLength(2)
    f.reader.dispose()
  })

  test("stays passive until disclosure and shares pending reads without acquiring unrequested patches", async () => {
    const f = fixture("+hello\n")
    const handle = f.reader.open("tool", manifest)
    expect(f.calls).toEqual([])
    expect(handle.files.status).toBe("idle")
    const gate = Promise.withResolvers<void>()
    f.hold(gate.promise)
    const first = handle.loadFiles()
    expect(handle.loadFiles()).toBe(first)
    expect(f.calls).toHaveLength(1)
    gate.resolve()
    await first
    expect(handle.files.files).toEqual([f.entries[0]!])
    expect(f.calls[0]).toMatchObject({ type: "mutationFiles", offset: 0, maxFiles: 128, maxBytes: 65536 })
    const selected = handle.patch(f.entries[0]!)!
    expect(f.calls).toHaveLength(1)
    const patch = selected.continue()
    expect(selected.continue()).toBe(patch)
    await patch
    expect(selected.view).toMatchObject({ status: "ready", text: "+hello\n", complete: true })
    expect(f.calls).toHaveLength(2)
    expect(handle.patch({ kind: "not_applied", path: "no.ts", reason: "refused" })).toBeUndefined()
    const applied = f.entries[0]!
    if (applied.kind !== "applied") throw new Error("Expected applied fixture")
    expect(handle.patch({ ...applied, file: { ...applied.file, patch: { kind: "omitted", reason: "sensitive" } } })).toBeUndefined()
    expect(handle.patch({ ...applied, file: { ...applied.file, patch: { kind: "unavailable" } } })).toBeUndefined()
    expect(f.calls).toHaveLength(2)
    f.reader.dispose()
  })

  test("decodes split multibyte windows and shows a long partial line without inflating source omission counts", async () => {
    const f = fixture("+a€" + "x".repeat(400) + "\nnext\n", 3)
    const h = f.reader.open("tool", manifest)
    const patch = h.patch(f.entries[0]!)!
    await patch.continue(1, 3)
    expect(patch.view.text).toBe("+a")
    expect(patch.view.complete).toBe(false)
    await patch.continue(1, 3)
    expect(patch.view.text).toBe("+a€x")
    expect(patch.view.text).not.toContain("�")
    expect(f.entries[0]).toMatchObject({ file: { omittedLines: 0 } })
    f.reader.dispose()
  })

  test("fills the visible row budget across windows and verifies the complete hash", async () => {
    const f = fixture("+one\n+two\n+three\n", 5)
    const h = f.reader.open("tool", manifest)
    const patch = h.patch(f.entries[0]!)!
    await patch.continue(2)
    expect(patch.view.text).toBe("+one\n+two\n")
    expect(patch.view.complete).toBe(false)
    await patch.continue(20)
    expect(patch.view).toMatchObject({ text: "+one\n+two\n+three\n", complete: true, status: "ready" })
    expect(f.reader.heldBytes).toBeGreaterThan(0)
    const publications: (ReadonlySet<string> | undefined)[] = []
    f.reader.onChange(owners => publications.push(owners))
    f.reader.release("tool")
    expect(f.reader.heldBytes).toBe(0)
    expect(publications).toEqual([new Set(["tool"])])
    // Disposal changes every owner at once, so it publishes to every observer before detaching them.
    f.reader.dispose()
    expect(publications).toStrictEqual([new Set(["tool"]), undefined])
  })

  test.each(["missing", "corrupt", "offset", "hash", "utf8"] as const)("marks %s evidence unavailable rather than displaying a successful empty patch", async (failure) => {
    const f = fixture("+text\n")
    f.setFailure(failure)
    const h = f.reader.open("tool", manifest)
    const patch = h.patch(f.entries[0]!)!
    await patch.continue()
    expect(patch.view).toMatchObject({ status: "unavailable", text: "", complete: false, message: "Change evidence is unavailable" })
    f.reader.dispose()
  })

  test("keeps transport failure in the actual reader state and can retry it explicitly", async () => {
    const f = fixture("+text\n")
    f.setFailure("error")
    const h = f.reader.open("tool", manifest)
    await h.loadFiles()
    expect(h.files).toMatchObject({ status: "error", message: "offline" })
    const patch = h.patch(f.entries[0]!)!
    await patch.continue()
    expect(patch.view).toMatchObject({ status: "error", message: "offline" })
    f.setFailure(undefined)
    await patch.continue()
    expect(patch.view).toMatchObject({ status: "ready", complete: true, text: "+text\n" })
    await h.loadFiles()
    f.setFailure("error")
    await h.loadFiles()
    expect(h.files).toMatchObject({ status: "error", files: [f.entries[0]!], nextOffset: 1 })
    expect(patch.view.text).toBe("+text\n")
    f.setFailure(undefined)
    await h.loadFiles()
    expect(h.files.files).toEqual(f.entries)
    f.reader.dispose()
  })

  test.each(["replacement", "release", "disposal"] as const)("ignores late results after owner %s", async (action) => {
    const f = fixture("+text\n")
    const gate = Promise.withResolvers<void>()
    f.hold(gate.promise)
    const old = f.reader.open("tool", manifest)
    const page = old.loadFiles()
    const oldPatch = old.patch(f.entries[0]!)!
    const patch = oldPatch.continue()
    const fresh = action === "replacement" ? f.reader.open("tool", { ...manifest, root: "c".repeat(64) }) : undefined
    if (action === "release") f.reader.release("tool")
    if (action === "disposal") f.reader.dispose()
    expect(old.patch(f.entries[0]!)).toBeUndefined()
    expect(oldPatch.view.text).toBe("")
    gate.resolve()
    await Promise.all([page, patch])
    expect(old.files.status).toBe("idle")
    expect(fresh?.files.status).toBe(action === "replacement" ? "idle" : undefined)
    expect(oldPatch.view).toMatchObject({ status: "idle", text: "" })
    await oldPatch.continue()
    expect(f.calls).toHaveLength(2)
    f.reader.dispose()
    expect(f.reader.heldBytes).toBe(0)
  })

  test("does not publish a released file read into its reopened handle or retain evicted prefixes", async () => {
    const f = fixture("+text\n")
    const gate = Promise.withResolvers<void>()
    f.hold(gate.promise)
    const h = f.reader.open("tool", manifest)
    const old = h.patch(f.entries[0]!)!
    const pending = old.continue()
    old.release()
    const fresh = h.patch(f.entries[0]!)!
    gate.resolve()
    await pending
    expect(fresh.view).toMatchObject({ status: "idle", text: "", reference: f.ref })
    f.hold(undefined)
    await fresh.continue()
    expect(fresh.view.text).toBe("+text\n")
    f.reader.retainOwners(new Set())
    expect(fresh.view.text).toBe("")
    expect(f.reader.heldBytes).toBe(0)
    f.reader.dispose()
  })

  test("transcript body release and disposal own the passive reader lifetime", async () => {
    const f = fixture("+text\n")
    const base = fakeConnection({ windows: [{ blocks: [toolBlock("completed")], startBlockIndex: 0, totalBlocks: 1 }] })
    const query = base.connection.query
    base.connection.query = q => q.type === "mutationFiles" || q.type === "mutationPatchWindow" ? f.connection.query(q) : query(q)
    const store = createTranscriptStore({ connection: base.connection, sessionId: SESSION })
    await store.refresh()
    const h = store.mutationEvidence.open("call-1", manifest)
    const patch = h.patch(f.entries[0]!)!
    await patch.continue()
    expect(store.mutationEvidence.heldBytes).toBeGreaterThan(0)
    store.releaseBodies()
    expect(store.mutationEvidence.heldBytes).toBe(0)
    store.dispose()
    await patch.continue()
    expect(f.calls).toHaveLength(1)
    f.reader.dispose()
  })
})
