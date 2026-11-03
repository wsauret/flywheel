import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { spyOn } from "bun:test"
import hljs from "highlight.js/lib/common"

import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import * as markdown from "./markdown.js"
import { createSessionChangesController } from "../../../src/protocol/client/session-changes.js"
import type { SessionChangeDiffResult, SessionChangeSummaryResult, SessionChangesSetViewedResult } from "../../../src/protocol/session-changes-protocol-types.js"
import { deferred, fileA, fileB, fileC, retainedDiff, runtime, settle, waitForDiff } from "../../../tests/unit/protocol/client/_session-changes-fixtures.js"

import { reviewWindow, mountTimedRows, mountUserMessage, mountTool, mountAgentGroup, mountChanges, mountReview } from "./render-ownership-loader-fixture.js"
import { longDiff, manualFrames } from "./changes-review-fixture.js"

function tool(content: string): FrontendToolEntry {
  return {
    kind: "tool", id: "ownership-tool", name: "example",
    presentation: { name: "Example", detail: "" },
    timestamp: 0, status: "completed", content, filetype: "ts",
  }
}

describe("mounted render ownership", () => {
  test("token-only publications do not reread settled time labels", () => {
    const blocks: FrontendOutputBlock[] = Array.from({ length: 100 }, (_, i) => ({ kind: "text", id: `timed-${i}`, timestamp: i * 1000, content: "Settled" }))
    const mounted = mountTimedRows(blocks)
    try {
      const before = mounted.reads()
      for (let i = 0; i < 8; i++) mounted.publish(blocks.map(block => block.kind === "text" ? { ...block, content: `token-${i}` } : block))
      assert.equal(mounted.reads(), before)
      mounted.publish([...blocks, { kind: "text", id: "new-tail", timestamp: 101000, content: "Next" }])
      assert.equal(mounted.reads(), before + 1)
      assert.match(mounted.text(), / · 2s/)
    } finally { mounted.dispose() }
  })
  test("sent image rows hydrate once and keep markers while ordered previews arrive", () => {
    const block: Extract<FrontendOutputBlock, { kind: "userMessage" }> = {
      kind: "userMessage", id: "userMessage:images", timestamp: 0,
      content: "Review these\n[Image #1]\n[Image #2]", pending: false, injected: false, imageCount: 2,
    }
    const mounted = mountUserMessage(block)
    try {
      assert.deepEqual(mounted.hydrationRequests, [block.id])
      assert.match(mounted.text(), /Review these\n\[Image #1\]\n\[Image #2\]/)
      assert.equal(mounted.images().length, 0)
      mounted.setBlock({ ...block, timestamp: 1 })
      assert.deepEqual(mounted.hydrationRequests, [block.id])
      mounted.setBody({ blockId: block.id, images: [
        { mediaType: "image/png", data: "first" },
        { mediaType: "image/jpeg", data: "second" },
      ] })
      assert.deepEqual(mounted.images().map(image => image.properties.src), [
        "data:image/png;base64,first", "data:image/jpeg;base64,second",
      ])
      assert.match(mounted.text(), /\[Image #1\]\n\[Image #2\]/)
      const onLoad = mounted.images()[0]?.properties.onLoad
      if (typeof onLoad !== "function") throw new Error("Missing image load notification")
      onLoad({})
      assert.equal(mounted.imageLoads(), 1)
      mounted.dispose()
      mounted.setBlock({ ...block, id: "userMessage:disposed" })
      assert.deepEqual(mounted.hydrationRequests, [block.id])
    } finally { mounted.dispose() }
  })

  test("image-only rows reuse a hydrated body while text-only rows never load one", () => {
    const block: Extract<FrontendOutputBlock, { kind: "userMessage" }> = {
      kind: "userMessage", id: "userMessage:saved", timestamp: 0,
      content: "[Image #1]", pending: false, injected: false, imageCount: 1,
    }
    const saved = mountUserMessage(block, {
      blockId: block.id, images: [{ mediaType: "image/png", data: "saved" }],
    })
    const text = mountUserMessage({
      kind: "userMessage", id: "userMessage:text", timestamp: 0,
      content: "Only text", pending: false, injected: false,
    })
    try {
      assert.deepEqual(saved.hydrationRequests, [])
      assert.equal(saved.images()[0]?.properties.src, "data:image/png;base64,saved")
      assert.match(saved.text(), /\[Image #1\]/)
      assert.deepEqual(text.hydrationRequests, [])
      assert.equal(text.images().length, 0)
    } finally {
      saved.dispose()
      text.dispose()
    }
  })

  test("a truncated agent group first renders its complete operation list from the top", () => {
    const operation = (id: string, detail: string): FrontendToolEntry => ({
      kind: "tool",
      id,
      name: "read",
      presentation: { name: "Read", detail },
      timestamp: id === "first" ? 1000 : 9000,
      status: "completed",
    })
    const first = operation("first", "first.ts")
    const tail = operation("tail", "tail.ts")
    const group: Extract<FrontendOutputBlock, { kind: "agentGroup" }> = {
      kind: "agentGroup", id: "agent-group",
      toolUseId: "subagent-call", containerKind: "subagent", label: "Explorer",
      description: "Inspect the transcript",
      status: "completed",
      children: [tail],
      totalToolCount: 2,
      timestamp: 0,
    }
    const mounted = mountAgentGroup(group)
    try {
      assert.equal(mounted.expansionPending(), true)
      mounted.open()
      assert.equal(mounted.hydrationRequests(), 1)
      assert.match(mounted.text(), /Loading what this agent did/)
      assert.doesNotMatch(mounted.text(), /tail\.ts/)

      mounted.setChildren({ children: [first, tail], total: 2 })
      const text = mounted.text()
      assert.doesNotMatch(text, /Loading what this agent did/)
      assert.match(text, /first\.ts/)
      assert.match(text, /tail\.ts/)
      assert.ok(text.indexOf("first.ts") < text.indexOf("tail.ts"))
      assert.match(text, / · 8s/)
    } finally { mounted.dispose() }
  })

  test("a complete agent group opens immediately without hydration", () => {
    const child: FrontendToolEntry = {
      kind: "tool", id: "only", name: "read",
      presentation: { name: "Read", detail: "only.ts" },
      timestamp: 0, status: "completed",
    }
    const mounted = mountAgentGroup({
      kind: "agentGroup", id: "complete-agent-group",
      toolUseId: "complete-subagent-call", containerKind: "subagent", label: "Explorer",
      description: "Inspect one file",
      status: "completed", children: [child], totalToolCount: 1, timestamp: 0,
    })
    try {
      assert.equal(mounted.expansionPending(), false)
      mounted.open()
      assert.equal(mounted.hydrationRequests(), 0)
      assert.doesNotMatch(mounted.text(), /Loading what this agent did/)
      assert.match(mounted.text(), /only\.ts/)
    } finally { mounted.dispose() }
  })

  test("a subagent line keeps its row and cells as its newest call changes and the run settles", () => {
    const group: Extract<FrontendOutputBlock, { kind: "agentGroup" }> = {
      kind: "agentGroup", id: "agent-line", toolUseId: "agent-line", containerKind: "subagent",
      label: "Explorer", description: "Inspect files", model: "test high",
      status: "active", children: [], totalToolCount: 1, timestamp: 0, duration: 2000,
      linkUri: "flywheel://session/child", activity: { name: "Read", detail: "first.ts" },
    }
    const mounted = mountAgentGroup(group)
    const cell = (name: string) => mounted.elements().find(node => String(node.properties.class).split(" ").includes(name))
    try {
      const row = cell("subagent-line")
      const glyph = cell("workflow-card-glyph")
      const detail = cell("workflow-card-detail")
      const time = cell("row-duration")
      assert.ok(row)
      assert.ok(glyph)
      assert.ok(detail)
      assert.ok(time)
      for (const update of [
        { ...group, activity: { name: "Tested", detail: "the renderer" } },
        { ...group, status: "completed" as const, summary: "Found the cause" },
      ]) {
        mounted.setBlock(update)
        assert.equal(cell("subagent-line"), row)
        assert.equal(cell("workflow-card-glyph"), glyph)
        assert.equal(cell("workflow-card-detail"), detail)
        assert.equal(cell("row-duration"), time)
        assert.equal(cell("workflow-card-time"), undefined)
        assert.ok(mounted.text().includes(update.status === "completed" ? "Found the cause" : "Tested the renderer"))
      }
      assert.match(mounted.text(), /✓Found the cause/)
      assert.doesNotMatch(mounted.text(), /first\.ts|Tested/)
    } finally { mounted.dispose() }
  })

  test("changes review keeps path-owned results through fresh records and drops removed files", () => {
    const changes = (content: string): Parameters<typeof mountChanges>[0] => ({
      version: 1, files: [{ path: "a.ts", change: "added", unifiedDiff: `@@ -0,0 +1 @@\n+${content}\n` }], omissions: [],
    })
    const render = spyOn(markdown, "renderCode")
    const mounted = mountChanges(changes("first"))
    try {
      assert.equal(render.mock.calls.length, 1)
      for (let revision = 0; revision < 8; revision++) mounted.setChanges(changes("first"))
      assert.equal(render.mock.calls.length, 1)
      mounted.setChanges(changes("second"))
      assert.equal(render.mock.calls.length, 2)
      mounted.setChanges(changes("first"))
      assert.equal(render.mock.calls.length, 3)
      mounted.setChanges({ version: 1, files: [], omissions: [] })
      assert.equal(render.mock.calls.length, 3)
      mounted.setChanges(changes("first"))
      assert.equal(render.mock.calls.length, 4)
      mounted.dispose()
      mounted.setChanges(changes("disposed"))
      assert.equal(render.mock.calls.length, 4)
    } finally {
      mounted.dispose()
      render.mockRestore()
    }
  })

  for (const kind of ["content", "invocation", "diff", "proposal"] as const) {
    test(`${kind} keeps only its current render until disclosure unmount`, () => {
      const entry = (source: string): FrontendToolEntry => {
        const base = tool(source)
        if (kind === "invocation") return { ...base, content: undefined, invocationBody: { content: source, filetype: "ts" } }
        if (kind === "diff") return { ...base, content: undefined, diff: `@@ -0,0 +1 @@\n+${source}\n` }
        if (kind === "proposal") return {
          ...base, status: "pending", content: undefined, fileChangeKind: "create",
          proposedDiff: { files: [{ id: "a.ts", path: "a.ts", action: "add",
            hunks: [{ id: "h", omittedBefore: 0, omittedAfter: 0,
              lines: [{ id: "line", kind: "add", text: source, partial: false }] }] }] },
        }
        return base
      }
      const render = spyOn(markdown, kind === "diff" ? "renderDiff" : "renderCode")
      const highlight = spyOn(hljs, "highlight")
      const mounted = mountTool(entry("const first = 1"))
      try {
        assert.equal(render.mock.calls.length, 1)
        for (let revision = 0; revision < 8; revision++) {
          mounted.setEntry({ ...entry("const first = 1"), timestamp: revision + 1 })
        }
        assert.equal(render.mock.calls.length, 1, "unrelated row updates must not repeat rendering")
        mounted.setEntry(entry("const second = 2"))
        assert.equal(render.mock.calls.length, 2, "changed input must replace the current result")
        mounted.setEntry(entry("const first = 1"))
        assert.equal(render.mock.calls.length, 3)
        if (kind !== "diff") assert.equal(highlight.mock.calls.length, 3, "old prefixes must be recomputed, not globally retained")
        mounted.setOpen(false)
        mounted.setEntry(entry("const hidden = 3"))
        assert.equal(render.mock.calls.length, 3, "closed bodies must have no live rendering computation")
        mounted.setEntry(entry("const first = 1"))
        mounted.setOpen(true)
        assert.equal(render.mock.calls.length, 4)
        if (kind !== "diff") assert.equal(highlight.mock.calls.length, 4, "remount must not reuse a disposed result")
        mounted.dispose()
        mounted.setEntry(entry("const disposed = 4"))
        assert.equal(render.mock.calls.length, 4)
      } finally {
        mounted.dispose()
        render.mockRestore()
        highlight.mockRestore()
      }
    })
  }
})

describe("mounted Changes boundary", () => {
  for (const proof of ["ready", "unavailable", "evidence"] as const) test(`keeps confirmation controls and focus through refresh and holds newer edits with ${proof} proof until cancelled`, async () => {
    const server = runtime()
    const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
    const mounted = mountReview(controller)
    try {
      await controller.start()
      await waitForDiff(controller, fileA.fileId)
      mounted.click("Undo", fileA.path)
      const confirm = mounted.buttonNode("Confirm", fileA.path)
      const cancel = mounted.buttonNode("Cancel", fileA.path)
      confirm.focus()
      server.breakLane()
      assert.equal(mounted.buttonNode("Confirm", fileA.path), confirm)
      assert.equal(mounted.buttonNode("Cancel", fileA.path), cancel)
      assert.equal(confirm.ownerDocument.activeElement, confirm)
      assert.equal(confirm.properties["aria-disabled"], true)
      mounted.click("Confirm", fileA.path)
      assert.equal(server.mutations.length, 0)
      server.lanes.open()
      await settle()
      assert.equal(mounted.buttonNode("Confirm", fileA.path), confirm)
      assert.equal(confirm.properties["aria-disabled"], undefined)
      assert.equal(confirm.ownerDocument.activeElement, confirm)
      if (proof === "unavailable") server.diffReplies.push(Promise.resolve({ status: "unavailable", revision: 10, reason: "unretained" }))
      if (proof === "evidence") server.diffReplies.push(Promise.resolve({
        ...retainedDiff(fileA.path, "+new edit", 1, 0, 10),
        diff: { path: fileA.path, change: fileA.change, patch: { kind: "unavailable" }, retainedLines: 0, renderedLines: 0, omittedLines: 0 },
      }))
      server.current.files = [{ ...fileA, editToken: { position: 10, eventId: "edit-a-2" } }, fileB]
      server.current.revision = 10
      server.change()
      if (proof !== "unavailable") await waitForDiff(controller, fileA.fileId, 10)
      else await settle()
      assert.equal(mounted.buttonNode("Confirm", fileA.path), confirm)
      assert.equal(mounted.buttonNode("Cancel", fileA.path), cancel)
      assert.equal(confirm.ownerDocument.activeElement, confirm)
      assert.equal(confirm.properties["aria-disabled"], true)
      assert.match(mounted.fileText(fileA.path), proof === "unavailable" ? /Exact evidence is unavailable/ : /File has newer edits/)
      mounted.click("Confirm", fileA.path)
      assert.equal(server.mutations.length, 0)
      if (proof !== "ready") {
        server.current.files = [fileA, fileB]
        server.current.revision = 11
        await controller.refresh()
        await waitForDiff(controller, fileA.fileId, 11)
        assert.equal(mounted.buttonNode("Confirm", fileA.path), confirm)
        assert.equal(mounted.buttonNode("Cancel", fileA.path), cancel)
        assert.equal(confirm.ownerDocument.activeElement, confirm)
        assert.equal(confirm.properties["aria-disabled"], undefined)
        server.current.gaps = 1
        await controller.refresh()
        assert.equal(confirm.properties["aria-disabled"], true)
      }
      mounted.click("Cancel", fileA.path)
      assert.doesNotMatch(mounted.fileText(fileA.path), /Undo all changes/)
    } finally { mounted.dispose(); controller.dispose() }
  })

  test("keeps file cards stable, replaces changed evidence, and reopens a newly edited file", async () => {
    const server = runtime()
    server.diffReplies.push(Promise.resolve(longDiff(fileA.path)))
    const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
    const mounted = mountReview(controller)
    try {
      await controller.start()
      await settle()
      await waitForDiff(controller, fileA.fileId)
      const node = mounted.fileNode(fileA.path)
      mounted.toggle(fileA.path)
      server.diffReplies.push(Promise.resolve(retainedDiff(fileA.path, `@@ -0,0 +1,45 @@\n${Array.from({ length: 45 }, (_, index) => `+net line ${index} edited again`).join("\n")}\n`, 45, 0, 9)))
      server.current.files = [{ ...fileA, editToken: { position: 9, eventId: "edit-a-2" } }, fileB]
      server.current.revision = 9
      server.change()
      await settle()
      await waitForDiff(controller, fileA.fileId, 9)
      assert.equal(mounted.fileNode(fileA.path), node)
      assert.match(mounted.fileText(fileA.path), /edited again/, "new evidence replaces the invalidated byte view")
      mounted.setViewed(fileA.path, true)
      await settle()
      assert.equal(mounted.checked(fileA.path), true)
      assert.doesNotMatch(mounted.fileText(fileA.path), /net line 0/)
      mounted.click("Undo", fileA.path)
      assert.match(mounted.fileText(fileA.path), /Undo all changes to a\.txt\?/)
      mounted.click("Cancel", fileA.path)
      assert.equal(mounted.fileNode(fileA.path), node)
      mounted.key(fileA.path, "Enter")
      await settle()
      await waitForDiff(controller, fileA.fileId)
      assert.equal(mounted.checked(fileA.path), false)
      assert.match(mounted.fileText(fileA.path), /net line 44/, "manual uncheck reveals the body with its disclosure preserved")
      mounted.setViewed(fileA.path, true)
      await settle()
      assert.equal(mounted.checked(fileA.path), true)

      server.diffReplies.push(Promise.resolve(longDiff(fileA.path, 11)))
      server.current.files = [{ ...fileA, editToken: { position: 11, eventId: "edit-a-3" }, review: { status: "unviewed" } }, fileB]
      server.current.revision = 11
      server.change()
      await settle()
      await waitForDiff(controller, fileA.fileId)
      assert.equal(mounted.fileNode(fileA.path), node)
      assert.equal(mounted.checked(fileA.path), false)
      assert.match(mounted.fileText(fileA.path), /net line 44/, "the prior full-diff disclosure remains while the updated file reopens")
    } finally { mounted.dispose(); controller.dispose() }
  })

  test("Viewed holds until the file's evidence arrives, then shows on the tapped file that its write works until the runtime answers", async () => {
    const server = runtime()
    const evidence = deferred<SessionChangeDiffResult>()
    server.diffReplies.push(evidence.promise)
    const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
    const mounted = mountReview(controller)
    try {
      await controller.start()
      await settle()
      assert.equal(mounted.viewedDisabled(fileA.path), true)
      mounted.setViewed(fileA.path, true)
      await settle()
      assert.equal(server.mutations.length, 0)
      evidence.resolve(retainedDiff(fileA.path, "+viewed evidence", 1, 0))
      await waitForDiff(controller, fileA.fileId)
      assert.equal(mounted.viewedDisabled(fileA.path), false)
      const answer = deferred<SessionChangesSetViewedResult>()
      server.viewedReplies.push(answer.promise)
      mounted.setViewed(fileA.path, true)
      await settle()
      assert.equal(mounted.viewedWorking(fileA.path), true)
      assert.equal(mounted.viewedWorking(fileB.path), false)
      answer.resolve({ status: "completed" })
      await settle()
      assert.equal(mounted.viewedWorking(fileA.path), false)
      assert.equal(mounted.checked(fileA.path), true)
    } finally { mounted.dispose(); controller.dispose() }
  })

  test("shows one status line per file that is not ready and withholds Undo from it", async () => {
    const server = runtime()
    server.current.files = [fileA, fileB, fileC]
    const pendingA = deferred<SessionChangeDiffResult>()
    server.diffReplies.push(pendingA.promise, Promise.resolve({ status: "unavailable", revision: 7, reason: "unretained" }), Promise.reject(new Error("diff socket closed")))
    const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
    const mounted = mountReview(controller)
    try {
      await controller.start()
      await settle()
      assert.match(mounted.fileText(fileA.path), /Loading\.\.\./)
      assert.match(mounted.fileText(fileB.path), /Diff not retained; Undo unavailable/)
      assert.match(mounted.fileText(fileC.path), /Diff unavailable: diff socket closed/)
      for (const file of [fileA, fileB, fileC]) assert.equal(mounted.disabled("Undo", file.path), true, file.path)
      pendingA.resolve({ status: "unavailable", revision: 7, reason: "drifted" })
      await settle()
      assert.match(mounted.fileText(fileA.path), /Changed outside this session since its last recorded write; Undo unavailable/)
      assert.equal(mounted.disabled("Undo", fileA.path), true)
      assert.doesNotMatch(mounted.text(), /Incomplete history/)
      server.current.gaps = 1
      server.change()
      await settle()
      assert.match(mounted.text(), /Incomplete history: some file changes are unknown; Undo unavailable/)
      for (const file of [fileA, fileB, fileC]) assert.equal(mounted.disabled("Undo", file.path), true, `${file.path} with gaps`)
      assert.equal(server.mutations.length, 0)
    } finally { mounted.dispose(); controller.dispose() }
  })

  test("unknown review authority keeps the diff reviewable and disables only Viewed", async () => {
    const server = runtime()
    server.current.files = [{ ...fileA, review: { status: "unknown" } }]
    server.current.fileCount = 1
    server.diffReplies.push(Promise.resolve(longDiff(fileA.path)))
    const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
    const mounted = mountReview(controller)
    try {
      await controller.start()
      await settle()
      await waitForDiff(controller, fileA.fileId)
      assert.match(mounted.fileText(fileA.path), /net line 19/)
      assert.match(mounted.fileText(fileA.path), /Review unknown/)
      assert.equal(mounted.viewedDisabled(fileA.path), true)
      assert.equal(mounted.disabled("Undo", fileA.path), false)
    } finally { mounted.dispose(); controller.dispose() }
  })

  test("coalesces anchor restores, uses the survivor's offset, and yields to user scroll", async () => {
    const callbacks = new Map<number, FrameRequestCallback>()
    const cancelled: number[] = []
    let nextFrame = 1
    const originalRequest = reviewWindow.requestAnimationFrame
    const originalCancel = reviewWindow.cancelAnimationFrame
    reviewWindow.requestAnimationFrame = callback => { const id = nextFrame++; callbacks.set(id, callback); return id }
    reviewWindow.cancelAnimationFrame = id => { cancelled.push(id); callbacks.delete(id) }
    const server = runtime()
    const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
    const mounted = mountReview(controller)
    try {
      await controller.start()
      await settle()
      mounted.setGeometry([{ path: fileA.path, top: -20, height: 50 }, { path: fileB.path, top: 30, height: 50 }])
      mounted.userScroll(100)

      server.current.files = [fileB]
      server.current.fileCount = 1
      server.current.revision = 8
      server.change()
      await settle()
      mounted.setGeometry([{ path: fileB.path, top: 50, height: 50 }])
      const restore = [...callbacks.entries()].at(-1)
      assert.ok(restore)
      callbacks.delete(restore[0])
      restore[1](0)
      assert.equal(mounted.scrollTop(), 120, "fallback uses b.txt's own prior offset")

      server.change()
      server.change()
      await settle()
      assert.ok(cancelled.length > 0, "a later update cancels a pending restore")
      mounted.userScroll(333)
      assert.equal(callbacks.size, 0, "user scroll cancels the scheduled callback")
      assert.equal(mounted.scrollTop(), 333, "user scroll cancels pending restoration")
    } finally {
      mounted.dispose(); controller.dispose()
      reviewWindow.requestAnimationFrame = originalRequest; reviewWindow.cancelAnimationFrame = originalCancel
    }
  })

  test("an editor target waits for the first list, then expands and scrolls to its file once", async () => {
    const frames = manualFrames()
    const server = runtime()
    const initial = deferred<SessionChangeSummaryResult>()
    server.summaryReplies.push(initial.promise)
    server.diffReplies.push(Promise.resolve(longDiff(fileA.path)), Promise.resolve(longDiff(fileB.path)))
    const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
    const mounted = mountReview(controller, { sessionId: "cold", path: fileB.path })
    try {
      const start = controller.start()
      await settle()
      assert.equal(mounted.count("changes-file"), 0)
      assert.match(mounted.text(), /Loading\.\.\./)
      initial.resolve({ snapshotPosition: 0, fileCount: 2, unknownFileMutationGaps: 0 })
      await start
      await settle()
      await waitForDiff(controller, fileB.fileId)
      assert.equal(mounted.scrolled(fileB.path), true)
      assert.equal(mounted.scrolled(fileA.path), false)
      assert.match(mounted.fileText(fileB.path), /net line 44/, "the targeted file opens expanded")
      assert.doesNotMatch(mounted.fileText(fileA.path), /net line 20/, "other files stay collapsed")
      mounted.toggle(fileB.path)
      assert.doesNotMatch(mounted.fileText(fileB.path), /net line 20/)
      server.change()
      await settle()
      assert.doesNotMatch(mounted.fileText(fileB.path), /net line 20/, "a refresh does not re-apply the target")
      assert.equal(server.mutations.length, 0)
    } finally { mounted.dispose(); controller.dispose(); frames.restore() }
  })

  test("an editor target stays at the top while the diffs above it load, until the person scrolls", async () => {
    const frames = manualFrames()
    const server = runtime()
    const diffA = deferred<SessionChangeDiffResult>()
    server.diffReplies.push(diffA.promise, Promise.resolve(longDiff(fileB.path)))
    const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
    const mounted = mountReview(controller, { sessionId: "cold", path: fileB.path })
    try {
      await controller.start()
      await settle()
      frames.run()
      assert.equal(mounted.scrolled(fileB.path), true)
      mounted.fileNode(fileB.path).properties.scrolledIntoView = undefined
      // The earlier file's diff lands after the target scrolled and grows it.
      diffA.resolve(longDiff(fileA.path))
      await settle()
      frames.run()
      assert.equal(mounted.scrolled(fileB.path), true, "the target is brought back to the top")

      mounted.fileNode(fileB.path).properties.scrolledIntoView = undefined
      mounted.ownerDispatch("wheel")
      server.change()
      await settle()
      frames.run()
      assert.equal(mounted.scrolled(fileB.path), false, "a person's scroll lets the target go")
    } finally { mounted.dispose(); controller.dispose(); frames.restore() }
  })

  test("an omitted display diff states the omission under one header while server reconstruction permits Undo", async () => {
    const server = runtime()
    server.current.files = [fileA]
    server.diffReplies.push(Promise.resolve({ status: "ready", revision: 7, lineCounts: { added: 1, removed: 1 }, diff: {
      path: fileA.path, change: "modified", retainedLines: 0, renderedLines: 0, omittedLines: 0,
      patch: { kind: "omitted", reason: "sensitive" },
    } }))
    const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
    const mounted = mountReview(controller)
    try {
      await controller.start()
      await settle()
      assert.match(mounted.fileText(fileA.path), /\/work\/a\.txt not shown \(sensitive\)/)
      assert.equal(mounted.count("changes-file-path"), 1, "one header")
      assert.equal(mounted.count("diff-file-header"), 0)
      assert.equal(mounted.count("mutation-omitted"), 1, "the diff renderer is the one omission owner")
      assert.equal(mounted.disabled("Undo", fileA.path), false)
    } finally { mounted.dispose(); controller.dispose() }
  })

  test("a relative editor target resolves against the execution directory", async () => {
    const frames = manualFrames()
    const server = runtime()
    server.diffReplies.push(Promise.resolve(longDiff(fileA.path)), Promise.resolve(longDiff(fileB.path)))
    const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
    const mounted = mountReview(controller, { sessionId: "cold", path: "b.txt" })
    try {
      await controller.start()
      await settle()
      await waitForDiff(controller, fileB.fileId)
      assert.equal(mounted.scrolled(fileB.path), true)
      assert.equal(mounted.scrolled(fileA.path), false)
      assert.match(mounted.fileText(fileB.path), /net line 44/)
      assert.doesNotMatch(mounted.fileText(fileA.path), /net line 20/)
    } finally { mounted.dispose(); controller.dispose(); frames.restore() }
  })

  test("Undo confirms inline and dispatches once; the outcome line stays until the next change", async () => {
    const server = runtime()
    const pendingB = deferred<SessionChangeDiffResult>()
    server.diffReplies.push(Promise.resolve(longDiff(fileA.path)), pendingB.promise)
    const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
    const mounted = mountReview(controller)
    try {
      await controller.start()
      await settle()
      await waitForDiff(controller, fileA.fileId)
      assert.equal(mounted.disabled("Undo", fileA.path), false)
      assert.equal(mounted.disabled("Undo", fileB.path), true, "a loading diff offers no Undo")
      mounted.click("Undo", fileA.path)
      assert.match(mounted.fileText(fileA.path), /Undo all changes to a\.txt\?/)
      assert.doesNotMatch(mounted.fileText(fileB.path), /Undo all changes/)
      mounted.click("Cancel", fileA.path)
      assert.doesNotMatch(mounted.text(), /Undo all changes/)
      assert.equal(server.mutations.length, 0)
      mounted.click("Undo", fileA.path)
      server.undoReplies.push(Promise.resolve({ status: "refused", message: "Changes have moved on; refresh and try again" }))
      mounted.click("Confirm", fileA.path)
      await settle()
      assert.equal(server.mutations.length, 1)
      assert.deepEqual(server.mutations[0], { type: "session.changes.undo", sessionId: "cold", fileId: fileA.fileId, revision: 7 })
      assert.match(mounted.fileText(fileA.path), /Undo refused: Changes have moved on; refresh and try again/)
      assert.doesNotMatch(mounted.text(), /Undo all changes/)
      server.change()
      await settle()
      assert.doesNotMatch(mounted.text(), /Undo refused/)
      mounted.click("Undo", fileA.path)
      server.undoReplies.push(Promise.reject(new Error("socket closed")))
      mounted.click("Confirm", fileA.path)
      await settle()
      assert.equal(server.mutations.length, 2)
      assert.match(mounted.fileText(fileA.path), /Undo outcome unknown; refreshing/)
      assert.doesNotMatch(mounted.text(), /refused/)
      server.current.files = [fileB]
      mounted.click("Undo", fileA.path)
      server.undoReplies.push(Promise.resolve({ status: "completed" }))
      mounted.click("Confirm", fileA.path)
      await settle()
      assert.equal(server.mutations.length, 3)
      assert.equal(mounted.count("changes-file"), 1, "a restored file leaves the list on refresh")
      assert.doesNotMatch(mounted.text(), /\/work\/a\.txt/)
      server.summaryReplies.push(Promise.reject(new Error("summary disconnected")))
      mounted.click("Refresh")
      await settle()
      assert.match(mounted.text(), /Changes unavailable: summary disconnected/)
    } finally { mounted.dispose(); controller.dispose() }
  })
})
