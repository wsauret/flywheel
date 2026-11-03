import assert from "node:assert/strict"
import { beforeEach, afterEach, test } from "node:test"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { rendered } from "./blocks-render-loader-fixture.js"
import { mountTurnChanges, mountUserMessage } from "./render-ownership-loader-fixture.js"
import type { TurnFold } from "../client/turn-folds.js"
import { SESSION, settle } from "../../../tests/unit/protocol/client/_transcript-store-fixtures.js"
import { createMutationEvidenceReader, type MutationFilesView } from "../../../src/protocol/client/mutation-evidence.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { runtimeQuery } from "../../../tests/helpers/runtime-dispatch.js"
import { mutationEvidenceFixture } from "../../../tests/unit/tui/output-blocks/_mutation-evidence-fixture.js"

let originalObserver: PropertyDescriptor | undefined
beforeEach(() => {
  originalObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver")
  if (!originalObserver) Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: class { observe() {} disconnect() {} } })
})
afterEach(() => {
  if (originalObserver) Object.defineProperty(globalThis, "IntersectionObserver", originalObserver)
  else Reflect.deleteProperty(globalThis, "IntersectionObserver")
})

test("folded answers load unique file metadata only and disclose one file's ordered patch windows", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver")
  const observers = new Set<{ tag?: string; show: () => void }>()
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: class {
    entry?: { tag?: string; show: () => void }
    constructor(readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe(element: { tag?: string }) {
      this.entry = { tag: element.tag, show: () => this.callback([{ isIntersecting: true }]) }
      observers.add(this.entry)
    }
    disconnect() { if (this.entry) observers.delete(this.entry) }
  } })
  const patches = ["@@ -1 +1 @@\n-old\n+first" + "x".repeat(3000), "@@ -1 +1 @@\n-first\n+second", "@@ -1 +1 @@\n-old\n+unrelated"]
  const bytes = patches.map(text => new TextEncoder().encode(text))
  const entries = bytes.map((content, index): Extract<MutationFilesView["files"][number], { kind: "applied" }> => ({
    kind: "applied", file: {
      version: 1, mutationId: `mutation-${index}`, path: index === 2 ? "/project/b.ts" : "/project/src/a.ts",
      displayPath: index === 2 ? "b.ts" : index === 1 ? "./src/a.ts" : "src/a.ts", change: "modified",
      before: null, after: null, retainedLines: 2, renderedLines: index === 1 ? 7 : 2, omittedLines: index === 1 ? 5 : 0,
      addedLines: 1, removedLines: 1, conflictMarkers: false,
      patch: { kind: "retained", reference: { version: 1, root: String(index + 1).repeat(64), bytes: content.length, sha256: new Bun.CryptoHasher("sha256").update(content).digest("hex") } },
    },
  }))
  const secret = { ...entries[0]!, kind: "applied" as const, file: { ...entries[0]!.file,
    path: "/project/secret.ts", displayPath: "secret.ts", addedLines: 0, removedLines: 0, patch: { kind: "omitted" as const, reason: "sensitive" as const } } }
  const pages = [
    [entries[0]!, entries[2]!, secret, { kind: "not_applied" as const, path: "inspection.ts", reason: "conflict" }],
    [entries[1]!],
  ]
  const evidence = pages.map((files, index) => ({
    version: 2 as const, manifest: { version: 1 as const, root: String(index + 4).repeat(64), entries: files.length, bytes: 2048 },
    applied: index === 0 ? 3 : 1, retainedFiles: index === 0 ? 2 : 1, omissions: 1, notApplied: index === 0 ? 1 : 0,
    added: 0, modified: index === 0 ? 3 : 1, removed: 0, addedLines: index === 0 ? 2 : 1, removedLines: index === 0 ? 2 : 1, conflictMarkers: 0, samples: [],
  }))
  const requests: { type: string; root: string; offset: number }[] = []
  const query = runtimeQuery({
    mutationFiles: async (request) => {
      requests.push({ type: request.type, root: request.manifest.root, offset: request.offset })
      const files = pages[evidence.findIndex(item => item.manifest.root === request.manifest.root)]!
      const end = request.offset + 1
      return { kind: "available", sessionId: SESSION, manifest: request.manifest, requestedOffset: request.offset, offset: request.offset,
        totalFiles: files.length, totalBytes: 2048, files: files.slice(request.offset, end), nextOffset: end === files.length ? null : end }
    },
    mutationPatchWindow: async (request) => {
      requests.push({ type: request.type, root: request.reference.root, offset: request.offset })
      const content = bytes[Number(request.reference.root[0]) - 1]!
      const end = Math.min(content.length, request.offset + 2500)
      return { kind: "available", sessionId: SESSION, reference: request.reference, requestedOffset: request.offset, offset: request.offset,
        totalBytes: content.length, servedBytes: end - request.offset, base64: Buffer.from(content.subarray(request.offset, end)).toString("base64"),
        nextOffset: end === content.length ? null : end }
    },
  })
  const connection: Pick<RuntimeConnection, "query"> = { query }
  const reader = createMutationEvidenceReader({ connection, sessionId: SESSION })
  const calls = evidence.map((mutationEvidence, index) => rendered.tool({ id: `edit-${index}`, status: "completed", mutationEvidence }))
  const fold: TurnFold = { kind: "turnFold", id: "turn", answerId: "answer", open: false, timestamp: 0, duration: 1, rows: calls }
  const mounted = mountTurnChanges(fold, undefined, reader)
  try {
    await settle()
    assert.equal(requests.length, 0)
    assert.match(mounted.text(), /file count incomplete/)
    for (const observer of Array.from(observers)) if (observer.tag === "section") observer.show()
    await settle()
    assert.equal(requests.length, 2)
    assert.ok(requests.every(request => request.type === "mutationFiles"))
    assert.match(mounted.text(), /Changed 1 file \(incomplete\)/)
    assert.match(mounted.text(), /More files/)
    assert.match(mounted.text(), /a.ts/)
    for (let index = 0; index < 3; index++) { mounted.click("More files..."); await settle() }
    assert.equal(requests.length, 5)
    assert.match(mounted.text(), /edited 3 files/)
    assert.match(mounted.text(), /Changed 3 files/)
    assert.match(mounted.text(), /\+2-2partial/)
    assert.match(mounted.text(), /not shown: sensitive/)
    assert.doesNotMatch(mounted.text(), /inspection/)
    assert.deepEqual(mounted.hydrationRequests, [])
    // A final patch window shows only after its SHA-256 check, which runs off the thread and can land
    // after any fixed number of event-loop turns, so wait for the reader publication that renders it.
    const patchesShown = new Promise<void>((resolve) => {
      const stop = reader.onChange(() => { void settle().then(() => { if (mounted.html().includes("second")) { stop(); resolve() } }) })
    })
    mounted.disclosure.setOpen("render-ownership", "turn:changes:src/a.ts", true)
    // Visibility callbacks can replace proposal and continuation nodes in this registry.
    for (const observer of Array.from(observers)) if (observer.tag === "section") observer.show()
    await patchesShown
    assert.equal(requests.filter(request => request.type === "mutationPatchWindow").length, 2)
    assert.ok(mounted.html().indexOf("first") < mounted.html().indexOf("second"))
    assert.doesNotMatch(mounted.html(), /unrelated/)
    for (const observer of Array.from(observers)) if (observer.tag === "div") observer.show()
    await settle()
    assert.ok(requests.some(request => request.type === "mutationPatchWindow" && request.offset === 2500))
    assert.equal(requests.filter(request => request.type === "mutationFiles").length, 5)
    mounted.disclosure.setOpen("render-ownership", "turn:changes:src/a.ts", false)
    const before = requests.length
    mounted.setFold({ ...fold, open: true })
    await settle()
    assert.equal(requests.length, before)
    mounted.dispose()
    assert.equal(reader.heldBytes, 0)
  } finally {
    mounted.dispose()
    reader.dispose()
    if (original) Object.defineProperty(globalThis, "IntersectionObserver", original)
    else Reflect.deleteProperty(globalThis, "IntersectionObserver")
  }
})

test("turn cards do not recount for unrelated folds, bodies, or token publications", async () => {
  let reads = 0
  const fixture = await mutationEvidenceFixture({ version: 1, files: [{ path: "a.ts", change: "modified", unifiedDiff: "@@ -1 +1 @@\n-old\n+new" }], omissions: [] })
  const call = { ...rendered.tool({ status: "completed" }), get mutationEvidence() { reads++; return fixture.evidence } }
  await fixture.reader.open(`tool:${call.id}`, fixture.evidence.manifest).loadFiles()
  const fold: TurnFold = { kind: "turnFold", id: "turn", answerId: "answer", open: false, timestamp: 0, duration: 1, rows: [call] }
  const mounted = mountTurnChanges(fold, undefined, fixture.reader)
  try {
    assert.match(mounted.text(), /Changed 1 file/)
    const before = reads
    mounted.setFold({ ...fold, open: true, rows: [call] })
    mounted.disclosure.setOpen("render-ownership", "unrelated", true)
    mounted.setBodies({ unrelated: { blockId: "unrelated", content: "Body" } })
    mounted.setFold({ ...fold, rows: [call, { kind: "text", id: "other", content: "New token", timestamp: 1 }] })
    assert.equal(reads, before)
    mounted.setBodies({ [call.id]: { blockId: `tool:${call.id}`, mutationEvidence: { ...fixture.evidence } } })
    assert.match(mounted.text(), /Changed 1 file/)
    assert.deepEqual(mounted.hydrationRequests, [])
  } finally { mounted.dispose(); fixture.reader.dispose() }
})

test("turn cards never request whole-body hydration for absent mutation evidence", async () => {
  const call = { ...rendered.tool({ status: "completed" }), diffOmission: { kind: "aggregate" as const, omittedLines: 40 } }
  const fold: TurnFold = { kind: "turnFold", id: "turn", answerId: "answer", open: false, timestamp: 0, duration: 1, rows: [call] }
  const mounted = mountTurnChanges(fold)
  try {
    await settle()
    assert.deepEqual(mounted.hydrationRequests, [])
    mounted.setFold({ ...fold, rows: [call] })
    await settle()
    mounted.setBodies({ [call.id]: { blockId: `tool:${call.id}`, content: "ordinary output" } })
    mounted.setFold({ ...fold, open: true })
    assert.deepEqual(mounted.hydrationRequests, [])
  } finally { mounted.dispose() }
})

test("overlapping message mounts restore the original measurement globals in either disposal order", () => {
  const before = ["getComputedStyle", "ResizeObserver"].map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  const block: Extract<FrontendOutputBlock, { kind: "userMessage" }> = { kind: "userMessage", id: "overlap", content: "Text", timestamp: 0, pending: false, injected: false }
  for (const reverse of [false, true]) {
    const first = mountUserMessage(block)
    const second = mountUserMessage({ ...block, id: "second" })
    try {
      if (reverse) { second.dispose(); first.dispose() }
      else { first.dispose(); second.dispose() }
      assert.deepEqual(["getComputedStyle", "ResizeObserver"].map(name => Object.getOwnPropertyDescriptor(globalThis, name)), before)
    } finally { first.dispose(); second.dispose() }
  }
})

test("person text exposes a control only beyond eight rendered lines and keeps expansion through remounts", async () => {
  const block: Extract<FrontendOutputBlock, { kind: "userMessage" }> = { kind: "userMessage", id: "long", content: "A message that wraps", timestamp: 0, pending: false, injected: false }
  let mounted = mountUserMessage(block)
  try {
    await Promise.resolve()
    mounted.measureHeight(160)
    assert.doesNotMatch(mounted.text(), /Show more|Show less/)
    mounted.measureHeight(180)
    assert.match(mounted.text(), /Show more/)
    mounted.toggleText()
    assert.match(mounted.text(), /Show less/)
    const disclosure = mounted.disclosure
    mounted.dispose()
    mounted = mountUserMessage(block, undefined, disclosure)
    await Promise.resolve()
    mounted.measureHeight(180)
    assert.match(mounted.text(), /Show less/)
    mounted.toggleText()
    assert.match(mounted.text(), /Show more/)
    mounted.measureHeight(80)
    assert.doesNotMatch(mounted.text(), /Show more|Show less/)
  } finally { mounted.dispose() }
})
