import { describe, expect, it } from "bun:test"
import type { ToolEntry as ToolEntryType } from "../../../../src/infra/output-blocks.js"
import type { MutationEvidenceHandle, MutationPatchHandle, MutationPatchView } from "../../../../src/protocol/client/mutation-evidence.js"
import { TOOL_PREVIEW_LINE_LIMIT } from "../../../../src/infra/output-blocks.js"
import { mutationEvidenceFixture } from "./_mutation-evidence-fixture.js"
import { renderToolEntries } from "./_tool-entry-render.js"
import { buildMutationDiff } from "../../../../src/infra/mutation-diff.js"

/** A two-hunk patch of `hunkLines` rendered rows behind file and hunk headers. */
function editDiff(hunkLines: number): string {
  const lines = ["--- a/src/example.ts", "+++ b/src/example.ts", "@@ -1,3 +1,3 @@", " const first = 1", "-const second = 2", "+const second = 3", "@@ -10,20 +10,20 @@"]
  for (let index = 0; index < hunkLines - 3; index += 1) lines.push(` const filler${index} = ${index}`)
  return lines.join("\n")
}

function editEntry(id: string, mutationEvidence: ToolEntryType["mutationEvidence"], fileChangeKind: "patch" | "create" = "patch"): ToolEntryType {
  return { kind: "tool", id, name: "edit", presentation: { name: "Edit", detail: "src/example.ts" }, status: "completed", fileChangeKind, mutationEvidence, timestamp: 1 }
}

type EvidenceFixture = Awaited<ReturnType<typeof mutationEvidenceFixture>>

/** Render one evidence row, expand it, then serve gated patch windows one at a time and
 * paint the first frame after each, until a painted frame asks for no further window. */
async function observeExpandedArrival(fixture: EvidenceFixture) {
  let gate = Promise.withResolvers<void>()
  fixture.holdPatches(gate.promise)
  const marker: ToolEntryType = { kind: "tool", id: "marker", name: "bash", presentation: { name: "Bash", detail: "END-MARKER" }, status: "completed", timestamp: 1 }
  const result = await renderToolEntries([editEntry("edit-1", fixture.evidence), marker], { height: 80, evidenceReader: fixture.reader })
  const lines = () => result.captureCharFrame().split("\n")
  const held = () => fixture.reader.open("tool:edit-1", fixture.evidence.manifest)
  const settled = () => fixture.entries.every(entry => held().patch(entry)?.view.status === "ready")
  // A painted frame acquires windows synchronously, so every loading patch waits at the gate here.
  const loadingPatches = () => fixture.entries.flatMap(entry => {
    const patch = held().patch(entry)
    return patch?.view.status === "loading" ? [patch] : []
  })
  try {
    await result.renderOnce()
    await held().loadFiles()
    await result.renderOnce()
    await result.mockMouse.click(4, 0)
    await result.renderOnce()
    const waiting = result.captureCharFrame()
    const frames: string[][] = []
    for (let loading = loadingPatches(); loading.length > 0; loading = loadingPatches()) {
      // Each released read either ends its request or asks for its next window at the new gate.
      const arrivals = loading.map(patch => Promise.race([patch.continue(), fixture.nextWindow(patch.view.reference)]))
      const next = Promise.withResolvers<void>()
      fixture.holdPatches(next.promise)
      gate.resolve()
      gate = next
      await Promise.all(arrivals)
      await result.renderOnce()
      frames.push(lines())
    }
    return { waiting, frames, settled: settled() }
  } finally { gate.resolve(); result.renderer.destroy(); fixture.reader.dispose() }
}

/** Render one collapsed evidence row above a marker, settle its metadata page, then paint more
 * frames. The marker's row tells whether the preview above it changed height after metadata. */
async function observeCollapsed(fixture: EvidenceFixture) {
  const marker: ToolEntryType = { kind: "tool", id: "marker", name: "bash", presentation: { name: "Bash", detail: "END-MARKER" }, status: "completed", timestamp: 1 }
  const result = await renderToolEntries([editEntry("edit-1", fixture.evidence), marker], { height: 80, evidenceReader: fixture.reader })
  const lines = () => result.captureCharFrame().split("\n")
  try {
    await result.renderOnce()
    await fixture.reader.open("tool:edit-1", fixture.evidence.manifest).loadFiles()
    await result.renderOnce()
    const frames: string[][] = [lines()]
    for (let frame = 0; frame < 3; frame++) {
      await fixture.settle()
      await result.renderOnce()
      frames.push(lines())
    }
    return { frames, rows: frames.map(frame => frame.findIndex(line => line.includes("END-MARKER"))),
      patchReads: fixture.calls.filter(call => call.type === "mutationPatchWindow").length }
  } finally { result.renderer.destroy(); fixture.reader.dispose() }
}

describe("tool entry evidence publications", () => {
  it("re-runs only the row whose evidence publishes, so work per publication does not grow with mounted rows", async () => {
    const fixture = await mutationEvidenceFixture([{ path: "src/first.ts", patch: editDiff(26), lines: 26 }])
    const blocks = Array.from({ length: 8 }, (_row, index) => editEntry(`edit-${index}`, fixture.evidence))
    const result = await renderToolEntries(blocks, { height: 64, evidenceReader: fixture.reader })
    try {
      for (let frame = 0; frame < 4; frame++) { await result.renderOnce(); await fixture.settle() }
      expect(result.captureCharFrame()).toContain("const first = 1")
      const opens = new Map<string, number>()
      const open = fixture.reader.open
      fixture.reader.open = (ownerId, manifest, openOptions) => {
        opens.set(ownerId, (opens.get(ownerId) ?? 0) + 1)
        return open(ownerId, manifest, openOptions)
      }
      // Publications without a frame between them: each re-run is reactive work, not layout.
      const held = open("tool:edit-0", fixture.evidence.manifest)
      for (let publication = 0; publication < 4; publication++) {
        held.patch(fixture.entries[0]!)!.release()
        held.patch(fixture.entries[0]!)
      }
      expect(opens.get("tool:edit-0")).toBeGreaterThan(0)
      expect([...opens.keys()]).toEqual(["tool:edit-0"])
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it.each([2, 8])("rebuilds only the file whose patch view changed among %i files of one owner", async (fileCount) => {
    const paths = Array.from({ length: fileCount }, (_file, index) => `src/file${index}.ts`)
    const fixture = await mutationEvidenceFixture(paths.map(path => ({ path, patch: editDiff(8).replaceAll("src/example.ts", path), lines: 8 })))
    // Count reads of each file's patch text: building a file's model reads it, and the cheap
    // per-publication identity check reads only the view reference.
    const textReads = new Map<string, number>()
    const views = new WeakMap<MutationPatchView, MutationPatchView>()
    const patches = new WeakMap<MutationPatchHandle, MutationPatchHandle>()
    const handles = new WeakMap<MutationEvidenceHandle, MutationEvidenceHandle>()
    const counted = (view: MutationPatchView, path: string) => {
      let countedView = views.get(view)
      if (!countedView) {
        countedView = {
          status: view.status, reference: view.reference, nextOffset: view.nextOffset, complete: view.complete,
          ...(view.message === undefined ? {} : { message: view.message }),
          get text() {
            textReads.set(path, (textReads.get(path) ?? 0) + 1)
            return view.text
          },
        }
        views.set(view, countedView)
      }
      return countedView
    }
    const open = fixture.reader.open
    fixture.reader.open = (ownerId, manifest, openOptions) => {
      const handle = open(ownerId, manifest, openOptions)
      let wrapped = handles.get(handle)
      if (!wrapped) {
        wrapped = {
          get files() { return handle.files },
          loadFiles: () => handle.loadFiles(),
          patch(entry) {
            const patch = handle.patch(entry)
            if (!patch || (entry.kind !== "applied" && entry.kind !== "display")) return patch
            const path = entry.file.path
            let wrappedPatch = patches.get(patch)
            if (!wrappedPatch) {
              wrappedPatch = { get view() { return counted(patch.view, path) }, continue: (rows, columns) => patch.continue(rows, columns), release: () => patch.release() }
              patches.set(patch, wrappedPatch)
            }
            return wrappedPatch
          },
        }
        handles.set(handle, wrapped)
      }
      return wrapped
    }
    // Only an expanded file reads its patch, so every file starts expanded.
    const disclosure = { disclosure: (key: string) => key.includes("#diff:") ? true : undefined, setDisclosure: () => {} }
    const result = await renderToolEntries([editEntry("edit-many", fixture.evidence)], { height: 200, evidenceReader: fixture.reader, disclosure })
    try {
      for (let frame = 0; frame < 4; frame++) { await result.renderOnce(); await fixture.settle() }
      expect(result.captureCharFrame()).toContain(`src/file${fileCount - 1}.ts`)
      textReads.clear()
      const held = open("tool:edit-many", fixture.evidence.manifest)
      for (let publication = 0; publication < 4; publication++) {
        held.patch(fixture.entries[0]!)!.release()
        held.patch(fixture.entries[0]!)
      }
      expect(textReads.get(paths[0]!)).toBeGreaterThan(0)
      expect([...textReads.keys()]).toEqual([paths[0]!])
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it("reads each file's expanded state once, not again on every painted frame", async () => {
    const fixture = await mutationEvidenceFixture([{ path: "src/first.ts", patch: editDiff(8), lines: 8 }, { path: "src/second.ts", patch: editDiff(8), lines: 8 }])
    // A frame callback that reads the row's expanded prop creates an unowned memo per read,
    // which stays subscribed to the row until a later update overruns Solid's queue.
    let reads = 0
    const disclosure = { disclosure: (key: string) => { if (key.includes("#diff:")) reads += 1; return key.includes("#diff:") ? true : undefined }, setDisclosure: () => {} }
    const result = await renderToolEntries([editEntry("edit-frames", fixture.evidence)], { height: 80, evidenceReader: fixture.reader, disclosure })
    try {
      for (let frame = 0; frame < 4; frame++) { await result.renderOnce(); await fixture.settle() }
      expect(result.captureCharFrame()).toContain("src/second.ts")
      reads = 0
      for (let frame = 0; frame < 8; frame++) await result.renderOnce()
      expect(reads).toBe(0)
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it("gives each collapsed file its final rows from the metadata page, with no patch read", async () => {
    const fixture = await mutationEvidenceFixture([
      { path: "src/long.ts", patch: editDiff(26), lines: 26 },
      { path: "src/short.ts", patch: editDiff(8), lines: 8 },
    ], { windowBytes: 120 })
    const observed = await observeCollapsed(fixture)
    const first = observed.frames[0]!.join("\n")
    expect(first).toContain("src/short.ts")
    expect(first.match(/const first = 1/g)).toHaveLength(2)
    expect(first).toContain("const filler4 = 4")
    expect(first).toContain("+6 lines (click to expand)")
    expect(first).not.toContain("Loading")
    expect(observed.patchReads).toBe(0)
    expect(observed.rows.filter(row => row !== observed.rows[0])).toEqual([])
  })

  it("wraps a collapsed long-line file to the preview rows at its final height when metadata settles", async () => {
    const before = Array.from({ length: 6 }, (_line, index) => `const value${index} = ${index}`).join("\n")
    const after = Array.from({ length: 6 }, (_line, index) => `const value${index} = "${"word ".repeat(30)}tail${index}"`).join("\n")
    const fixture = await mutationEvidenceFixture(buildMutationDiff([{ path: "src/example.ts", before: { kind: "text", text: before }, after: { kind: "text", text: after } }]), { windowBytes: 120 })
    const observed = await observeCollapsed(fixture)
    const first = observed.frames[0]!
    // Six removed lines, then added lines that wrap under their code until the preview rows end.
    expect(first.filter(line => /const value|word|tail/.test(line))).toHaveLength(TOOL_PREVIEW_LINE_LIMIT)
    expect(first.join("\n")).toContain("tail0")
    expect(first.join("\n")).not.toContain("tail5")
    expect(first.join("\n")).toContain("click to expand")
    expect(observed.patchReads).toBe(0)
    expect(observed.rows.filter(row => row !== observed.rows[0])).toEqual([])
  })

  it("offers the header chevron for a line the preview byte bound hides, and expands the file from it", async () => {
    const patch = `--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1,3 +1,3 @@\n+const shown1 = 1\n+const shown2 = 2\n+${"x".repeat(20_000)}`
    const fixture = await mutationEvidenceFixture([{ path: "src/example.ts", patch, lines: 3 }])
    const result = await renderToolEntries([editEntry("edit-1", fixture.evidence)], { height: 64, evidenceReader: fixture.reader })
    const frame = async () => {
      for (let step = 0; step < 3; step++) { await result.renderOnce(); await fixture.settle() }
      return result.captureCharFrame().split("\n")
    }
    try {
      const collapsed = await frame()
      expect(collapsed.join("\n")).toContain("const shown2 = 2")
      expect(collapsed.join("\n")).not.toContain("xxxx")
      expect(collapsed.join("\n")).toContain("... +1 lines (click to expand)")
      expect(collapsed[0]).toContain("▸")
      await result.mockMouse.click(4, 0)
      const expanded = await frame()
      expect(expanded[0]).toContain("▾")
      expect(expanded.join("\n")).toContain("xxxx")
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })

  it("shows no loading row for a created empty file", async () => {
    const fixture = await mutationEvidenceFixture(buildMutationDiff([{ path: "src/empty.ts", before: { kind: "absent" }, after: { kind: "text", text: "" } }]))
    const observed = await observeCollapsed(fixture)
    expect(observed.frames.map(frame => frame.join("\n")).filter(frame => frame.includes("Loading"))).toEqual([])
    expect(observed.patchReads).toBe(0)
    expect(observed.rows.filter(row => row !== observed.rows[0])).toEqual([])
  })

  it("shows the loading cue after the loaded rows of an expanded file", async () => {
    const fixture = await mutationEvidenceFixture([{ path: "src/example.ts", patch: editDiff(40), lines: 40 }], { windowBytes: 120 })
    const arrival = await observeExpandedArrival(fixture)
    // While the reply is held, the expanded file keeps its collapsed preview rows above the cue.
    const waiting = arrival.waiting.split("\n")
    const waitingCue = waiting.findIndex(line => line.includes("Loading..."))
    expect(waiting[waitingCue - 1]).toContain("const filler16 = 16")
    expect(arrival.settled).toBe(true)
    const partial = arrival.frames.filter(frame => frame.some(line => line.includes("const first = 1")) && frame.some(line => line.includes("Loading")))
    expect(partial.length).toBeGreaterThan(1)
    for (const frame of partial) {
      const lastLoaded = frame.findLastIndex(line => line.includes("const"))
      const cue = frame.findIndex(line => line.includes("Loading"))
      expect(cue).toBe(lastLoaded + 1)
      // Arriving bytes only add rows below the preview.
      expect(frame.slice(0, waitingCue)).toEqual(waiting.slice(0, waitingCue))
    }
    expect(arrival.frames.at(-1)!.join("\n")).not.toContain("Loading")
    expect(arrival.frames.at(-1)!.join("\n")).toContain("const filler36 = 36")
  })

  // The preview byte bound cuts a line longer than it, so the preview holds as many rows as the
  // whole file while its bytes are still expected.
  it.each(["patch", "create"] as const)("shows the loading cue under a preview cut inside one long line, then the whole line (%s)", async (fileChangeKind) => {
    const patch = `--- /dev/null\n+++ b/src/example.ts\n@@ -0,0 +1,1 @@\n+${"x".repeat(18_000)}END-OF-LINE`
    const fixture = await mutationEvidenceFixture([{ path: "src/example.ts", patch, lines: 1, change: "added" }], { windowBytes: 32_768 })
    const gate = Promise.withResolvers<void>()
    fixture.holdPatches(gate.promise)
    const result = await renderToolEntries([editEntry("edit-1", fixture.evidence, fileChangeKind)], { height: 80, width: 400, evidenceReader: fixture.reader })
    try {
      await result.renderOnce()
      await fixture.reader.open("tool:edit-1", fixture.evidence.manifest).loadFiles()
      await result.renderOnce()
      await result.mockMouse.click(4, 0)
      await result.renderOnce()
      const waiting = result.captureCharFrame()
      expect(waiting).toContain("xxxx")
      expect(waiting).toContain("Loading...")
      expect(waiting).not.toContain("END-OF-LINE")
      gate.resolve()
      for (let step = 0; step < 3; step++) { await fixture.settle(); await result.renderOnce() }
      const loaded = result.captureCharFrame()
      expect(loaded).toContain("END-OF-LINE")
      expect(loaded).not.toContain("Loading...")
    } finally { gate.resolve(); result.renderer.destroy(); fixture.reader.dispose() }
  })

  it.each([["error", "Could not load change evidence."], ["missing", "Change evidence is unavailable"]] as const)("shows a final %s read without the loading cue", async (failure, message) => {
    const fixture = await mutationEvidenceFixture([{ path: "src/example.ts", patch: editDiff(40), lines: 40 }], { windowBytes: 120 })
    const result = await renderToolEntries([editEntry("edit-1", fixture.evidence)], { height: 80, evidenceReader: fixture.reader })
    try {
      await result.renderOnce()
      await fixture.reader.open("tool:edit-1", fixture.evidence.manifest).loadFiles()
      await result.renderOnce()
      fixture.failPatches(failure)
      await result.mockMouse.click(4, 0)
      for (let step = 0; step < 3; step++) { await result.renderOnce(); await fixture.settle() }
      const frame = result.captureCharFrame()
      expect(frame).toContain(message)
      expect(frame).not.toContain("Loading")
    } finally { result.renderer.destroy(); fixture.reader.dispose() }
  })
})
