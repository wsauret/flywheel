import { expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync, chmodSync, statSync, mkdirSync, renameSync } from "node:fs"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { withMutationQueueKeys } from "../../../../src/infra/file-mutation-queue.js"
import { publishFileEdits } from "../../../../src/orchestration/file-edits/file-edit-operation.js"
import { RetainedFileEditAuthority } from "../../../../src/orchestration/file-edits/retained-file-edit-host.js"
import { undoResultOf, undoSessionChanges } from "../../../../src/orchestration/file-edits/session-undo.js"
import { getSessionChangeReview } from "../../../../src/orchestration/session/session-change-review.js"
import { loadSessionPendingFileMutations, reconcilePendingFileMutations } from "../../../../src/orchestration/session/file-mutation-recovery.js"
import { parseFileMutationOperationHeader } from "../../../../src/orchestration/session/file-mutation-operation.js"
import { withStore, prepareLegacy, prepareBatch } from "../session/file-mutation-recovery-fixture.js"
import { createDeferred } from "../../../fixtures/runtime-supervisor-fixtures.js"

type Fixture = Parameters<Parameters<typeof withStore>[0]>[0]
async function change(fixture: Fixture, path: string, after: string | undefined) {
  const outcome = await publishFileEdits({ executionCwd: fixture.root, sessionEventWriter: fixture.writer, origin: { kind: "user_undo", reviewRevision: 0, fileId: "fixture", sourceMutationIds: [] } }, { paths: [path], admit: RetainedFileEditAuthority.admitWritable, plan: admitted => [{ admitted: admitted[0]!, after }] })
  expect(outcome.status).toBe("completed")
}
async function request(fixture: Fixture, path: string) {
  const review = await getSessionChangeReview(asAsyncEventReadSurface(fixture.store), fixture.sessionId)
  const fileId = `file:${fixture.store.read({ sessionId: fixture.sessionId, types: ["file.changed"] }).find(fact => fact.payload.path === path)!.id}`
  return { type: "session.changes.undo" as const, sessionId: fixture.sessionId, fileId, revision: review.revision() }
}
function context(fixture: Fixture) {
  return { reader: asAsyncEventReadSurface(fixture.store), projectionReader: asAsyncEventReadSurface(fixture.store), writer: asAsyncEventWriter(fixture.store), projectRoot: fixture.root, executionCwd: fixture.root, sessionId: fixture.sessionId }
}
const signal = () => new AbortController().signal

test.each([
  ["modify", "before\n", "after\n"], ["create", undefined, "created\n"], ["delete", "deleted\n", undefined],
  ["create empty", undefined, ""], ["delete empty", "", undefined],
  ["BOM CRLF", "\ufeffa\r\nb\r\n", "\ufeffa\r\nc\r\n"], ["CR", "a\rb\r", "a\rc\r"], ["no newline", "before", "after"],
  ["single Unicode line across chunks", "€".repeat(24_000), "界".repeat(24_000)],
] as const)("proves and restores %s", async (_name, before, after) => {
  await withStore(async fixture => {
    const path = join(fixture.root, "text")
    if (before !== undefined) writeFileSync(path, before)
    await change(fixture, path, after)
    const command = await request(fixture, path)
    const result = await undoSessionChanges(context(fixture), command, signal())
    expect(result).toEqual({ status: "completed" })
    expect(before === undefined ? !existsSync(path) : readFileSync(path).equals(Buffer.from(before))).toBe(true)
    expect(fixture.store.readInFlight(fixture.sessionId, "file.mutation")).toEqual([])
    const origin = fixture.store.read({ sessionId: fixture.sessionId, types: ["file.changed"] }).at(-1)?.payload.origin
    expect(origin).toEqual({ kind: "user_undo", fileId: command.fileId, reviewRevision: command.revision, sourceMutationIds: [expect.any(String)] })
    expect((await getSessionChangeReview(asAsyncEventReadSurface(fixture.store), fixture.sessionId)).netFiles()).toEqual([])
  })
})

test("unavailable settled patch evidence refuses Undo without writing files or facts", async () => {
  await withStore(async fixture => {
    const path = join(fixture.root, "text")
    writeFileSync(path, "old\n")
    await change(fixture, path, "new\n")
    const command = await request(fixture, path)
    const base = context(fixture)
    base.reader.readSessionContentRange = async () => ({ kind: "unavailable", reason: "missing" })
    const position = fixture.store.currentPosition()
    const inode = statSync(path).ino
    expect(await undoSessionChanges(base, command, signal())).toMatchObject({ status: "refused" })
    expect(readFileSync(path, "utf8")).toBe("new\n")
    expect(statSync(path).ino).toBe(inode)
    expect(fixture.store.currentPosition()).toBe(position)
    expect((await getSessionChangeReview(base.projectionReader, fixture.sessionId)).netFiles()).toHaveLength(1)
  })
})

test("a restored chain proves every step and writes neither files nor facts", async () => {
  await withStore(async fixture => {
    const path = join(fixture.root, "text")
    writeFileSync(path, "old\n")
    await change(fixture, path, "new\n")
    await change(fixture, path, "old\n")
    const position = fixture.store.currentPosition()
    const inode = statSync(path).ino
    expect(await undoSessionChanges(context(fixture), await request(fixture, path), signal())).toEqual({ status: "completed" })
    expect(fixture.store.currentPosition()).toBe(position)
    expect(statSync(path).ino).toBe(inode)
  })
})

test.each(["unreadable", "legacy", "unrelated"] as const)("pending %s evidence is classified by the recovery boundary", async kind => {
  await withStore(async fixture => {
    const path = join(fixture.root, "text")
    await change(fixture, path, "new\n")
    if (kind === "unreadable") fixture.store.putInFlight(fixture.sessionId, "file.mutation", "broken", { path: "untrusted" })
    else await prepareLegacy(fixture.writer, kind === "legacy" ? path : join(fixture.root, "elsewhere"), "a", "b")
    const result = await undoSessionChanges(context(fixture), await request(fixture, path), signal())
    expect(result.status).toBe(kind === "unrelated" ? "completed" : "refused")
    expect(existsSync(path)).toBe(kind !== "unrelated")
  })
})

test.each(["unknown", "stale", "gap", "malformed"] as const)("refuses a %s request before native admission", async kind => {
  await withStore(async fixture => {
    const path = join(fixture.root, "text")
    await change(fixture, path, "new\n")
    if (kind === "gap") fixture.store.append({ sessionId: fixture.sessionId, aggregateId: `session:${fixture.sessionId}`, type: "file.changed", version: 4, actor: "flywheel", timestamp: 1, payload: { broken: true } })
    const command = { ...await request(fixture, path) }
    if (kind === "unknown") command.fileId = "file:foreign"
    if (kind === "stale") command.revision++
    const input = kind === "malformed" ? { ...command, paths: [path] } : command
    const result = await undoSessionChanges({ ...context(fixture), admit: () => { throw new Error("Admission must not run") } }, input, signal())
    expect(result.status).toBe("refused")
    if (result.status !== "refused") throw new Error("unreachable")
    expect(result.message).not.toContain("Admission must not run")
    if (kind === "stale") expect(result.message).toBe("Changes have moved on; refresh and try again")
    if (kind === "gap") expect(result.message).toContain("Unknown file-mutation gaps")
    expect(readFileSync(path, "utf8")).toBe("new\n")
  })
})

test.each(["bytes", "identity", "parent"] as const)("target %s drift during queue wait prevents publication", async drift => {
  await withStore(async fixture => {
    const directory = join(fixture.root, "targets")
    mkdirSync(directory)
    const path = join(directory, "a")
    await change(fixture, path, "new a\n")
    const held = createDeferred<void>(), release = createDeferred<void>(), admitted = createDeferred<void>()
    const holding = withMutationQueueKeys([path], async () => { held.resolve(); await release.promise })
    await held.promise
    let writes = 0, closes = 0
    const undo = undoSessionChanges({ ...context(fixture), admit(target) {
      const authority = RetainedFileEditAuthority.admitWritable(target)
      const remove = authority.delete.bind(authority), close = authority.close.bind(authority)
      authority.delete = () => { writes++; return remove() }
      authority.close = () => { closes++; close() }
      admitted.resolve()
      return authority
    } }, await request(fixture, path), signal())
    await admitted.promise
    if (drift === "bytes") writeFileSync(path, "external\n")
    else if (drift === "identity") {
      renameSync(path, join(directory, "old-a"))
      writeFileSync(path, "new a\n")
    } else {
      renameSync(directory, join(fixture.root, "old-targets"))
      mkdirSync(directory)
      writeFileSync(path, "new a\n")
    }
    release.resolve()
    await holding
    const result = await undo
    expect(result.status).toBe("refused")
    expect(writes).toBe(0)
    expect(closes).toBe(1)
    expect(fixture.store.readInFlight(fixture.sessionId, "file.mutation")).toEqual([])
  })
})

test.each(["bytes", "access"] as const)("%s drift before admission is refused as drifted", async drift => {
  if (drift === "access" && process.platform === "win32") return
  await withStore(async fixture => {
    const path = join(fixture.root, "text")
    writeFileSync(path, "old\n", { mode: 0o600 })
    await change(fixture, path, "new\n")
    if (drift === "bytes") writeFileSync(path, "external\n")
    else chmodSync(path, 0o644)
    const position = fixture.store.currentPosition()
    expect(await undoSessionChanges(context(fixture), await request(fixture, path), signal())).toEqual({ status: "refused", message: "Changed outside this session since its last recorded write; Undo unavailable" })
    expect(fixture.store.currentPosition()).toBe(position)
  })
})

test.each(["not_applied", "indeterminate", "readback", "settlement", "retirement", "preparation"] as const)("maps the %s publication failure", async failure => {
  await withStore(async fixture => {
    const path = join(fixture.root, "a")
    await change(fixture, path, "new\n")
    const base = context(fixture)
    const writer = { ...base.writer }
    const appendBatch = writer.appendBatch.bind(writer)
    if (failure === "preparation") writer.swapInFlight = async () => { throw new Error("preparation failed") }
    if (failure === "settlement" || failure === "retirement") writer.appendBatch = async events => {
      if (events.some(event => event.payload.path === path || (failure === "retirement" && event.type === "file.mutation.settled"))) throw new Error("settlement unavailable")
      return appendBatch(events)
    }
    const result = await undoSessionChanges({ ...base, writer, admit(target) {
      const authority = RetainedFileEditAuthority.admitWritable(target)
      if (failure === "not_applied" || failure === "retirement") authority.delete = () => ({ status: "not_applied", error: new Error("publication refused") })
      if (failure === "indeterminate") authority.delete = () => ({ status: "indeterminate", error: new Error("publication unknown") })
      if (failure === "readback") authority.verifyAbsent = () => { throw new Error("readback failed") }
      return authority
    } }, await request(fixture, path), signal())
    if (failure === "preparation") expect(result).toEqual({ status: "refused", message: "preparation failed" })
    else if (failure === "not_applied") expect(result).toEqual({ status: "refused", message: "publication refused" })
    else if (failure === "retirement") expect(result).toEqual({ status: "refused", message: "publication refused; retirement failed: settlement unavailable" })
    else if (failure === "indeterminate") expect(result).toEqual({ status: "uncertain", message: "publication unknown" })
    else expect(result).toEqual({ status: "uncertain", message: failure === "readback" ? "readback failed" : "settlement unavailable" })
    expect(existsSync(path)).toBe(failure !== "readback" && failure !== "settlement")
  })
})

test("a pending mutation on the target blocks Undo before admission", async () => {
  await withStore(async fixture => {
    const path = join(fixture.root, "b")
    await change(fixture, path, "new\n")
    await prepareBatch(fixture.writer, [{ path, beforeContent: "new\n", afterContent: "later\n" }])
    const cells = fixture.store.readInFlight(fixture.sessionId, "file.mutation")
    expect((await loadSessionPendingFileMutations(asAsyncEventReadSurface(fixture.store), fixture.sessionId)).pending.map(fact => fact.payload.path)).toEqual([path])
    const position = fixture.store.currentPosition()
    let admissions = 0
    const result = await undoSessionChanges({ ...context(fixture), admit(target) { admissions++; return RetainedFileEditAuthority.admitWritable(target) } }, await request(fixture, path), signal())
    expect(result).toEqual({ status: "refused", message: "A pending file mutation overlaps this file" })
    expect(admissions).toBe(0)
    expect(readFileSync(path, "utf8")).toBe("new\n")
    expect(fixture.store.currentPosition()).toBe(position)
    expect(fixture.store.readInFlight(fixture.sessionId, "file.mutation")).toEqual(cells)
  })
})

test.each(["removed", "cursor", "raw-order", "recovered"] as const)("an own cell %s before queue reservation refuses before writing", async drift => {
  await withStore(async fixture => {
    const path = join(fixture.root, "a")
    await change(fixture, path, "new\n")
    const base = context(fixture)
    let expectedCells = fixture.store.readInFlight(fixture.sessionId, "file.mutation")
    const writer = { ...base.writer, swapInFlight: async (...args: Parameters<NonNullable<typeof base.writer.swapInFlight>>) => {
      const stored = await base.writer.swapInFlight!(...args)
      const row = fixture.store.readInFlight(fixture.sessionId, "file.mutation")[0]!
      const cell = parseFileMutationOperationHeader(row.payload)
      if (drift === "recovered") expect(await reconcilePendingFileMutations({ sessionId: fixture.sessionId, store: base.projectionReader, writer: base.writer })).toEqual([])
      else {
        const { plan, ...header } = cell
        const next = drift === "removed" ? null : drift === "cursor" ? { ...cell, cursor: 1 } : { plan, ...header }
        expect(fixture.store.swapInFlight(fixture.sessionId, "file.mutation", row.key, row.raw, next)).toBe(true)
      }
      expectedCells = fixture.store.readInFlight(fixture.sessionId, "file.mutation")
      return stored
    } }
    let writes = 0
    const position = fixture.store.currentPosition()
    const result = await undoSessionChanges({ ...base, writer, admit(target) {
      const authority = RetainedFileEditAuthority.admitWritable(target)
      const remove = authority.delete.bind(authority)
      authority.delete = () => { writes++; return remove() }
      return authority
    } }, await request(fixture, path), signal())
    expect(result).toMatchObject({ status: "refused", message: expect.stringContaining("; retirement failed: ") })
    expect(writes).toBe(0)
    expect(readFileSync(path, "utf8")).toBe("new\n")
    expect(fixture.store.readInFlight(fixture.sessionId, "file.mutation")).toEqual(expectedCells)
    expect(fixture.store.read({ sessionId: fixture.sessionId, afterPosition: position }).map(row => row.type)).toEqual(drift === "recovered" ? ["file.mutation.settled"] : [])
  })
})

test.each(["preflight", "publication"] as const)("recovery cannot retire a live Undo during %s", async stage => {
  await withStore(async fixture => {
    const path = join(fixture.root, "a")
    await change(fixture, path, "new\n")
    const position = fixture.store.currentPosition()
    const base = context(fixture)
    let recovery: ReturnType<typeof reconcilePendingFileMutations> | undefined
    let retainedDuringPublication = false
    const result = await undoSessionChanges({ ...base, admit(target) {
      const authority = RetainedFileEditAuthority.admitWritable(target)
      const startRecovery = () => {
        if (recovery) return
        const before = fixture.store.readInFlight(fixture.sessionId, "file.mutation")[0]!
        recovery = reconcilePendingFileMutations({ sessionId: fixture.sessionId, store: base.projectionReader, writer: base.writer })
        retainedDuringPublication = fixture.store.readInFlight(fixture.sessionId, "file.mutation")[0]?.raw === before.raw
      }
      if (stage === "preflight") {
        const verify = authority.verifyPrecondition.bind(authority)
        authority.verifyPrecondition = () => { verify(); startRecovery() }
      } else {
        const remove = authority.delete.bind(authority)
        authority.delete = () => { startRecovery(); return remove() }
      }
      return authority
    } }, await request(fixture, path), signal())
    expect(await recovery).toEqual([])
    expect(retainedDuringPublication).toBe(true)
    expect(result).toEqual({ status: "completed" })
    expect(fixture.store.readInFlight(fixture.sessionId, "file.mutation")).toEqual([])
    expect(fixture.store.read({ sessionId: fixture.sessionId, afterPosition: position }).map(row => row.type)).toEqual(["file.changed", "file.artifact.recorded"])
  })
})

test("recovery queued ahead of a prepared Undo retires first and prevents the write", async () => {
  await withStore(async fixture => {
    const path = join(fixture.root, "a")
    await change(fixture, path, "new\n")
    const base = context(fixture)
    const held = createDeferred<void>(), release = createDeferred<void>()
    const prepared = createDeferred<void>(), reserveUndo = createDeferred<void>()
    const holding = withMutationQueueKeys([path], async () => { held.resolve(); await release.promise })
    await held.promise
    let writes = 0
    const position = fixture.store.currentPosition()
    const undo = undoSessionChanges({ ...base, writer: {
      ...base.writer,
      swapInFlight: async (...args: Parameters<NonNullable<typeof base.writer.swapInFlight>>) => {
        const stored = await base.writer.swapInFlight!(...args)
        prepared.resolve()
        await reserveUndo.promise
        return stored
      },
    }, admit(target) {
      const authority = RetainedFileEditAuthority.admitWritable(target)
      const remove = authority.delete.bind(authority)
      authority.delete = () => { writes++; return remove() }
      return authority
    } }, await request(fixture, path), signal())
    await prepared.promise
    const pendingRow = fixture.store.readInFlight(fixture.sessionId, "file.mutation")[0]!
    // Preloading places recovery's first await at the mutation queue, so it
    // is queued ahead of the Undo publication rather than racing its load.
    const initial = await loadSessionPendingFileMutations(asAsyncEventReadSurface(fixture.store), fixture.sessionId)
    const recovery = reconcilePendingFileMutations({ sessionId: fixture.sessionId, store: asAsyncEventReadSurface(fixture.store), writer: base.writer, initial })
    const retainedWhileQueued = fixture.store.readInFlight(fixture.sessionId, "file.mutation")[0]?.raw === pendingRow.raw
    reserveUndo.resolve()
    release.resolve()
    await holding
    const result = await undo
    expect(await recovery).toEqual([])
    expect(retainedWhileQueued).toBe(true)
    expect(result).toMatchObject({ status: "refused", message: expect.stringContaining("; retirement failed: ") })
    expect(writes).toBe(0)
    expect(fixture.store.readInFlight(fixture.sessionId, "file.mutation")).toEqual([])
    expect(fixture.store.read({ sessionId: fixture.sessionId, afterPosition: position }).map(row => row.type)).toEqual(["file.mutation.settled"])
  })
})

test.each(["cancelled", "failed", "proof"] as const)("prepublication %s keeps its cause when the signal aborts", async cause => {
  await withStore(async fixture => {
    const path = join(fixture.root, "a")
    await change(fixture, path, "new\n")
    const controller = new AbortController()
    if (cause === "cancelled") controller.abort(new Error("cancelled explicitly"))
    const result = await undoSessionChanges({ ...context(fixture), admit(target) {
      controller.abort(new Error("concurrent cancellation"))
      if (cause === "failed") throw new Error("original admission failure")
      const authority = RetainedFileEditAuthority.admitWritable(target)
      Object.defineProperty(authority, "canonicalPath", { value: `${target}-changed` })
      return authority
    } }, await request(fixture, path), controller.signal)
    expect(result).toEqual({ status: "refused", message: cause === "cancelled" ? "cancelled explicitly" : cause === "failed" ? "original admission failure" : "Changed outside this session since its last recorded write; Undo unavailable" })
    expect(readFileSync(path, "utf8")).toBe("new\n")
  })
})

test("outcome mapping covers cancelled, absent, and retirement errors", () => {
  expect(undoResultOf({ status: "completed" })).toEqual({ status: "completed" })
  expect(undoResultOf({ status: "not_applied", reason: "cancelled" })).toEqual({ status: "refused", message: "Undo was cancelled before it wrote" })
  expect(undoResultOf({ status: "not_applied", reason: "preflight" })).toEqual({ status: "refused", message: "Undo did not apply" })
  expect(undoResultOf({ status: "not_applied", reason: "publication", error: new Error("boom"), retirementError: "later" })).toEqual({ status: "refused", message: "boom; retirement failed: later" })
  expect(undoResultOf({ status: "uncertain", error: new Error("lost") })).toEqual({ status: "uncertain", message: "lost" })
})
