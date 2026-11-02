import { expect, test } from "bun:test"
import { createSessionChangesController } from "../../../../src/protocol/client/session-changes.js"
import type { SessionChangesUndoResult } from "../../../../src/protocol/session-changes-protocol-types.js"
import { deferred, fileA, fileB, fileC, opened, retainedDiff, runtime, settle, waitForDiff } from "./_session-changes-fixtures.js"

test("confirmation holds through lane loss and failed reads, then dispatches the same edit on the current revision", async () => {
  const { server, controller } = await opened()
  try {
    controller.requestUndo(fileA.fileId)
    const confirmation = controller.snapshot.undo
    expect(controller.canConfirmUndo()).toBe(true)
    server.breakLane()
    expect(controller.snapshot.undo).toBe(confirmation)
    expect(controller.canConfirmUndo()).toBe(false)
    expect(await controller.confirmUndo()).toBe(false)
    server.summaryReplies.push(Promise.reject(new Error("summary unavailable")))
    server.lanes.open()
    await settle()
    expect(controller.snapshot.summary.status).toBe("error")
    expect(controller.snapshot.undo).toBe(confirmation)
    expect(await controller.confirmUndo()).toBe(false)
    server.listReplies.push(Promise.reject(new Error("list unavailable")))
    await controller.refresh()
    expect(controller.snapshot.list.status).toBe("error")
    expect(controller.snapshot.undo).toBe(confirmation)
    expect(controller.canConfirmUndo()).toBe(false)
    server.current.revision = 9
    await controller.refresh()
    expect(controller.snapshot.undo).toBe(confirmation)
    expect(controller.canConfirmUndo()).toBe(true)
    expect(await controller.confirmUndo()).toBe(true)
    expect(server.mutations).toEqual([{ type: "session.changes.undo", sessionId: "cold", fileId: fileA.fileId, revision: 9 }])
  } finally { controller.dispose() }
})

test.each(["ready", "unavailable", "evidence"] as const)("a newer edit with %s proof holds the original confirmation until Undo is explicitly requested again", async proof => {
  const { server, controller } = await opened()
  try {
    controller.requestUndo(fileA.fileId)
    const confirmation = controller.snapshot.undo
    const changed = { ...fileA, editToken: { position: 10, eventId: "edit-a-2" } }
    if (proof === "unavailable") server.diffReplies.push(Promise.resolve({ status: "unavailable", revision: 10, reason: "unretained" }))
    if (proof === "evidence") server.diffReplies.push(Promise.resolve({
      ...retainedDiff(fileA.path, "+new edit", 1, 0, 10),
      diff: { path: fileA.path, change: fileA.change, patch: { kind: "unavailable" }, retainedLines: 0, renderedLines: 0, omittedLines: 0 },
    }))
    server.current.files = [changed, fileB]
    server.current.revision = 10
    server.change()
    await settle()
    if (proof !== "unavailable") await waitForDiff(controller, fileA.fileId, 10)
    else {
      expect(controller.canUndo(fileA.fileId)).toBe(false)
      expect(controller.snapshot.undo).toBe(confirmation)
      expect(controller.canConfirmUndo()).toBe(false)
      expect(controller.undoUnavailableReason(fileA.fileId)).toBe("Exact evidence is unavailable")
      expect(await controller.confirmUndo()).toBe(false)
      expect(controller.requestUndo(fileA.fileId)).toBe(false)
      expect(controller.snapshot.undo).toBe(confirmation)
      expect(server.mutations).toEqual([])
      server.current.files = [fileA, fileB]
      server.current.revision = 11
      await controller.refresh()
      await waitForDiff(controller, fileA.fileId, 11)
      expect(controller.snapshot.undo).toBe(confirmation)
      expect(controller.canConfirmUndo()).toBe(true)
      server.current.files = [changed, fileB]
      server.current.revision = 12
      await controller.refresh()
      await waitForDiff(controller, fileA.fileId, 12)
    }
    expect(controller.canUndo(fileA.fileId)).toBe(true)
    expect(controller.snapshot.undo).toBe(confirmation)
    expect(controller.canConfirmUndo()).toBe(false)
    expect(controller.undoUnavailableReason(fileA.fileId)).toBe("File has newer edits; cancel or request Undo again")
    expect(await controller.confirmUndo()).toBe(false)
    expect(server.mutations).toEqual([])
    expect(controller.requestUndo(fileA.fileId)).toBe(true)
    expect(controller.snapshot.undo).toEqual({ status: "confirming", fileId: fileA.fileId, editToken: changed.editToken })
    expect(controller.canConfirmUndo()).toBe(true)
    expect(await controller.confirmUndo()).toBe(true)
    expect(server.mutations).toHaveLength(1)
  } finally { controller.dispose() }
})

test("confirmation follows its target past the previous page extent and ends only after complete removal proof", async () => {
  const server = runtime()
  server.current.pageSize = 1
  server.current.files = [fileC]
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  try {
    controller.setVisibleFiles([fileC.fileId])
    await controller.start()
    await controller.openReview()
    await waitForDiff(controller, fileC.fileId)
    controller.requestUndo(fileC.fileId)
    const confirmation = controller.snapshot.undo
    const offsets = () => server.queries.filter(query => query.type === "sessionChanges").map(query => query.offset)
    server.current.files = [fileA, fileB, fileC]
    server.current.revision = 8
    await controller.refresh()
    expect(offsets()).toEqual([0, 0, 1, 2])
    expect(controller.snapshot.undo).toBe(confirmation)
    expect(controller.canConfirmUndo()).toBe(true)
    server.current.files = [fileA, fileB]
    server.current.revision = 9
    await controller.refresh()
    expect(offsets()).toEqual([0, 0, 1, 2, 0, 1])
    expect(controller.snapshot.undo).toBeUndefined()
    expect(await controller.confirmUndo()).toBe(false)
    expect(server.mutations).toEqual([])
  } finally { controller.dispose() }
})

test.each(["cancel", "close"] as const)("explicit %s ends a held unsubmitted confirmation", async action => {
  const { server, controller } = await opened()
  try {
    controller.requestUndo(fileA.fileId)
    server.breakLane()
    if (action === "cancel") controller.cancelUndo()
    else controller.closeReview()
    expect(controller.snapshot.undo).toBeUndefined()
    server.lanes.open()
    await settle()
    expect(controller.snapshot.undo).toBeUndefined()
    expect(await controller.confirmUndo()).toBe(false)
    expect(server.mutations).toEqual([])
  } finally { controller.dispose() }
})

test("Undo asks for confirmation, dispatches one per-file request, and refreshes on completion", async () => {
  const { server, controller } = await opened()
  expect(await controller.confirmUndo()).toBe(false)
  expect(controller.requestUndo("file:unknown")).toBe(false)
  expect(controller.requestUndo(fileA.fileId)).toBe(true)
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "confirming", editToken: fileA.editToken })
  expect(controller.canUndo(fileB.fileId)).toBe(true)
  controller.cancelUndo()
  expect(controller.snapshot.undo).toBeUndefined()
  expect(server.mutations).toEqual([])
  expect(controller.requestUndo(fileB.fileId)).toBe(true)
  expect(controller.requestUndo(fileA.fileId)).toBe(true)
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "confirming", editToken: fileA.editToken })
  const result = deferred<SessionChangesUndoResult>()
  server.undoReplies.push(result.promise)
  const undo = controller.confirmUndo()
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "submitting" })
  expect(controller.canUndo(fileB.fileId)).toBe(false)
  expect(controller.requestUndo(fileB.fileId)).toBe(false)
  expect(await controller.confirmUndo()).toBe(false)
  expect(server.mutations).toEqual([{ type: "session.changes.undo", sessionId: "cold", fileId: fileA.fileId, revision: 7 }])
  server.current.files = [fileB]
  server.current.revision = 8
  result.resolve({ status: "completed" })
  expect(await undo).toBe(true)
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "result", result: { status: "completed" } })
  await settle()
  expect(controller.snapshot.list).toMatchObject({ status: "ready", data: { revision: 8, files: [fileB] } })
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "result", result: { status: "completed" } })
  expect(controller.canUndo(fileB.fileId)).toBe(true)
  controller.dispose()
})

test.each(["omitted", "sensitive", "unavailable", "missing"] as const)("uses server reconstruction rather than %s display evidence for Undo", async kind => {
  const server = runtime()
  const result = retainedDiff(fileA.path, "+text\n", 1)
  const patch = kind === "sensitive" ? { kind: "omitted" as const, reason: "sensitive" as const }
    : kind === "unavailable" ? { kind: "unavailable" as const }
    : kind === "missing" && result.diff.patch.kind === "retained" ? { ...result.diff.patch, reference: { ...result.diff.patch.reference, sha256: "f".repeat(64) } }
    : result.diff.patch
  server.diffReplies.push(Promise.resolve({ ...result, diff: { ...result.diff, patch, omittedLines: kind === "omitted" ? 1 : 0 } }))
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  controller.setVisibleFiles([fileA.fileId])
  await controller.start()
  expect(controller.canUndo(fileA.fileId)).toBe(false)
  await controller.openReview()
  await settle()
  expect(controller.canUndo(fileA.fileId)).toBe(true)
  expect(controller.requestUndo(fileA.fileId)).toBe(true)
  expect(server.mutations).toEqual([])
  if (kind === "sensitive") expect(controller.snapshot.diffs.get(fileA.fileId)).toMatchObject({ status: "ready", diff: { omissions: [{ path: fileA.path, reason: "sensitive" }] } })
  if (kind === "unavailable" || kind === "missing") expect(controller.snapshot.diffs.get(fileA.fileId)).toEqual({ status: "unavailable", reason: "evidence" })
  controller.dispose()
})

test.each<SessionChangesUndoResult>([
  { status: "refused", message: "Changed outside this session since its last recorded write; Undo unavailable" },
  { status: "uncertain", message: "settlement unavailable" },
])("keeps a settled %j result through its own refresh and drops it on the next invalidation", async outcome => {
  const { server, controller } = await opened()
  controller.requestUndo(fileA.fileId)
  const pending = deferred<SessionChangesUndoResult>()
  server.undoReplies.push(pending.promise)
  const undo = controller.confirmUndo()
  server.change()
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "submitting" })
  await settle()
  expect(controller.canUndo(fileB.fileId)).toBe(false)
  pending.resolve(outcome)
  await undo
  await settle()
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "result", result: outcome })
  expect(controller.snapshot.list.status).toBe("ready")
  controller.closeReview()
  await controller.openReview()
  await settle()
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "result", result: outcome })
  server.change()
  expect(controller.snapshot.undo).toBeUndefined()
  expect(server.mutations).toHaveLength(1)
  controller.dispose()
})

test("two controllers observe a cold-session Undo through invalidation alone", async () => {
  const { server, controller } = await opened()
  const second = createSessionChangesController({ client: server.client, sessionId: "cold" })
  second.setVisibleFiles([fileB.fileId])
  await second.start()
  await second.openReview()
  await settle()
  expect(second.requestUndo(fileB.fileId)).toBe(true)
  controller.requestUndo(fileA.fileId)
  const pending = deferred<SessionChangesUndoResult>()
  server.undoReplies.push(pending.promise)
  const undo = controller.confirmUndo()
  server.current.fileCount = 1
  server.current.files = [fileB]
  server.current.revision = 8
  server.change()
  expect(second.snapshot.undo).toMatchObject({ fileId: fileB.fileId, status: "confirming" })
  expect(await second.confirmUndo()).toBe(false)
  pending.resolve({ status: "completed" })
  await undo
  await settle()
  expect(controller.snapshot.summary).toMatchObject({ status: "ready", data: { fileCount: 1 } })
  expect(second.snapshot.summary).toMatchObject({ status: "ready", data: { fileCount: 1 } })
  expect(second.snapshot.list).toMatchObject({ status: "ready", data: { revision: 8, files: [fileB] } })
  expect(server.mutations).toHaveLength(1)
  controller.dispose()
  expect(server.subscribers).toBe(1)
  second.dispose()
})

test("transport rejection is an unknown outcome and never retries on refresh or reconnect", async () => {
  const { server, controller } = await opened()
  const pending = deferred<SessionChangesUndoResult>()
  server.undoReplies.push(pending.promise)
  controller.requestUndo(fileA.fileId)
  const undo = controller.confirmUndo()
  pending.reject(new Error("socket lost after submission"))
  expect(await undo).toBe(true)
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "unknown", error: "socket lost after submission" })
  await settle()
  expect(controller.snapshot.undo?.status).toBe("unknown")
  expect(listQueries().length).toBe(2)
  server.breakLane()
  server.lanes.open()
  await settle()
  expect(controller.snapshot.undo).toBeUndefined()
  expect(await controller.confirmUndo()).toBe(false)
  expect(server.mutations).toHaveLength(1)
  controller.dispose()
  function listQueries() { return server.queries.filter(query => query.type === "sessionChanges") }
})

test("Viewed files keep Undo confirmation and outcome visible", async () => {
  const { server, controller } = await opened()
  server.current.files = [{ ...fileA, review: { status: "viewed" as const } }, fileB]
  await controller.refresh()
  await settle()
  expect(controller.requestUndo(fileA.fileId)).toBe(true)
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "confirming", editToken: fileA.editToken })
  server.undoReplies.push(Promise.resolve({ status: "refused", message: "stale" }))
  expect(await controller.confirmUndo()).toBe(true)
  await settle()
  expect(controller.snapshot.undo).toEqual({ fileId: fileA.fileId, status: "result", result: { status: "refused", message: "stale" } })
  controller.dispose()
})

test("close and disposal do not cancel a submitted mutation or publish late UI updates", async () => {
  const { server, controller } = await opened()
  const pending = deferred<SessionChangesUndoResult>()
  server.undoReplies.push(pending.promise)
  controller.requestUndo(fileA.fileId)
  const undo = controller.confirmUndo()
  controller.closeReview()
  expect(controller.snapshot.undo?.status).toBe("submitting")
  let updates = 0
  controller.onChange(() => { updates++ })
  controller.dispose()
  const snapshot = controller.snapshot
  pending.resolve({ status: "uncertain", message: "unknown" })
  expect(await undo).toBe(true)
  expect(controller.snapshot).toBe(snapshot)
  expect(updates).toBe(0)
  expect(server.mutations).toHaveLength(1)
  expect(server.closed).toBe(false)
})
