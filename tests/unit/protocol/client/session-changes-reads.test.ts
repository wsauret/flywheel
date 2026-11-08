import { expect, test } from "bun:test"
import { createSessionChangesController } from "../../../../src/protocol/client/session-changes.js"
import type { SessionChangeSummaryResult } from "../../../../src/protocol/session-changes-protocol-types.js"
import { deferred, fileA, fileB, fileC, list, listQueries, opened, runtime, settle } from "./_session-changes-fixtures.js"
// When the review's reads begin, coalesce, void, and follow one another: the
// read lane of the session changes controller (ARCH-PROTOCOL-014, ARCH-PROTOCOL-045).

test("a summary that an early patch overtook shows as stale, never ready, and one read follows", async () => {
  const server = runtime()
  const first = deferred<SessionChangeSummaryResult>()
  const second = deferred<SessionChangeSummaryResult>()
  server.summaryReplies.push(first.promise, second.promise)
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  const seen: string[] = []
  controller.onChange(() => seen.push(controller.snapshot.summary.status))
  const start = controller.start()
  await settle()
  server.change(10, 0)
  await settle()
  expect(server.queries).toHaveLength(1)
  first.resolve({ fileCount: 0, unknownFileMutationGaps: 0, snapshotPosition: 0 })
  await start
  await settle()
  expect(controller.snapshot.summary).toEqual({ status: "stale", data: { fileCount: 0, unknownFileMutationGaps: 0, snapshotPosition: 0 } })
  expect(server.queries).toHaveLength(2)
  // The read that follows starts after the patch arrived, so it answers from at or past it.
  second.resolve({ fileCount: 1, unknownFileMutationGaps: 0, snapshotPosition: 10 })
  await settle()
  expect(server.queries).toHaveLength(2)
  expect(controller.snapshot.summary).toEqual({ status: "ready", data: { fileCount: 1, unknownFileMutationGaps: 0, snapshotPosition: 10 } })
  expect(seen.filter(status => status === "ready")).toHaveLength(1)
  controller.dispose()
})

test("landing invalidations keep one summary in flight and one latest refresh", async () => {
  const server = runtime()
  const pending = deferred<SessionChangeSummaryResult>()
  server.summaryReplies.push(pending.promise)
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  const work = controller.start()
  await settle()
  for (let position = 1; position <= 80; position++) {
    server.change(position, position - 1)
    await Promise.resolve()
  }
  await settle()
  expect(server.queries).toHaveLength(1)
  expect(controller.snapshot.summary.status).toBe("loading")
  pending.resolve({ fileCount: 0, unknownFileMutationGaps: 0, snapshotPosition: 0 })
  await work
  await settle()
  expect(server.queries).toHaveLength(2)
  expect(controller.snapshot.summary).toMatchObject({ status: "ready", data: { snapshotPosition: 80 } })
  controller.dispose()
})

test("a gap held over a read's anchor shows the summary stale until the read that follows covers it", async () => {
  const { server, controller } = await opened()
  const summary = deferred<SessionChangeSummaryResult>()
  const followUp = deferred<SessionChangeSummaryResult>()
  server.summaryReplies.push(summary.promise, followUp.promise)
  void controller.refresh()
  await settle()
  // Patches 1 to 10 never arrive: the one at 20 stays a gap over the anchor at 0.
  server.change(20, 10)
  summary.resolve({ fileCount: 2, unknownFileMutationGaps: 0, snapshotPosition: 0 })
  await settle()
  expect(controller.snapshot.summary.status).toBe("stale")
  expect(controller.snapshot.list.status).toBe("loading")
  expect(controller.canUndo(fileA.fileId)).toBe(false)
  followUp.resolve({ fileCount: 2, unknownFileMutationGaps: 0, snapshotPosition: 20 })
  await settle()
  expect(controller.snapshot.summary).toMatchObject({ status: "ready", data: { snapshotPosition: 20 } })
  expect(controller.snapshot.list.status).toBe("ready")
  const reads = server.queries.length
  server.change(20, 10)
  server.change(21, 20, "other")
  await settle()
  expect(server.queries).toHaveLength(reads)
  controller.dispose()
})

test("held overflow and cursor invalidation recover through summary only when closed", async () => {
  const server = runtime()
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  await controller.start()
  for (let position = 2; position <= 258; position++) server.change(position, position - 1)
  await settle()
  expect(server.queries).toHaveLength(2)
  expect(controller.snapshot.summary).toMatchObject({ status: "ready", data: { snapshotPosition: 258 } })
  server.current.position = 300
  server.emit({ type: "patch", patch: { cursor: { scope: "session", domain: "changes", sessionId: "cold" }, position: 300, prevPosition: 299, payload: { kind: "runtime.invalidate", reason: "overflow" } } })
  expect(controller.snapshot.summary.status).toBe("loading")
  await settle()
  expect(controller.snapshot.summary).toMatchObject({ status: "ready", data: { snapshotPosition: 300 } })
  expect(listQueries(server.queries)).toHaveLength(0)
  controller.dispose()
})

test("a lane break reads nothing, and the next lane reads the changes once", async () => {
  const { server, controller } = await opened()
  const summaries = () => server.queries.filter(query => query.type === "sessionChangeSummary").length
  const before = summaries()
  server.breakLane()
  await settle()
  expect(summaries()).toBe(before)
  expect(controller.snapshot.summary.status).toBe("loading")
  // A person's refresh during the break waits for the next lane's read.
  const refreshed = controller.refresh()
  await settle()
  expect(summaries()).toBe(before)
  server.lanes.open()
  await refreshed
  await settle()
  expect(summaries()).toBe(before + 1)
  expect(controller.snapshot.summary.status).toBe("ready")
  controller.dispose()
})

test.each(["reconnect_required", "overflow"] as const)("an invalidation rejects all old reads and never seeds from workspace watermark: %s", async reason => {
  const { server, controller } = await opened()
  controller.requestUndo(fileA.fileId)
  const oldSummary = deferred<SessionChangeSummaryResult>()
  server.summaryReplies.push(oldSummary.promise)
  const oldWork = controller.refresh()
  await settle()
  if (reason === "reconnect_required") server.breakLane()
  else server.emit({ type: "patch", patch: { cursor: { scope: "workspace", domain: "runtime" }, position: 0, prevPosition: 0, payload: { kind: "runtime.invalidate", reason } } })
  expect(controller.snapshot.undo).toMatchObject({ fileId: fileA.fileId, status: "confirming" })
  expect(await controller.confirmUndo()).toBe(false)
  expect(controller.snapshot.diffs.size).toBe(2)
  await settle()
  // A lane break reads again only once the next lane opens.
  if (reason === "reconnect_required") {
    expect(server.queries.filter(query => query.type === "sessionChangeSummary")).toHaveLength(2)
    server.lanes.open()
    await settle()
  }
  oldSummary.resolve({ fileCount: 999, unknownFileMutationGaps: 0, snapshotPosition: 800 })
  await oldWork
  expect(controller.snapshot.summary).toMatchObject({ status: "ready", data: { fileCount: 2, snapshotPosition: 0 } })
  expect(controller.snapshot.list.status).toBe("ready")
  expect(listQueries(server.queries)).toHaveLength(2)
  controller.dispose()
})

test("closing review keeps the summary that is out and reads no list", async () => {
  const { server, controller } = await opened()
  const old = deferred<SessionChangeSummaryResult>()
  server.summaryReplies.push(old.promise)
  const work = controller.refresh()
  await settle()
  controller.closeReview()
  await settle()
  old.resolve({ fileCount: 3, unknownFileMutationGaps: 0, snapshotPosition: 0 })
  await work
  await settle()
  expect(controller.snapshot.summary).toMatchObject({ status: "ready", data: { fileCount: 3 } })
  expect(controller.snapshot.list).toEqual({ status: "idle" })
  expect(server.queries.filter(query => query.type === "sessionChangeSummary")).toHaveLength(2)
  expect(listQueries(server.queries)).toHaveLength(1)
  controller.dispose()
})

test("a change while a summary read fails gets its one follow-up read", async () => {
  const { server, controller } = await opened()
  const summaries = () => server.queries.filter(query => query.type === "sessionChangeSummary").length
  const failing = deferred<SessionChangeSummaryResult>()
  server.summaryReplies.push(failing.promise)
  void controller.refresh()
  await settle()
  const before = summaries()
  server.change()
  await settle()
  failing.reject(new Error("history unavailable"))
  await settle()
  expect(summaries()).toBe(before + 1)
  expect(controller.snapshot.summary.status).toBe("ready")
  controller.dispose()
})

test("a change while the summary is read never voids it: the summary and list show behind, and one read follows", async () => {
  const { server, controller } = await opened()
  const summaries = () => server.queries.filter(query => query.type === "sessionChangeSummary").length
  const before = summaries()
  const overtaken = deferred<SessionChangeSummaryResult>()
  const followUp = deferred<SessionChangeSummaryResult>()
  server.summaryReplies.push(overtaken.promise, followUp.promise)
  server.current.revision = 8
  server.current.files = [fileA, fileB, fileC]
  server.change()
  await settle()
  const anchor = server.current.position
  // Two more changes land while that read is out: they ask for one more read, not two.
  server.change()
  server.change()
  await settle()
  expect(summaries()).toBe(before + 1)
  overtaken.resolve({ fileCount: 3, unknownFileMutationGaps: 0, snapshotPosition: anchor })
  await settle()
  expect(controller.snapshot.summary).toEqual({ status: "stale", data: { fileCount: 3, unknownFileMutationGaps: 0, snapshotPosition: anchor } })
  expect(controller.snapshot.list).toEqual({ status: "loading", data: list(8, [fileA, fileB, fileC]) })
  expect(controller.canUndo(fileA.fileId)).toBe(false)
  expect(summaries()).toBe(before + 2)
  followUp.resolve({ fileCount: 3, unknownFileMutationGaps: 0, snapshotPosition: server.current.position })
  await settle()
  expect(controller.snapshot.summary.status).toBe("ready")
  expect(controller.snapshot.list).toEqual({ status: "ready", data: list(8, [fileA, fileB, fileC]) })
  expect(summaries()).toBe(before + 2)
  controller.dispose()
})
