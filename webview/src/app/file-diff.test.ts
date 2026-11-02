import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { fileDiffFiles, type FileChangeBody } from "../../../src/protocol/client/file-change-body.js"
import { renderFileDiffLine, renderFileDiffRows } from "./file-diff.js"
import { createBlockDisclosure } from "./block-disclosure.js"
import type { FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { createMutationEvidenceReader } from "../../../src/protocol/client/mutation-evidence.js"
import type { MutationFilesView } from "../../../src/protocol/client/mutation-evidence.js"
import { fakeRuntimeConnection } from "../client/runtime-connection-fixture.js"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../test-support/import-built-module.js"
import { loadSolidFixture } from "../test-support/solid-transform.js"
import { collapsedPreview, mutationEvidenceFixture } from "../../../tests/unit/tui/output-blocks/_mutation-evidence-fixture.js"
import { mountFileDiff } from "./render-ownership-loader-fixture.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("tool-settlement-fixture.tsx", import.meta.url))],
  target: "bun", conditions: ["browser"], format: "esm",
  plugins: [{ name: "evidence-memory-host", setup(builder) {
    builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("memory-host"))
  } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const output = build.outputs.find(candidate => candidate.kind === "entry-point")
if (!output) throw new Error("Evidence fixture build produced no JavaScript")
const { mountToolRow }: typeof import("./tool-settlement-fixture.js") = await importBuiltModule(output)

const actualFixture = await mutationEvidenceFixture({
    version: 1,
    files: [{ path: "src/a.ts", change: "modified", unifiedDiff: "@@ -1,2 +1,2 @@\n-old\n+new\n same", omittedLines: 2 }],
    omissions: [],
})
const actual: FileChangeBody = { kind: "actual", mutationEvidence: actualFixture.evidence }
const actualHandle = actualFixture.reader.open("actual", actualFixture.evidence.manifest, { previews: true })
await actualHandle.loadFiles()
const actualPatch = actualHandle.patch(actualHandle.files.files[0]!)!
await actualPatch.continue()
const actualView = { files: actualHandle.files, patch: actualPatch.view }
actualFixture.reader.dispose()

const proposed: FileChangeBody = {
  kind: "proposed",
  proposedDiff: {
    files: [{
      id: "file-1",
      path: "src/a.ts",
      action: "update",
      hunks: [{ id: "hunk-1", oldStart: 1, newStart: 1, omittedBefore: 0, omittedAfter: 0, lines: [
        { id: "line-1", kind: "remove", text: "old", partial: false },
        { id: "line-2", kind: "add", text: "new", partial: true },
      ] }],
    }],
  },
}

describe("shared file diff model", () => {
  test("patches a growing proposal through partial-line completion and append", () => {
    const proposal = (text: string, partial: boolean, append = false): FileChangeBody => ({
      kind: "proposed", proposedDiff: { files: [{
        id: "file-1", path: "src/a.ts", action: "update", hunks: [{
          id: "hunk-1", oldStart: 1, newStart: 1, omittedBefore: 0, omittedAfter: 0,
          lines: [
            { id: "old", kind: "remove", text: "old line", partial: false },
            { id: "new", kind: "add", text, partial },
            ...(append ? [{ id: "append", kind: "add" as const, text: "next line", partial: false }] : []),
          ],
        }],
      }] },
    })
    const mounted = mountFileDiff(proposal("new", true))
    try {
      const body = mounted.body()
      assert.ok(body)
      // The memory host keeps parsed markup opaque. Native line and selection
      // continuity are checked in Chromium, where the browser parses it.
      const markup = body.childNodes[0]
      assert.ok(markup, "the diff must render parsed markup")
      for (const next of [proposal("new line", true), proposal("new line", false), proposal("new line", false, true)]) {
        mounted.publish(next)
        assert.equal(mounted.body(), body)
        assert.equal(body.childNodes[0], markup, "growth must patch the resident markup")
        assert.match(mounted.text(), /old line/)
        assert.match(mounted.text(), /new line/)
      }
      assert.doesNotMatch(mounted.text(), /diff-partial/)
      assert.match(mounted.text(), /next line/)
    } finally { mounted.dispose() }
  })
  test("bounds every proposal at its first twenty rows until expanded", () => {
    const body: FileChangeBody = { kind: "proposed", proposedDiff: { files: ["a", "b"].map((id) => ({
      id, path: `${id}.ts`, action: "add",
      hunks: [{ id: "h", omittedBefore: 3, omittedAfter: 2,
        lines: Array.from({ length: 25 }, (_, index) => ({ id: String(index), kind: "add", text: `line ${index}`, partial: index === 24 })),
      }],
    })) } }
    for (const file of fileDiffFiles(body)) {
      assert.equal(file.rows.length, 20)
      assert.equal(file.rows[0]?.id, "0")
      assert.equal(file.rows.at(-1)?.id, "19")
      assert.equal(file.omittedLines, 10)
    }
    for (const file of fileDiffFiles(body, true)) {
      assert.equal(file.rows.length, 25)
      assert.equal(file.rows.at(-1)?.id, "24")
      assert.equal(file.rows.at(-1)?.partial, true)
      assert.equal(file.omittedLines, 5)
    }
  })
  test("renders canonical and proposed changes through the same file and row shape", () => {
    const { evidence, evidenceStatus, ...actualFile } = fileDiffFiles(actual, false, "none", actualView)[0]!
    assert.equal(evidence?.patch.kind, "retained")
    assert.equal(evidenceStatus, "ready")
    assert.deepEqual([actualFile], [{
      id: "src/a.ts",
      path: "src/a.ts",
      action: "update",
      presentation: "edit",
      rows: [
        { id: "src/a.ts:0", kind: "remove", text: "old", oldLine: 1, partial: false },
        { id: "src/a.ts:1", kind: "add", text: "new", newLine: 1, partial: false },
        { id: "src/a.ts:2", kind: "context", text: "same", oldLine: 2, newLine: 2, partial: false },
      ],
      omittedLines: 2,
      sourceOmittedLines: 2,
      renderedLines: 3,
      expanded: false,
    }])
    assert.deepEqual(fileDiffFiles(proposed), [{
      id: "file-1",
      path: "src/a.ts",
      action: "update",
      presentation: "edit",
      rows: [
        { id: "line-1", kind: "remove", text: "old", oldLine: 1, partial: false },
        { id: "line-2", kind: "add", text: "new", newLine: 1, partial: true },
      ],
      omittedLines: 0,
      sourceOmittedLines: 0,
      renderedLines: 2,
      expanded: false,
    }])
  })

  test("keeps unnamed proposed files selectable without inventing a path", () => {
    const unnamed: FileChangeBody = { kind: "proposed", proposedDiff: { files: [{ id: "new", action: "add", hunks: [], }], unavailable: "malformed" } }
    assert.deepEqual(fileDiffFiles(unnamed), [{ id: "new", action: "add", presentation: "edit", rows: [], omittedLines: 0, sourceOmittedLines: 0, renderedLines: 0, expanded: false }])
  })

  test("keeps file actions and rename destinations visible", () => {
    const moved: FileChangeBody = {
      kind: "proposed",
      proposedDiff: { files: [{ id: "move", path: "src/old.ts", action: "delete", movePath: "src/new.ts", hunks: [] }] },
    }
    assert.deepEqual(fileDiffFiles(moved)[0], {
      id: "move",
      path: "src/old.ts",
      action: "delete",
      presentation: "edit",
      movePath: "src/new.ts",
      rows: [],
      omittedLines: 0,
      sourceOmittedLines: 0,
      renderedLines: 0,
      expanded: false,
    })
  })

  test("highlights known path languages while escaping partial markup immediately", () => {
    const html = renderFileDiffLine("const node = <tag>", "src/live.ts", true)
    assert.match(html, /hljs-keyword/)
    assert.match(html, /&lt;tag&gt;/)
    assert.doesNotMatch(html, /<tag>/)
  })
  test("renders the rows of a file as one static markup string", () => {
    const rows = fileDiffFiles(actual, false, "none", actualView)[0]?.rows ?? []
    const html = renderFileDiffRows(rows, "src/a.ts", false)
    assert.equal(html, [
      "<div class=\"diff-line diff-del\"><span class=\"diff-line-number\">1</span><span class=\"diff-line-number\"></span><span class=\"diff-marker\">-</span><span>old</span></div>",
      "<div class=\"diff-line diff-add\"><span class=\"diff-line-number\"></span><span class=\"diff-line-number\">1</span><span class=\"diff-marker\">+</span><span>new</span></div>",
      "<div class=\"diff-line diff-context\"><span class=\"diff-line-number\">2</span><span class=\"diff-line-number\">2</span><span class=\"diff-marker\"> </span><span>same</span></div>",
    ].join(""))
    const separated = renderFileDiffRows([
      ...rows,
      { id: "later-remove", kind: "remove", text: "later", oldLine: 12, partial: false },
      { id: "later-add", kind: "add", text: "replacement", newLine: 12, partial: false },
    ], "src/a.ts", false)
    assert.equal((separated.match(/class="diff-gap"/g) ?? []).length, 1)
    assert.match(separated, /9 unchanged lines/)
  })
  test("marks a partial streamed row and escapes its text", () => {
    const rows = fileDiffFiles(proposed)[0]?.rows ?? []
    const html = renderFileDiffRows(rows.map((row) => ({ ...row, text: "<b>" })), "src/a.ts", false)
    assert.match(html, /<span>&lt;b&gt;<\/span><\/div><div class="diff-line diff-add">.*<span class="diff-partial">&lt;b&gt;<\/span>/)
  })
  test("escapes edit code without syntax coloring", () => {
    assert.equal(renderFileDiffLine("const node = <tag>", "src/live.ts"), "const node = &lt;tag&gt;")
  })
  test("keeps disclosure attached through path arrival, canonical omissions, and reordering", () => {
    const disclosure = createBlockDisclosure()
    const first = { id: "file-0", path: "" }
    const second = { id: "file-1", path: "b.ts" }
    disclosure.setFileExpanded("s", "t", first, true)
    assert.equal(disclosure.fileExpanded("s", "t", { ...first, path: "a.ts" }), true)
    assert.equal(disclosure.fileExpanded("s", "t", second), false)
    assert.equal(disclosure.fileExpanded("s", "t", { id: "b.ts", path: "b.ts" }), false)
    assert.equal(disclosure.fileExpanded("s", "t", { id: "a.ts", path: "a.ts" }), true)
    disclosure.setFileExpanded("s", "t", { id: "a.ts", path: "a.ts" }, false)
    assert.equal(disclosure.fileExpanded("s", "t", first), false)
    assert.equal(disclosure.fileExpanded("other", "t", first), false)
  })
  test("preserves unnamed single-file expansion when completion first supplies the path", () => {
    const disclosure = createBlockDisclosure()
    disclosure.setFileExpanded("s", "t", { id: "file-0", path: "" }, true, true)
    assert.equal(disclosure.fileExpanded("s", "t", { id: "new.ts", path: "new.ts" }, true), true)
  })
})

test("disclosed web edits page metadata with collapsed previews and read bytes only for expanded files, preserving disclosure", async () => {
  const observers = new Set<{ tag?: string; show: () => void }>()
  const original = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver")
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: class {
    private observed?: { tag?: string; show: () => void }
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe(element: { tag?: string }) {
      this.observed = { tag: element.tag, show: () => this.callback([{ isIntersecting: true }]) }
      observers.add(this.observed)
    }
    disconnect() { if (this.observed) observers.delete(this.observed) }
  } })
  const flush = async () => { await new Promise<void>(resolve => { setImmediate(resolve) }) }
  const longPatch = `@@ -1 +1 @@\n-${"x".repeat(2400)}é${"y".repeat(6000)}\n+new\n`
  const writePatch = "@@ -0,0 +1 @@\n+const answer = '<tag>'\n"
  const patchBytes = [longPatch, writePatch].map(text => new TextEncoder().encode(text))
  const references = patchBytes.map((bytes, index) => ({
    version: 1 as const, root: String(index + 1).repeat(64), bytes: bytes.length,
    sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
  }))
  const entries: Extract<MutationFilesView["files"][number], { kind: "applied" }>[] = references.map((reference, index) => ({ kind: "applied", file: {
    version: 1, mutationId: `mutation-${index}`, path: `/project/${index}.ts`, displayPath: `src/${index}.ts`,
    change: index === 0 ? "modified" : "added", before: null, after: null,
    retainedLines: index === 0 ? 2 : 1, renderedLines: index === 0 ? 2 : 1,
    omittedLines: 0, addedLines: 1, removedLines: index === 0 ? 1 : 0,
    patch: { kind: "retained", reference }, conflictMarkers: false,
  } }))
  const omitted: MutationFilesView["files"][number] = { kind: "applied", file: {
    ...entries[0]!.file, mutationId: "sensitive", path: "/project/private.ts", displayPath: "private.ts",
    retainedLines: 0, renderedLines: 0, patch: { kind: "omitted", reason: "sensitive" },
  } }
  // The runtime serves each retained file's collapsed preview in the metadata page.
  const allEntries = [...entries.map((entry, index) => ({ ...entry, preview: collapsedPreview([longPatch, writePatch][index]!) })), omitted]
  const evidence: NonNullable<FrontendToolEntry["mutationEvidence"]> = {
    version: 2, manifest: { version: 1, root: "a".repeat(64), bytes: 2048, entries: 3 },
    applied: 3, retainedFiles: 2, omissions: 1, notApplied: 0, added: 1, modified: 2, removed: 0,
    addedLines: 2, removedLines: 1, conflictMarkers: 0, samples: [{ kind: "applied", path: "src/0.ts" }],
  }
  const requests: { type: string; offset: number }[] = []
  let unavailable = false
  let readError = false
  const connection = fakeRuntimeConnection({ queries: {
    mutationFiles: async query => {
      requests.push({ type: query.type, offset: query.offset })
      assert.equal(query.previews, true)
      if (readError) throw new Error("Read service disconnected")
      if (unavailable) return { kind: "unavailable", sessionId: "session-1", manifest: evidence.manifest, requestedOffset: query.offset, reason: "missing" }
      return { kind: "available", sessionId: "session-1", manifest: evidence.manifest,
        requestedOffset: query.offset, offset: query.offset, totalFiles: 3, totalBytes: 2048,
        files: allEntries.slice(query.offset, query.offset + 2), nextOffset: query.offset === 0 ? 2 : null }
    },
    mutationPatchWindow: async query => {
      requests.push({ type: query.type, offset: query.offset })
      const index = references.findIndex(reference => reference.root === query.reference.root)
      const bytes = patchBytes[index]!
      const end = Math.min(bytes.length, query.offset === 0 && index === 0 ? bytes.indexOf(0xc3) + 1 : query.offset + 3000)
      return { kind: "available", sessionId: "session-1", reference: query.reference, requestedOffset: query.offset,
        offset: query.offset, totalBytes: bytes.length, servedBytes: end - query.offset,
        base64: Buffer.from(bytes.subarray(query.offset, end)).toString("base64"), nextOffset: end === bytes.length ? null : end }
    },
  } })
  const reader = createMutationEvidenceReader({ connection, sessionId: "session-1" })
  // Counts the row's metadata reads, so a publication for another owner can be shown to re-run nothing here.
  let rowMetadataReads = 0
  const open = reader.open
  reader.open = (owner, manifest, openOptions) => {
    const handle = open(owner, manifest, openOptions)
    return owner !== "edit" ? handle : {
      get files() { rowMetadataReads += 1; return handle.files },
      loadFiles: () => handle.loadFiles(),
      patch: entry => handle.patch(entry),
    }
  }
  const patchSettled = async (index: number) => {
    const patch = reader.open("edit", evidence.manifest).patch(entries[index]!)!
    if (patch.view.status !== "loading") return
    await new Promise<void>(resolve => {
      const stop = reader.onChange(() => {
        if (patch.view.status !== "loading") { stop(); resolve() }
      })
    })
  }
  const initial: FrontendToolEntry = {
    kind: "tool", id: "edit", name: "apply_patch", fileChangeKind: "patch", declaresMutation: true,
    presentation: { name: "Edit", detail: "" }, timestamp: 0, status: "completed", mutationEvidence: evidence,
    content: "hidden command output", diffOmission: { kind: "aggregate", omittedLines: 999 },
  }
  const row = mountToolRow(initial, reader)
  try {
    await flush()
    assert.equal(requests.length, 0)
    assert.equal(observers.size, 0)
    row.open()
    await flush()
    assert.doesNotMatch(row.text(), /Proposed changes/)
    assert.match(row.text(), /Loading\.\.\./)
    assert.equal(requests.length, 0)
    ;[...observers][0]!.show()
    await flush()
    assert.deepEqual(requests, [{ type: "mutationFiles", offset: 0 }])
    assert.doesNotMatch(row.text(), /Load more files|Load more diff/)
    const sections = [...observers].filter(observer => observer.tag === "section")
    assert.equal(sections.length, 2)
    sections[0]!.show()
    await flush()
    // A collapsed file renders its preview, so a visible file reads no bytes.
    assert.equal(requests.filter(request => request.type === "mutationPatchWindow").length, 0)
    assert.doesNotMatch(row.text(), /proposed only|Proposed changes|hidden command output|�/)
    assert.match(row.files()[0]!.html, /é/)
    assert.doesNotMatch(row.files()[0]!.html, /diff-partial/)
    assert.match(row.files()[0]!.html, /diff-marker/)
    assert.doesNotMatch(row.files()[0]!.html, /hljs-keyword/)
    assert.equal(reader.open("edit", evidence.manifest).patch(entries[0]!)!.view.complete, false)
    sections[1]!.show()
    await flush()
    assert.match(row.files()[1]!.html, /hljs-keyword/)
    assert.match(row.files()[1]!.html, /&lt;tag&gt;/)
    assert.match(JSON.stringify(row.files()[1]!.style), /--fw-write-syntax-keyword/)
    assert.doesNotMatch(row.files()[1]!.html, /diff-marker/)
    const rowReads = rowMetadataReads
    assert.ok(rowReads > 0)
    open("neighbour", evidence.manifest).patch(entries[0]!)
    reader.release("neighbour")
    await flush()
    assert.equal(rowMetadataReads, rowReads)
    open("edit", evidence.manifest).patch({ ...entries[1]!, file: { ...entries[1]!.file, mutationId: "probe" } })
    await flush()
    assert.ok(rowMetadataReads > rowReads)
    row.click("src/0.ts")
    assert.deepEqual(row.openedPaths, ["/project/0.ts"])
    assert.equal(row.hydrationRequests(), 0)
    const before = requests.length
    row.settle({ ...initial, mutationEvidence: { ...evidence, manifest: { ...evidence.manifest } } })
    await flush()
    assert.equal(requests.length, before)
    assert.equal(requests.filter(request => request.type === "mutationPatchWindow").length, 0)
    row.click("Expand diff")
    await flush()
    await patchSettled(0)
    assert.match(row.text(), /Collapse diff/)
    assert.equal(requests.filter(request => request.type === "mutationPatchWindow").length, 1)
    assert.doesNotMatch(row.files()[0]!.html, /�/)
    const continued = requests.length
    ;[...observers].filter(observer => observer.tag === "div").at(-1)!.show()
    await flush()
    await patchSettled(0)
    assert.ok(requests.length > continued)
    while (!reader.open("edit", evidence.manifest).patch(entries[0]!)!.view.complete) {
      ;[...observers].filter(observer => observer.tag === "div").at(-1)!.show()
      await flush()
      await patchSettled(0)
    }
    assert.equal(reader.open("edit", evidence.manifest).patch(entries[0]!)!.view.text, longPatch)
    assert.match(row.files()[0]!.html, /é/)
    assert.equal(reader.open("edit", evidence.manifest).patch(entries[1]!)!.view.text, "")
    assert.equal(requests.filter(request => request.type === "mutationFiles").length, 1)
    ;[...observers].filter(observer => observer.tag === "div").at(-1)!.show()
    await flush()
    assert.match(row.text(), /private.ts not shown \(sensitive\)/)
    assert.equal(row.files().length, 3)
    assert.deepEqual(requests.filter(request => request.type === "mutationFiles").map(request => request.offset), [0, 2])
    row.close()
    await flush()
    assert.equal(reader.heldBytes, 0)
    assert.equal(observers.size, 0)
    row.open()
    await flush()
    assert.doesNotMatch(row.text(), /Proposed changes/)
    ;[...observers][0]!.show()
    await flush()
    assert.equal(requests.filter(request => request.type === "mutationFiles").length, 3)
    row.close()
    readError = true
    row.open()
    await flush()
    ;[...observers][0]!.show()
    await flush()
    assert.match(row.text(), /Could not load change evidence.*Retry/)
    assert.doesNotMatch(row.text(), /Change evidence is unavailable/)
    const failedReads = requests.length
    await flush()
    assert.equal(requests.length, failedReads)
    readError = false
    row.click("Retry")
    await flush()
    assert.doesNotMatch(row.text(), /Could not load change evidence/)
    assert.equal(requests.length, failedReads + 1)
    row.close()
    unavailable = true
    row.open()
    await flush()
    ;[...observers][0]!.show()
    await flush()
    assert.match(row.text(), /Change evidence is unavailable/)
    assert.doesNotMatch(row.text(), /Proposed changes|proposed only|hidden command output/)
  } finally {
    row.dispose()
    reader.dispose()
    if (original) Object.defineProperty(globalThis, "IntersectionObserver", original)
    else Reflect.deleteProperty(globalThis, "IntersectionObserver")
  }
})
