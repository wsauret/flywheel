import { expect, test } from "bun:test"
import type { AttachedRuntimeClient } from "../../../../src/protocol/app-service-types.js"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { createSessionChangesController } from "../../../../src/protocol/client/session-changes.js"
import type { SessionChangeDiffResult, SessionChangeSummaryResult, SessionChangesResult, SessionChangesSetViewedResult } from "../../../../src/protocol/session-changes-protocol-types.js"
import { deferred, diff, diffQueries, fileA, fileB, fileC, list, listQueries, opened, retainedDiff, runtime, settle } from "./_session-changes-fixtures.js"

test("construction is passive and start acquires the summary", async () => {
  let reads = 0
  const client: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane"> = {
    query: async () => { reads++; throw new Error("offline") },
    dispatch: async () => { throw new Error("unexpected mutation") },
    subscribe: () => () => {},
    onLane: fakeLanes().onLane,
  }
  const controller = createSessionChangesController({ client, sessionId: "cold" })
  expect(reads).toBe(0)
  expect(controller.snapshot.summary.status).toBe("idle")
  expect(controller.snapshot.list).toEqual({ status: "idle" })
  await controller.start()
  expect(reads).toBe(1)
  expect(controller.snapshot.summary.status).toBe("error")
  controller.dispose()
})

test("zero, loading, failed, and incomplete counts are different states", async () => {
  const server = runtime()
  const pending = deferred<SessionChangeSummaryResult>()
  server.summaryReplies.push(pending.promise)
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  const work = controller.start()
  expect(controller.snapshot.summary).toEqual({ status: "loading" })
  expect(server.subscribers).toBe(1)
  pending.resolve({ fileCount: 0, unknownFileMutationGaps: 0, snapshotPosition: 0 })
  await work
  expect(controller.snapshot.summary).toEqual({ status: "ready", data: { fileCount: 0, unknownFileMutationGaps: 0, snapshotPosition: 0 } })
  await controller.start()
  expect(server.queries).toHaveLength(1)
  server.current.gaps = 2
  server.current.fileCount = 0
  await controller.refresh()
  expect(controller.snapshot.summary).toEqual({ status: "incomplete", data: { fileCount: 0, unknownFileMutationGaps: 2, snapshotPosition: 0 } })
  const failed = deferred<SessionChangeSummaryResult>()
  server.summaryReplies.push(failed.promise)
  const refresh = controller.refresh()
  failed.reject(new Error("history unavailable"))
  await refresh
  expect(controller.snapshot.summary).toMatchObject({ status: "error", error: "history unavailable", data: { unknownFileMutationGaps: 2 } })
  expect(listQueries(server.queries)).toHaveLength(0)
  controller.dispose()
  expect(server.subscribers).toBe(0)
  expect(server.closed).toBe(false)
})

test("review can open before readiness without acquiring history", async () => {
  const server = runtime()
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  await controller.openReview()
  expect(server.queries).toHaveLength(0)
  expect(server.subscribers).toBe(0)
  await controller.start()
  await settle()
  expect(listQueries(server.queries)).toHaveLength(1)
  expect(controller.snapshot.list).toEqual({ status: "ready", data: list() })
  controller.dispose()
})

test("a ready list fans out requested diffs in order with at most two in flight", async () => {
  const server = runtime()
  server.current.files = [fileA, fileB, fileC]
  const first = deferred<SessionChangeDiffResult>()
  const second = deferred<SessionChangeDiffResult>()
  server.diffReplies.push(first.promise, second.promise)
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  controller.setVisibleFiles([fileA.fileId, fileB.fileId, fileC.fileId])
  await controller.start()
  await controller.openReview()
  await settle()
  expect(listQueries(server.queries)).toEqual([{ type: "sessionChanges", sessionId: "cold", offset: 0, maxFiles: 128, maxBytes: 64 * 1024 }])
  expect(diffQueries(server.queries).map(query => query.fileId)).toEqual([fileA.fileId, fileB.fileId])
  expect([...controller.snapshot.diffs.entries()]).toEqual([[fileA.fileId, { status: "loading" }], [fileB.fileId, { status: "loading" }], [fileC.fileId, { status: "loading" }]])
  expect(controller.canUndo(fileA.fileId)).toBe(false)
  second.resolve({ status: "unavailable", revision: 7, reason: "drifted" })
  await settle()
  expect(diffQueries(server.queries).map(query => query.fileId)).toEqual([fileA.fileId, fileB.fileId, fileC.fileId])
  expect(diffQueries(server.queries).every(query => query.revision === 7 && query.sessionId === "cold")).toBe(true)
  expect(controller.snapshot.diffs.get(fileB.fileId)).toEqual({ status: "unavailable", reason: "drifted" })
  expect(controller.snapshot.diffs.get(fileC.fileId)).toEqual({ status: "ready", complete: true, lineCounts: { added: 0, removed: 0 }, diff: { version: 1, files: [{ path: fileC.fileId, change: "modified", unifiedDiff: `PATCH ${fileC.fileId}` }], omissions: [] } })
  expect(controller.canUndo(fileC.fileId)).toBe(true)
  expect(controller.canUndo(fileB.fileId)).toBe(false)
  expect(controller.undoUnavailableReason(fileB.fileId)).toBe("File changed outside this session")
  first.reject(new Error("diff lost"))
  await settle()
  expect(controller.snapshot.diffs.get(fileA.fileId)).toEqual({ status: "error", error: "diff lost" })
  expect(diffQueries(server.queries)).toHaveLength(3)
  await controller.refresh()
  await settle()
  expect(diffQueries(server.queries)).toHaveLength(4)
  expect(controller.snapshot.diffs.get(fileA.fileId)?.status).toBe("ready")
  controller.dispose()
})

test("server-proven reconstruction permits Undo even when its derived display patch is truncated", async () => {
  const server = runtime()
  const derived = retainedDiff(fileA.path, "@@ -0,0 +1,1000 @@\n+prefix", 1200)
  server.diffReplies.push(Promise.resolve({ ...derived, diff: { ...derived.diff, omittedLines: 200, renderedLines: 1200 } }))
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  controller.setVisibleFiles([fileA.fileId])
  try {
    await controller.start()
    await controller.openReview()
    await settle()
    expect(controller.canUndo(fileA.fileId)).toBe(true)
    expect(controller.undoUnavailableReason(fileA.fileId)).toBeUndefined()
    expect(controller.requestUndo(fileA.fileId)).toBe(true)
  } finally { controller.dispose() }
})

test("loads metadata pages only on continuation and previews only requested files", async () => {
  const server = runtime()
  server.current.files = [fileA, fileB, fileC]
  server.current.pageSize = 1
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  await controller.start()
  await controller.openReview()
  expect(listQueries(server.queries)).toHaveLength(1)
  expect(diffQueries(server.queries)).toEqual([])
  controller.setVisibleFiles([fileA.fileId])
  await settle()
  expect(diffQueries(server.queries).map(query => query.fileId)).toEqual([fileA.fileId])
  await controller.loadMoreFiles()
  expect(listQueries(server.queries)[1]).toMatchObject({ offset: 1, cursor: list(7, [fileA, fileB, fileC]).cursor, revision: 7 })
  expect(diffQueries(server.queries)).toHaveLength(1)
  controller.setVisibleFiles([fileB.fileId])
  await settle()
  await controller.loadMoreFiles()
  expect(controller.snapshot.list).toEqual({ status: "ready", data: list(7, [fileA, fileB, fileC]) })
  expect(diffQueries(server.queries).map(query => query.fileId)).toEqual([fileA.fileId, fileB.fileId])
  controller.dispose()
})

test("finds a later host target through metadata without opening earlier patches", async () => {
  const server = runtime()
  server.current.files = [fileA, fileB, fileC]
  server.current.pageSize = 1
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  controller.setVisibleFiles([fileA.fileId])
  await controller.start()
  await controller.openReview("./c.txt")
  await settle()
  expect(listQueries(server.queries).map(query => query.offset ?? 0)).toEqual([0, 1, 2])
  expect(diffQueries(server.queries).map(query => query.fileId)).toEqual([fileC.fileId])
  expect(controller.snapshot.diffs.has(fileA.fileId)).toBe(false)
  expect(controller.snapshot.diffs.get(fileC.fileId)?.status).toBe("ready")
  // A change between pages shows the pages read and keeps the target for the pass that follows.
  controller.closeReview()
  const followUp = deferred<SessionChangeSummaryResult>()
  server.summaryReplies.push(followUp.promise)
  server.listReplies.push(Promise.resolve({ ...list(8, [fileA, fileB, fileC]), files: [fileA], nextOffset: 1 }), Promise.resolve({ ...list(9, [fileA, fileB, fileC]), offset: 1, status: "stale", files: [], nextOffset: null }))
  server.current.revision = 9
  const diffs = diffQueries(server.queries).length
  const reopened = controller.openReview("./c.txt")
  await settle()
  expect(controller.snapshot.list).toEqual({ status: "loading", data: { ...list(8, [fileA, fileB, fileC]), files: [fileA], nextOffset: 1 } })
  expect(controller.snapshot.summary.status).toBe("loading")
  followUp.resolve({ snapshotPosition: 0, fileCount: 3, unknownFileMutationGaps: 0 })
  await reopened
  await settle()
  expect(controller.snapshot.list).toEqual({ status: "ready", data: list(9, [fileA, fileB, fileC]) })
  expect(diffQueries(server.queries).slice(diffs).map(query => query.fileId)).toEqual([fileC.fileId])
  controller.dispose()
})

test("refresh, Viewed and stale continuation replace the whole loaded extent without mixing revisions", async () => {
  const server = runtime()
  server.current.files = [fileA, fileB, fileC]
  server.current.pageSize = 1
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  controller.setVisibleFiles([fileA.fileId])
  await controller.start()
  await controller.openReview()
  await controller.loadMoreFiles()
  await settle()
  const previous = controller.snapshot.list
  const pending = deferred<SessionChangesResult>()
  server.listReplies.push(Promise.resolve({ ...list(8, [fileA, fileB, fileC]), files: [fileA], nextOffset: 1 }), pending.promise)
  server.current.revision = 8
  const refresh = controller.refresh()
  await settle()
  expect(controller.snapshot.list).toEqual({ status: "loading", data: "data" in previous ? previous.data : undefined })
  pending.resolve({ ...list(8, [fileA, fileB, fileC]), offset: 1, files: [fileB], nextOffset: 2 })
  await refresh
  await settle()
  expect(controller.snapshot.list).toMatchObject({ status: "ready", data: { revision: 8, files: [fileA, fileB], nextOffset: 2 } })
  const reads = server.queries.filter(query => query.type === "mutationPatchWindow").length
  await controller.setViewed(fileA.fileId, true)
  expect(controller.snapshot.list).toMatchObject({ status: "ready", data: { files: [{ ...fileA, review: { status: "viewed" } }, fileB] } })
  expect(server.queries.filter(query => query.type === "mutationPatchWindow")).toHaveLength(reads)
  server.current.revision = 9
  server.current.files = [fileC, fileB]
  await controller.loadMoreFiles()
  await settle()
  expect(controller.snapshot.list).toEqual({ status: "ready", data: list(9, [fileC, fileB]) })
  expect(controller.snapshot.diffs.has(fileA.fileId)).toBe(false)
  // A change between pages ends the pass: the loaded extent stays shown, the
  // summary is read next, and the pass after it covers the extent again.
  const followUp = deferred<SessionChangeSummaryResult>()
  server.summaryReplies.push(Promise.resolve({ snapshotPosition: 0, fileCount: 2, unknownFileMutationGaps: 0 }), followUp.promise)
  server.listReplies.push(Promise.resolve({ ...list(10, [fileC, fileB]), files: [fileC], nextOffset: 1 }), Promise.resolve({ ...list(11, [fileC, fileB]), offset: 1, status: "stale", files: [], nextOffset: null }))
  server.current.revision = 11
  const sent = server.queries.length
  const moved = controller.refresh()
  await settle()
  const laneReads = () => server.queries.slice(sent).map(query => query.type).filter(type => type === "sessionChangeSummary" || type === "sessionChanges")
  expect(laneReads()).toEqual(["sessionChangeSummary", "sessionChanges", "sessionChanges", "sessionChangeSummary"])
  expect(controller.snapshot.list).toEqual({ status: "loading", data: list(9, [fileC, fileB]) })
  followUp.resolve({ snapshotPosition: 0, fileCount: 2, unknownFileMutationGaps: 0 })
  await moved
  await settle()
  expect(laneReads()).toEqual(["sessionChangeSummary", "sessionChanges", "sessionChanges", "sessionChangeSummary", "sessionChanges", "sessionChanges"])
  expect(controller.snapshot.list).toEqual({ status: "ready", data: list(11, [fileC, fileB]) })
  controller.dispose()
})

test("a long retained patch continues by bytes and remains server-eligible without loading the whole prefix", async () => {
  const server = runtime()
  server.current.windowBytes = 4000
  server.diffReplies.push(Promise.resolve(retainedDiff(fileA.path, "+a€" + "x".repeat(12000) + "\n", 1)))
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  controller.setVisibleFiles([fileA.fileId])
  await controller.start()
  await controller.openReview()
  await settle()
  const first = controller.snapshot.diffs.get(fileA.fileId)
  expect(first?.status).toBe("ready")
  expect(first?.status === "ready" && first.complete).toBe(false)
  // The narrow columns make the next continuation stop inside the same source line.
  controller.continueDiff(fileA.fileId, 1, 3)
  await settle()
  expect(controller.canUndo(fileA.fileId)).toBe(true)
  const patch = controller.snapshot.diffs.get(fileA.fileId)
  expect(patch?.status === "ready" && patch.diff.files[0]!.unifiedDiff.length).toBeGreaterThan(first?.status === "ready" ? first.diff.files[0]!.unifiedDiff.length : 0)
  expect(patch?.status === "ready" && patch.diff.files[0]?.unifiedDiff).not.toContain("�")
  controller.closeReview()
  expect(controller.snapshot.diffs.size).toBe(0)
  const reads = server.queries.length
  controller.continueDiff(fileA.fileId)
  await settle()
  expect(server.queries).toHaveLength(reads)
  controller.dispose()
})

test("a stale diff triggers one refresh and the new list re-fans", async () => {
  const server = runtime()
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  controller.setVisibleFiles([fileA.fileId, fileB.fileId])
  await controller.start()
  server.diffReplies.push(Promise.resolve({ status: "stale" }), Promise.resolve({ status: "stale" }))
  server.current.revision = 8
  await controller.openReview()
  await settle()
  expect(listQueries(server.queries)).toHaveLength(2)
  expect(controller.snapshot.list).toEqual({ status: "ready", data: list(8) })
  expect(diffQueries(server.queries).map(query => query.revision)).toEqual([8, 8, 8, 8])
  expect(controller.snapshot.diffs.get(fileA.fileId)?.status).toBe("ready")
  expect(controller.snapshot.diffs.get(fileB.fileId)?.status).toBe("ready")
  controller.dispose()
})

test("unknown gaps keep the list visible and Undo unavailable", async () => {
  const server = runtime()
  server.current.gaps = 1
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  controller.setVisibleFiles([fileA.fileId])
  await controller.start()
  await controller.openReview()
  await settle()
  expect(controller.snapshot.summary.status).toBe("incomplete")
  expect(controller.snapshot.list).toEqual({ status: "ready", data: list(7, [fileA, fileB], 1) })
  expect(controller.snapshot.diffs.get(fileA.fileId)?.status).toBe("ready")
  expect(controller.canUndo(fileA.fileId)).toBe(false)
  expect(controller.requestUndo(fileA.fileId)).toBe(false)
  expect(controller.snapshot.undo).toBeUndefined()
  controller.dispose()
})

test("invalidation retains settled files and diffs until path-ordered replacements settle", async () => {
  const { server, controller } = await opened()
  expect(controller.requestUndo(fileA.fileId)).toBe(true)
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "confirming", editToken: fileA.editToken })
  const old = controller.snapshot.list
  const confirmation = controller.snapshot.undo
  const oldDiff = controller.snapshot.diffs.get(fileA.fileId)
  const replacement = deferred<SessionChangesResult>()
  server.listReplies.push(replacement.promise)
  server.current.revision = 9
  server.change()
  expect(controller.snapshot.list).toEqual({ status: "loading", data: list() })
  expect(controller.snapshot.diffs.get(fileA.fileId)).toBe(oldDiff)
  expect(controller.snapshot.undo).toBe(confirmation)
  expect(controller.canUndo(fileA.fileId)).toBe(false)
  expect(await controller.confirmUndo()).toBe(false)
  expect(server.mutations).toEqual([])
  await settle()
  expect(controller.snapshot.list).toEqual({ status: "loading", data: list() })
  replacement.resolve(list(9, [fileC, fileA, { ...fileB, editToken: { position: 9, eventId: "edit-b-2" } }]))
  await settle()
  expect(controller.snapshot.list).toEqual({ status: "ready", data: list(9, [fileC, fileA, { ...fileB, editToken: { position: 9, eventId: "edit-b-2" } }]) })
  const refreshedList = controller.snapshot.list
  expect(refreshedList.status === "ready" && refreshedList.data.files[1]).toBe(fileA)
  expect(controller.snapshot.diffs.get(fileA.fileId)).toBe(oldDiff)
  expect(controller.snapshot.undo).toBe(confirmation)
  expect(controller.snapshot.list).not.toEqual(old)
  expect(controller.snapshot.diffs.get(fileB.fileId)?.status).toBe("ready")
  expect(listQueries(server.queries)).toHaveLength(2)
  controller.closeReview()
  expect(controller.snapshot.undo).toBeUndefined()
  expect(controller.snapshot.list).toEqual({ status: "idle" })
  expect(controller.snapshot.diffs.size).toBe(0)
  server.change()
  await settle()
  expect(listQueries(server.queries)).toHaveLength(2)
  controller.dispose()
})

test("a refresh carries a file's new removed folder, its new count, and its absence after the folder returns", async () => {
  const { server, controller } = await opened()
  const listed = () => controller.snapshot.list.status === "ready" ? controller.snapshot.list.data.files.find(file => file.fileId === fileC.fileId)?.folder : undefined
  for (const folder of [{ path: "/work", files: 1 }, { path: "/work", files: 2 }, undefined]) {
    server.current.files = [fileA, fileB, { ...fileC, ...(folder ? { folder } : {}) }]
    server.current.revision += 1
    server.change()
    await settle()
    expect(listed()).toEqual(folder)
  }
  controller.dispose()
})

test("Viewed uses the exact edit token, reports refusal, and reopens a changed viewed file", async () => {
  const { server, controller } = await opened()
  const originalDiff = controller.snapshot.diffs.get(fileA.fileId)
  expect(await controller.setViewed(fileA.fileId, true)).toBe(true)
  await settle()
  expect(server.mutations.at(-1)).toEqual({ type: "session.changes.set_viewed", sessionId: "cold", fileId: fileA.fileId, editToken: fileA.editToken, reviewed: true })
  expect(controller.snapshot.list.status === "ready" && controller.snapshot.list.data.files[0]?.review.status).toBe("viewed")
  expect(controller.snapshot.diffs.get(fileA.fileId)).toBe(originalDiff)

  server.viewedReplies.push(Promise.resolve({ status: "refused", message: "File changed; refresh and try again" }))
  expect(await controller.setViewed(fileA.fileId, false)).toBe(true)
  expect(controller.snapshot.viewed).toEqual({ fileId: fileA.fileId, status: "refused", reviewed: false, error: "File changed; refresh and try again" })
  expect(controller.snapshot.list.status === "ready" && controller.snapshot.list.data.files[0]?.review.status).toBe("viewed")

  server.current.files = [{ ...fileA, editToken: { position: 10, eventId: "edit-a-2" }, review: { status: "unviewed" } }, fileB]
  server.current.revision = 10
  server.change()
  await settle()
  expect(controller.snapshot.list.status === "ready" && controller.snapshot.list.data.files[0]?.review.status).toBe("unviewed")
  expect(diffQueries(server.queries).at(-1)?.fileId).toBe(fileA.fileId)
  controller.dispose()
})

test("a replacement list cannot make retained old evidence actionable", async () => {
  const { server, controller } = await opened()
  const replacementDiff = deferred<SessionChangeDiffResult>()
  server.diffReplies.push(replacementDiff.promise)
  const changed = { ...fileA, editToken: { position: 10, eventId: "edit-a-2" }, review: { status: "unviewed" as const } }
  server.current.files = [changed, fileB]
  server.current.revision = 10
  server.change()
  await settle()

  expect(controller.snapshot.diffs.get(fileA.fileId)?.status).toBe("ready")
  expect(controller.canUndo(fileA.fileId)).toBe(false)
  expect(controller.requestUndo(fileA.fileId)).toBe(false)
  expect(await controller.setViewed(fileA.fileId, true)).toBe(false)
  expect(server.mutations).toEqual([])

  replacementDiff.resolve(diff({ type: "sessionChangeDiff", sessionId: "cold", fileId: fileA.fileId, revision: 10 }))
  await settle()
  expect(controller.canUndo(fileA.fileId)).toBe(true)
  expect(controller.requestUndo(fileA.fileId)).toBe(true)
  controller.cancelUndo()
  expect(await controller.setViewed(fileA.fileId, true)).toBe(true)
  expect(server.mutations.at(-1)).toMatchObject({ fileId: fileA.fileId, editToken: changed.editToken, reviewed: true })
  controller.dispose()
})

test("Viewed transport failure stays unknown until authoritative refresh settles it", async () => {
  const { server, controller } = await opened()
  server.viewedReplies.push(Promise.reject(new Error("socket lost after commit")))
  server.current.files = [{ ...fileA, review: { status: "viewed" as const } }, fileB]
  expect(await controller.setViewed(fileA.fileId, true)).toBe(true)
  expect(controller.snapshot.viewed).toMatchObject({ fileId: fileA.fileId, status: "unknown", reviewed: true })
  await settle()
  expect(controller.snapshot.viewed).toBeUndefined()

  server.viewedReplies.push(Promise.reject(new Error("socket lost")))
  server.summaryReplies.push(Promise.reject(new Error("refresh lost")))
  server.current.files = [fileA, fileB]
  expect(await controller.setViewed(fileA.fileId, false)).toBe(true)
  await settle()
  expect(controller.snapshot.viewed).toMatchObject({ fileId: fileA.fileId, status: "unknown", reviewed: false })
  expect(controller.snapshot.summary.status).toBe("error")
  controller.dispose()
})

test("one Viewed submission disables every file's Viewed action", async () => {
  const { server, controller } = await opened()
  const pending = deferred<SessionChangesSetViewedResult>()
  server.viewedReplies.push(pending.promise)
  const first = controller.setViewed(fileA.fileId, true)
  expect(controller.canSetViewed(fileA.fileId)).toBe(false)
  expect(controller.canSetViewed(fileB.fileId)).toBe(false)
  expect(await controller.setViewed(fileB.fileId, true)).toBe(false)
  pending.resolve({ status: "completed" })
  await first
  await settle()
  expect(controller.canSetViewed(fileB.fileId)).toBe(true)
  expect(server.mutations).toHaveLength(1)
  controller.dispose()
})

test("late list and diff responses cannot replace newer intent", async () => {
  const { server, controller } = await opened()
  const oldList = deferred<SessionChangesResult>()
  server.listReplies.push(oldList.promise)
  const oldWork = controller.refresh()
  await settle()
  await controller.refresh()
  await settle()
  oldList.resolve(list(99, [fileC]))
  await oldWork
  await settle()
  expect(controller.snapshot.list).toEqual({ status: "ready", data: list() })
  expect(controller.snapshot.diffs.has(fileC.fileId)).toBe(false)
  const oldDiff = deferred<SessionChangeDiffResult>()
  server.diffReplies.push(oldDiff.promise)
  server.current.files = [{ ...fileA, editToken: { position: 8, eventId: "edit-a-2" } }, fileB]
  server.current.revision = 8
  await controller.refresh()
  expect(diffQueries(server.queries).at(-1)).toMatchObject({ fileId: fileA.fileId, revision: 8 })
  controller.closeReview()
  await controller.openReview()
  await settle()
  const latest = controller.snapshot
  oldDiff.resolve({ status: "unavailable", revision: 7, reason: "unretained" })
  await settle()
  expect(controller.snapshot).toBe(latest)
  expect(controller.snapshot.diffs.get(fileA.fileId)?.status).toBe("ready")
  controller.dispose()
})

test("failed list reads remain explicit and do not retry", async () => {
  const { server, controller } = await opened()
  const failed = deferred<SessionChangesResult>()
  server.listReplies.push(failed.promise)
  const work = controller.refresh()
  failed.reject(new Error("list lost"))
  await work
  await settle()
  expect(controller.snapshot.list).toEqual({ status: "error", data: list(), error: "list lost" })
  expect(controller.canUndo(fileA.fileId)).toBe(false)
  expect(listQueries(server.queries)).toHaveLength(2)
  controller.dispose()
})

test("disposal drops late reads and notifications without closing the supplied client", async () => {
  const server = runtime()
  const pending = deferred<SessionChangeDiffResult>()
  server.diffReplies.push(pending.promise)
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  controller.setVisibleFiles([fileA.fileId, fileB.fileId])
  await controller.start()
  await controller.openReview()
  await settle()
  let emissions = 0
  controller.onChange(() => { emissions++ })
  controller.dispose()
  const last = controller.snapshot
  pending.resolve({ status: "stale" })
  await settle()
  await controller.refresh()
  await controller.openReview()
  server.change()
  expect(controller.requestUndo(fileB.fileId)).toBe(false)
  expect(controller.snapshot).toBe(last)
  expect(emissions).toBe(0)
  expect(server.subscribers).toBe(0)
  expect(server.closed).toBe(false)
})
