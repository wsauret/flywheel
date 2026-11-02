import type { AttachedRuntimeClient, FrontendEvent, FrontendMutation, RuntimeQuery } from "../../../../src/protocol/app-service-types.js"
import { recordedDispatch, recordedQuery, runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { fakeLanes, LANE_BREAK } from "../../../helpers/fake-lanes.js"
import { createSessionChangesController, type SessionChangesController } from "../../../../src/protocol/client/session-changes.js"
import { changesCursor, type SessionChangeDiffQuery, type SessionChangeDiffResult, type SessionChangeFile, type SessionChangeSummaryResult, type SessionChangesResult, type SessionChangesSetViewedResult, type SessionChangesUndoResult } from "../../../../src/protocol/session-changes-protocol-types.js"

export const fileA: SessionChangeFile = { fileId: "file:canonical:a", path: "/work/a.txt", change: "modified", editToken: { position: 1, eventId: "edit-a-1" }, review: { status: "unviewed" }, writers: [] }
export const fileB: SessionChangeFile = { fileId: "file:canonical:b", path: "/work/b.txt", change: "added", editToken: { position: 2, eventId: "edit-b-1" }, review: { status: "unviewed" }, writers: [{ sessionId: "explorer", title: "Explorer" }, { sessionId: "reviewer", title: "Reviewer" }, { sessionId: "helper", title: "Helper" }] }
export const fileC: SessionChangeFile = { fileId: "file:canonical:c", path: "/work/c.txt", change: "removed", editToken: { position: 3, eventId: "edit-c-1" }, review: { status: "unviewed" }, writers: [] }

export function deferred<T>() {
  const { promise, resolve, reject } = Promise.withResolvers<T>()
  return { promise, resolve, reject }
}

export function list(revision = 7, files: readonly SessionChangeFile[] = [fileA, fileB], unknownFileMutationGaps = 0): SessionChangesResult {
  const cursor = new Bun.CryptoHasher("sha256").update(JSON.stringify([revision, files.map(file => [file.fileId, file.editToken])])).digest("hex")
  return { status: "ready", cursor, offset: 0, nextOffset: null, totalFiles: files.length, revision, unknownFileMutationGaps, executionCwd: "/work", files, excludedFileCount: 0 }
}

const patchBytes = new Map<string, Uint8Array>()
export function retainedDiff(path: string, text: string, added = 0, removed = 0, revision = 7): Extract<SessionChangeDiffResult, { status: "ready" }> {
  const bytes = new TextEncoder().encode(text)
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
  patchBytes.set(sha256, bytes)
  return {
    status: "ready", revision, lineCounts: { added, removed },
    diff: { path, change: "modified", retainedLines: added + removed, renderedLines: added + removed, omittedLines: 0, patch: { kind: "retained", reference: { version: 1, root: sha256, sha256, bytes: bytes.length } } },
  }
}

export function diff(query: SessionChangeDiffQuery): SessionChangeDiffResult {
  return retainedDiff(query.fileId, `PATCH ${query.fileId}`, 0, 0, query.revision)
}

export function runtime() {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const queries: RuntimeQuery[] = []
  const mutations: FrontendMutation[] = []
  const summaryReplies: Promise<SessionChangeSummaryResult>[] = []
  const listReplies: Promise<SessionChangesResult>[] = []
  const diffReplies: Promise<SessionChangeDiffResult>[] = []
  const patchGates: Promise<void>[] = []
  const undoReplies: Promise<SessionChangesUndoResult>[] = []
  const viewedReplies: Promise<SessionChangesSetViewedResult>[] = []
  const current = { position: 0, fileCount: 2, gaps: 0, revision: 7, files: [fileA, fileB], pageSize: 128, windowBytes: 40_000 }
  let closed = false
  const answered = runtimeQuery({
    sessionChangeSummary: async () => await (summaryReplies.shift() ?? Promise.resolve({ snapshotPosition: current.position, fileCount: current.fileCount, unknownFileMutationGaps: current.gaps })),
    sessionChanges: async (request) => {
      const offset = request.offset ?? 0
      const end = Math.min(offset + current.pageSize, current.files.length)
      const all = list(current.revision, current.files, current.gaps)
      const stale = offset > 0 && (request.revision !== all.revision || request.cursor !== all.cursor)
      const page = { ...all, offset, status: stale ? "stale" as const : "ready" as const, files: stale ? [] : current.files.slice(offset, end), nextOffset: stale ? null : end < current.files.length ? end : null }
      return await (listReplies.shift() ?? Promise.resolve(page))
    },
    sessionChangeDiff: async (request) => await (diffReplies.shift() ?? Promise.resolve(request.revision === current.revision ? diff(request) : { status: "stale" })),
    mutationPatchWindow: async (request) => {
      const gate = patchGates.shift()
      if (gate) await gate
      const bytes = patchBytes.get(request.reference.sha256)
      if (!bytes) return { kind: "unavailable", sessionId: request.sessionId, reference: request.reference, requestedOffset: request.offset, reason: "missing" }
      const chunk = bytes.slice(request.offset, request.offset + current.windowBytes)
      const end = request.offset + chunk.length
      return { kind: "available", sessionId: request.sessionId, reference: request.reference, requestedOffset: request.offset, offset: request.offset, totalBytes: bytes.length, servedBytes: chunk.length, base64: Buffer.from(chunk).toString("base64"), nextOffset: end === bytes.length ? null : end }
    },
  })
  const query = recordedQuery((request) => { queries.push(request) }, answered)
  const dispatch = recordedDispatch((mutation) => { mutations.push(mutation) }, runtimeDispatch({
    "session.changes.undo": async () => await (undoReplies.shift() ?? Promise.resolve({ status: "completed" } satisfies SessionChangesUndoResult)),
    "session.changes.set_viewed": async (mutation) => {
      const result = await (viewedReplies.shift() ?? Promise.resolve({ status: "completed" } satisfies SessionChangesSetViewedResult))
      if (result.status === "completed") current.files = current.files.map(file => file.fileId === mutation.fileId ? { ...file, review: { status: mutation.reviewed ? "viewed" : "unviewed" } } : file)
      return result
    },
  }))
  const lanes = fakeLanes()
  const client: AttachedRuntimeClient = {
    query, dispatch,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    ...lanes.client,
    async close() { closed = true },
  }
  const emit = (event: FrontendEvent): void => { for (const listener of listeners) listener(event) }
  return {
    client, queries, mutations, summaryReplies, listReplies, diffReplies, patchGates, undoReplies, viewedReplies, current,
    get subscribers() { return listeners.size },
    get closed() { return closed },
    emit,
    lanes,
    /** The lane breaks; `lanes.open()` opens the next one. */
    breakLane() {
      lanes.end()
      emit(LANE_BREAK)
    },
    change(position = current.position + 1, prevPosition = current.position, sessionId = "cold") {
      current.position = position
      emit({ type: "patch", patch: { cursor: changesCursor(sessionId), position, prevPosition, payload: { kind: "changes.changed" } } })
    },
  }
}

/** Let native SHA-256 completion and its promise continuations settle. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await Bun.sleep(0)
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Await native hash completion and current evidence eligibility, not a retained previous body. */
export async function waitForDiff(controller: SessionChangesController, fileId: string, revision?: number): Promise<void> {
  await new Promise<void>(resolve => {
    const settled = () => {
      const snapshot = controller.snapshot
      const current = snapshot.diffs.get(fileId)
      return (revision === undefined || ("data" in snapshot.list && snapshot.list.data?.revision === revision))
        && current !== undefined && current.status !== "loading"
        && (current.status !== "ready" || controller.canUndo(fileId))
    }
    const stop = controller.onChange(() => { if (settled()) { stop(); resolve() } })
    if (settled()) { stop(); resolve() }
  })
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

export async function opened() {
  const server = runtime()
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  controller.setVisibleFiles([fileA.fileId, fileB.fileId])
  await controller.start()
  await controller.openReview()
  await settle()
  await Promise.all([waitForDiff(controller, fileA.fileId), waitForDiff(controller, fileB.fileId)])
  return { server, controller }
}

export function listQueries(queries: readonly RuntimeQuery[]) {
  return queries.filter(query => query.type === "sessionChanges")
}
export function diffQueries(queries: readonly RuntimeQuery[]): SessionChangeDiffQuery[] {
  return queries.filter((query): query is SessionChangeDiffQuery => query.type === "sessionChangeDiff")
}
