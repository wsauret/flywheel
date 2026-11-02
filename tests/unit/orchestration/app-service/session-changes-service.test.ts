import { expect, mock, spyOn, test } from "bun:test"
import * as fs from "node:fs"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Schema } from "effect"
import { RuntimeProtocolRpc } from "../../../../src/protocol/runtime-protocol-schemas.js"
import { SessionChangeDiffQuerySchema, SessionChangesQuerySchema, SessionChangesSetViewedSchema, SessionChangesUndoSchema } from "../../../../src/protocol/session-changes-protocol-types.js"
import { createSessionChangesService } from "../../../../src/orchestration/app-service/session-changes-service.js"
import { createBashDefinition } from "../../../../src/orchestration/agent-runtime/tools/bash.js"
import { loadBashParser } from "../../../../src/orchestration/agent-runtime/tools/bash-parser.js"
import { mutationSpawnProbe, makeMockOps } from "../agent-runtime/tools/_bash-fixtures.js"
import { capabilityAccessHolding, makeContext } from "../agent-runtime/tools/_fixtures.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"
import { emitToolExecutionOutputRecorded } from "../../../../src/orchestration/agent-runtime/emit.js"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../../src/infra/runtime-fact-mapper.js"
import { readToolResultDisplayMeta } from "../../../../src/orchestration/session/conversation/tool-result-meta.js"
import { backgroundLogPath } from "../../../helpers/background-log-path.js"
import { publishFileEdits } from "../../../../src/orchestration/file-edits/file-edit-operation.js"
import { RetainedFileEditAuthority } from "../../../../src/orchestration/file-edits/retained-file-edit-host.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { buildSessionChildLinkedFact, buildSessionCreatedFact } from "../../../../src/orchestration/session/session-metadata-facts.js"
import { buildSessionMetadataAppend } from "../../../../src/orchestration/session/session-metadata-store.js"
import type { Session } from "../../../../src/orchestration/session/schemas.js"
import { readChangeFact, readPatchContent } from "../../../../src/orchestration/session/session-change-sources.js"
import { getSessionChangeReview } from "../../../../src/orchestration/session/session-change-review.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type GuardedEventStoreAppend } from "../../../../src/infra/event-store-types.js"
import { withStore } from "../session/file-mutation-recovery-fixture.js"
import { fixture as changeReviewFixture } from "../session/_session-change-fixtures.js"
import { buildMutationDiff } from "../../../../src/infra/mutation-diff.js"
import { readMutationEvidenceFiles } from "../../../../src/infra/mutation-evidence.js"
import { createMutationEvidenceService } from "../../../../src/orchestration/app-service/mutation-evidence-service.js"
import { Database } from "bun:sqlite"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"

type Fixture = Parameters<Parameters<typeof withStore>[0]>[0]
const queryRpc = RuntimeProtocolRpc.requests.get("RuntimeQuery")!
const dispatchRpc = RuntimeProtocolRpc.requests.get("RuntimeDispatch")!

async function withService(run: (service: ReturnType<typeof createSessionChangesService>, fixture: Fixture, change: (path: string, after: string | undefined, sessionId?: string) => Promise<void>, manager: ReturnType<typeof createSessionManager>) => Promise<void>) {
  await withStore(async fixture => {
    const manager = createSessionManager({ projectRoot: fixture.root, executionCwd: fixture.root, store: fixture.store })
    await manager.createChat({ id: fixture.sessionId, name: "Review", initialState: "inactive" })
    const service = createSessionChangesService({ reader: asAsyncEventReadSurface(fixture.store), writer: asAsyncEventWriter(fixture.store), manager, projectRoot: fixture.root })
    const writers = new Map([[fixture.sessionId, fixture.writer]])
    try {
      await run(service, fixture, async (path, after, sessionId = fixture.sessionId) => {
        const writer = writers.get(sessionId) ?? createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(fixture.store) })
        writers.set(sessionId, writer)
        const outcome = await publishFileEdits({ executionCwd: fixture.root, sessionEventWriter: writer, origin: { kind: "user_undo", reviewRevision: 0, fileId: "fixture", sourceMutationIds: [] } }, { paths: [path], admit: RetainedFileEditAuthority.admitWritable, plan: admitted => [{ admitted: admitted[0]!, after }] })
        expect(outcome.status).toBe("completed")
      }, manager)
    } finally {
      for (const [sessionId, writer] of writers) if (sessionId !== fixture.sessionId) writer.dispose()
    }
  })
}

/** Records a session that `parentSessionId` launched, as a launch publishes it. */
function launch(fixture: Fixture, sessionId: string, parentSessionId: string, kind: "subagent" | "workflow-agent" | "chat", label: string) {
  const now = "2026-01-01T00:00:00.000Z"
  const common = { label, conversationId: `${sessionId}-conversation`, createdAt: now, lastUpdated: now, lifecycleState: "inactive" as const }
  const launchedFrom = { parentSessionId, conversationId: `${parentSessionId}-conversation`, toolUseId: `launch-${sessionId}` }
  const session: Session = kind === "workflow-agent"
    ? { ...common, kind: "workflow-agent", command: "workflow-agent", launchedFrom, workflowMembership: { kind: "attempt", workflowId: "workflow", attemptId: `${sessionId}-attempt` } }
    : kind === "subagent" ? { ...common, kind: "subagent", command: "subagent", launchedFrom, executionCwd: fixture.root }
    : { ...common, kind: "chat", command: "chat", launchedFrom, executionCwd: fixture.root }
  fixture.store.appendBatch([
    buildSessionMetadataAppend(sessionId, buildSessionCreatedFact(session)),
    buildSessionMetadataAppend(parentSessionId, buildSessionChildLinkedFact(sessionId, now)),
  ])
}

test("a session's review holds the changes of every session it launched, and Undo restores what they changed", async () => {
  await withService(async (service, fixture, change) => {
    const [a, b, c, d, e] = [join(fixture.root, "a"), join(fixture.root, "b"), join(fixture.root, "c"), join(fixture.root, "d"), join(fixture.root, "e")]
    launch(fixture, "explorer", fixture.sessionId, "subagent", "Explorer")
    launch(fixture, "helper", "explorer", "subagent", "Helper")
    launch(fixture, "reviewer", fixture.sessionId, "workflow-agent", "Reviewer")
    launch(fixture, "fork", fixture.sessionId, "chat", "Fork")
    await change(a, "made\n")
    await change(a, "made\nmore\n", "explorer")
    await change(b, "child\n", "explorer")
    await change(c, "nested\n", "helper")
    await change(d, "forked\n", "fork")
    await change(e, "agent\n", "reviewer")
    await change(e, "agent\nagain\n", "explorer")
    const query = (sessionId: string) => ({ type: "sessionChanges" as const, sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    const root = await service.list(query(fixture.sessionId))
    expect(root.files.map(file => [file.path, file.change, file.writers.map(writer => writer.title)])).toEqual([
      [a, "added", ["Explorer"]], [b, "added", ["Explorer"]], [c, "added", ["Helper"]], [e, "added", ["Reviewer", "Explorer"]],
    ])
    expect(roundTrip(queryRpc, root)).toEqual(root)
    // A launched session's own review holds only its own subtree.
    expect((await service.list(query("explorer"))).files.map(file => [file.path, file.change, file.writers.map(writer => writer.sessionId)])).toEqual([
      [a, "modified", []], [b, "added", []], [c, "added", ["helper"]], [e, "modified", []],
    ])
    // The one diff of a file runs from before the first change of the subtree to after its last.
    const fileA = root.files.find(file => file.path === a)!
    const diff = await service.diff({ type: "sessionChangeDiff", sessionId: fixture.sessionId, fileId: fileA.fileId, revision: root.revision })
    expect(diff).toMatchObject({ status: "ready", lineCounts: { added: 2, removed: 0 }, diff: { change: "added" } })
    // Viewed belongs to the review that records it.
    expect(await service.setViewed({ type: "session.changes.set_viewed", sessionId: fixture.sessionId, fileId: fileA.fileId, editToken: fileA.editToken, reviewed: true })).toEqual({ status: "completed" })
    expect((await service.list(query(fixture.sessionId))).files.find(file => file.path === a)?.review.status).toBe("viewed")
    expect((await service.list(query("explorer"))).files.find(file => file.path === a)?.review.status).toBe("unviewed")
    // Undo restores the file as it was before any session of the subtree touched it.
    const fileB = root.files.find(file => file.path === b)!
    const current = await service.list(query(fixture.sessionId))
    expect(await service.undo({ type: "session.changes.undo", sessionId: fixture.sessionId, fileId: fileB.fileId, revision: current.revision }, new AbortController().signal)).toEqual({ status: "completed" })
    expect(fs.existsSync(b)).toBe(false)
    expect((await service.list(query(fixture.sessionId))).files.map(file => file.path)).toEqual([a, c, e])
    // The launched session's last write no longer stands, so its review leaves the file out.
    expect((await service.list(query("explorer"))).files.map(file => file.path)).toEqual([a, c, e])
  })
})
const roundTrip = (rpc: { readonly successSchema: Schema.Codec<unknown, unknown, never, never> }, value: unknown) => Schema.decodeUnknownSync(rpc.successSchema)(Schema.encodeUnknownSync(rpc.successSchema)(Schema.decodeUnknownSync(rpc.successSchema)(value)))

test("list reports net-changed files in path order with the execution directory", async () => {
  await withService(async (service, fixture, change) => {
    const a = join(fixture.root, "a"), b = join(fixture.root, "b"), c = join(fixture.root, "c"), internal = join(fixture.root, ".flywheel", "note.md")
    writeFileSync(b, "old\n")
    writeFileSync(c, "gone\n")
    await change(c, undefined)
    await change(b, "new\n")
    await change(a, "made\n")
    await change(b, "old\n")
    await change(internal, "internal\n")
    const list = await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    expect(list).toEqual({ status: "ready", offset: 0, nextOffset: null, totalFiles: 2, cursor: expect.stringMatching(/^[a-f0-9]{64}$/), revision: 5, unknownFileMutationGaps: 0, executionCwd: fixture.root, excludedFileCount: 0, files: [
      { fileId: expect.stringMatching(/^file:/), path: a, change: "added", editToken: { position: expect.any(Number), eventId: expect.any(String) }, review: { status: "unviewed" }, writers: [] },
      { fileId: expect.stringMatching(/^file:/), path: c, change: "removed", editToken: { position: expect.any(Number), eventId: expect.any(String) }, review: { status: "unviewed" }, writers: [] },
    ] })
    expect(roundTrip(queryRpc, list)).toEqual(list)
    const request = { type: "sessionChanges" as const, sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 }
    expect(Schema.decodeUnknownSync(queryRpc.payloadSchema)(request)).toEqual(request)
    expect(() => Schema.decodeUnknownSync(SessionChangesQuerySchema, { onExcessProperty: "error" })({ type: "sessionChanges", sessionId: fixture.sessionId, scope: "session" })).toThrow()
  })
})

test("list names the topmost removed directory of each deleted file under a directory that no longer exists", async () => {
  await withService(async (service, fixture, change) => {
    const removed = join(fixture.root, "d"), kept = join(fixture.root, "keep")
    fs.mkdirSync(join(removed, "sub"), { recursive: true })
    fs.mkdirSync(kept)
    const paths = [join(removed, "b"), join(removed, "sub", "a"), join(kept, "gone"), join(kept, "stays")]
    for (const path of paths) writeFileSync(path, "old\n")
    for (const path of paths.slice(0, 3)) await change(path, undefined)
    await change(join(kept, "made"), "new\n")
    fs.rmSync(removed, { recursive: true })
    const query = { type: "sessionChanges" as const, sessionId: fixture.sessionId, offset: 0, maxFiles: 1, maxBytes: 65536 }
    const rows = []
    for (let page = await service.list(query); ; page = await service.list({ ...query, offset: page.nextOffset!, cursor: page.cursor, revision: page.revision })) {
      expect(roundTrip(queryRpc, page)).toEqual(page)
      rows.push(...page.files.map(file => [file.path, file.change, file.folder]))
      if (page.nextOffset === null) break
    }
    expect(rows).toEqual([
      [join(removed, "b"), "removed", { path: removed, files: 2 }],
      [join(removed, "sub", "a"), "removed", { path: removed, files: 2 }],
      [join(kept, "gone"), "removed", undefined],
      [join(kept, "made"), "added", undefined],
    ])
  })
})

test("list pages an ordered snapshot within byte and file budgets and refuses history or filesystem membership drift", async () => {
  await withService(async (_service, fixture, change, manager) => {
    for (const name of ["c", "a", "b"]) await change(join(fixture.root, name), `${name}\n`)
    const content = mock(async () => { throw new Error("List must not read patch content") })
    const reader = { ...asAsyncEventReadSurface(fixture.store), readSessionContentNode: content, readSessionContentRange: content }
    const service = createSessionChangesService({ reader, writer: asAsyncEventWriter(fixture.store), manager, projectRoot: fixture.root })
    const reads = spyOn(fixture.store, "readTolerant")
    const query = { type: "sessionChanges" as const, sessionId: fixture.sessionId, offset: 0, maxFiles: 2, maxBytes: 950 }
    const first = await service.list(query)
    expect(first.status).toBe("ready")
    expect(first.totalFiles).toBe(3)
    expect(first.files.length).toBeGreaterThan(0)
    expect(first.files.length).toBeLessThanOrEqual(2)
    const paths = first.files.map(file => file.path)
    let nextOffset = first.nextOffset
    while (nextOffset !== null) {
      const page = await service.list({ ...query, offset: nextOffset, cursor: first.cursor, revision: first.revision })
      expect(page.status).toBe("ready")
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(query.maxBytes)
      paths.push(...page.files.map(file => file.path))
      nextOffset = page.nextOffset
    }
    expect(paths).toEqual(["a", "b", "c"].map(name => join(fixture.root, name)))
    expect(content).not.toHaveBeenCalled()
    expect(reads.mock.calls.filter(([readQuery]) => readQuery?.types?.includes("file.changed"))).toHaveLength(1)
    reads.mockRestore()
    writeFileSync(join(fixture.root, "c"), "external\n")
    const continuation = { ...query, offset: first.nextOffset!, cursor: first.cursor, revision: first.revision }
    expect((await service.list(continuation)).status).toBe("stale")
    writeFileSync(join(fixture.root, "c"), "c\n")
    await change(join(fixture.root, "d"), "d\n")
    expect((await service.list(continuation)).status).toBe("stale")
    await expect(service.list({ ...query, maxBytes: 1 })).rejects.toThrow()
  })
})

test("direct requests cannot reach Flywheel-owned files", async () => {
  await withService(async (service, fixture, change) => {
    const internal = join(fixture.root, ".flywheel", "note.md")
    const sibling = join(fixture.root, ".flywheel-old", "kept.md")
    mkdirSync(join(fixture.root, ".flywheel-old"))
    await change(internal, "internal\n")
    await change(sibling, "reviewable\n")
    const list = await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    const internalFact = fixture.store.read({ sessionId: fixture.sessionId, types: ["file.changed"] }).find(event => {
      const fact = readChangeFact(event)
      return fact.type === "file.changed" && fact.payload.path === internal
    })
    if (!internalFact) throw new Error("Missing internal file mutation")
    const internalFileId = `file:${internalFact.id}`

    expect(await service.diff({ type: "sessionChangeDiff", sessionId: fixture.sessionId, fileId: internalFileId, revision: list.revision })).toEqual({ status: "stale" })
    expect(await service.undo({ type: "session.changes.undo", sessionId: fixture.sessionId, fileId: internalFileId, revision: list.revision }, new AbortController().signal)).toEqual({ status: "refused", message: "Unknown or foreign file ID" })
    expect(readFileSync(internal, "utf8")).toBe("internal\n")

    const siblingFile = list.files.find(file => file.path === sibling)
    if (!siblingFile) throw new Error("Missing reviewable sibling")
    const siblingQuery = { type: "sessionChangeDiff" as const, sessionId: fixture.sessionId, fileId: siblingFile.fileId, revision: list.revision }
    expect((await service.diff(siblingQuery)).status).toBe("ready")
    expect(await service.undo({ type: "session.changes.undo", sessionId: fixture.sessionId, fileId: siblingFile.fileId, revision: list.revision }, new AbortController().signal)).toEqual({ status: "completed" })
  })
})

test("diff returns the net before-session to now diff, goes stale on revision drift, and reports unavailable reasons", async () => {
  await withService(async (service, fixture, change) => {
    const path = join(fixture.root, "a")
    writeFileSync(path, "one\n")
    await change(path, "two\n")
    await change(path, "three\n")
    const list = await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    const query = { type: "sessionChangeDiff" as const, sessionId: fixture.sessionId, fileId: list.files[0]!.fileId, revision: list.revision }
    const ready = await service.diff(query)
    expect(roundTrip(queryRpc, ready)).toEqual(ready)
    if (ready.status !== "ready") throw new Error("Expected a ready diff")
    expect(ready.revision).toBe(list.revision)
    expect(ready.diff.path).toBe(path)
    expect(ready.diff.change).toBe("modified")
    expect(ready.diff.omittedLines).toBe(0)
    if (ready.diff.patch.kind !== "retained") throw new Error("Expected retained patch")
    expect(await readPatchContent(asAsyncEventReadSurface(fixture.store), fixture.sessionId, ready.diff.patch.reference)).toContain("-one\n+three")
    expect(await service.diff(query)).toEqual(ready)
    expect(ready.lineCounts).toEqual({ added: 1, removed: 1 })
    expect(await service.diff({ ...query, revision: query.revision + 1 })).toEqual({ status: "stale" })
    expect(await service.diff({ ...query, fileId: "file:foreign" })).toEqual({ status: "stale" })
    expect(() => Schema.decodeUnknownSync(SessionChangeDiffQuerySchema)({ ...query, fileId: "not-a-file-id" })).toThrow()
    writeFileSync(path, "external\n")
    expect(await service.diff(query)).toEqual({ status: "unavailable", revision: list.revision, reason: "drifted" })
    const excluded = await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    expect(excluded.files).toEqual([])
    expect(excluded.excludedFileCount).toBe(1)
    writeFileSync(path, "three\n")
    fixture.store.append({ sessionId: fixture.sessionId, aggregateId: `session:${fixture.sessionId}`, type: "file.changed", version: 4, actor: "flywheel", timestamp: 1, payload: { broken: true } })
    const gapped = await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    expect(gapped.unknownFileMutationGaps).toBe(1)
    expect(await service.diff({ ...query, revision: gapped.revision })).toEqual({ status: "unavailable", revision: gapped.revision, reason: "unretained" })
  })
})

test("diff counts all changed lines before the rendered retention limit", async () => {
  await withService(async (service, fixture, change) => {
    const path = join(fixture.root, "large.txt")
    for (const length of [400, 800, 1200]) await change(path, Array.from({ length }, (_, index) => `line ${index}\n`).join(""))
    const list = await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    const ready = await service.diff({ type: "sessionChangeDiff", sessionId: fixture.sessionId, fileId: list.files[0]!.fileId, revision: list.revision })
    if (ready.status !== "ready") throw new Error("Expected a ready diff")
    expect(ready.lineCounts).toEqual({ added: 1200, removed: 0 })
    expect(ready.diff.omittedLines).toBe(200)
    expect(roundTrip(queryRpc, ready)).toEqual(ready)
  })
})

test("diff reports a malformed retained patch as unretained instead of failing the read", async () => {
  await withService(async (service, fixture, change) => {
    const path = join(fixture.root, "a")
    writeFileSync(path, "one\n")
    await change(path, "two\n")
    const artifact = fixture.store.read({ sessionId: fixture.sessionId, types: ["file.artifact.recorded"] })[0]!
    const fact = readChangeFact(artifact)
    if (fact.type !== "file.artifact.recorded" || fact.version !== 4) throw new Error("Missing runtime diff")
    fixture.store.append({ sessionId: fixture.sessionId, aggregateId: `session:${fixture.sessionId}`, type: "file.artifact.recorded", version: 3, actor: "flywheel", timestamp: 1, payload: { mutationId: fact.payload.mutationId, artifactId: fact.payload.artifactId, ownerId: fact.payload.ownerId, ownerKind: "runtime", artifactKind: "mutation_diff", path, mutation: { version: 1, files: [{ path, change: "modified", unifiedDiff: "--- a\n+++ b\n@@ -1 +1 @@\n" }], omissions: [] } } })
    const list = await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    expect(await service.diff({ type: "sessionChangeDiff", sessionId: fixture.sessionId, fileId: list.files[0]!.fileId, revision: list.revision })).toEqual({ status: "unavailable", revision: list.revision, reason: "unretained" })
  })
})

test("selected net diff stages a deduplicated root and exact byte windows across a long UTF-8 line", async () => {
  await withService(async (service, fixture, change, manager) => {
    const path = join(fixture.root, "long")
    const before = `${"old".repeat(25000)}\n`
    const after = `${"新".repeat(25000)}\n`
    writeFileSync(path, before)
    await change(path, "middle\n")
    await change(path, after)
    const list = await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    const query = { type: "sessionChangeDiff" as const, sessionId: fixture.sessionId, fileId: list.files[0]!.fileId, revision: list.revision }
    const ready = await service.diff(query)
    if (ready.status !== "ready" || ready.diff.patch.kind !== "retained") throw new Error("Expected retained diff")
    expect(Buffer.byteLength(JSON.stringify(ready))).toBeLessThan(2048)
    const db = new Database(resolveEventStoreDbFile(fixture.root), { readonly: true })
    try {
      const count = () => db.query<{ count: number }, []>("select count(*) as count from tool_content where session_content_node = 1").get()!.count
      const storedNodes = count()
      expect(await service.diff(query)).toEqual(ready)
      expect(count()).toBe(storedNodes)
    } finally { db.close() }
    const windows = createMutationEvidenceService({ reader: asAsyncEventReadSurface(fixture.store), manager, projectRoot: fixture.root })
    const parts: Buffer[] = []
    let offset = 0
    do {
      const page = await windows.patchWindow({ type: "mutationPatchWindow", sessionId: fixture.sessionId, reference: ready.diff.patch.reference, offset, maxBytes: 4096 })
      if (page.kind !== "available") throw new Error("Missing derived patch")
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096)
      parts.push(Buffer.from(page.base64, "base64"))
      offset = page.nextOffset ?? ready.diff.patch.reference.bytes
    } while (offset < ready.diff.patch.reference.bytes)
    const exact = Buffer.concat(parts)
    expect(exact.toString()).toBe(buildMutationDiff([{ path, before: { kind: "text", text: before }, after: { kind: "text", text: after } }]).files[0]!.unifiedDiff)
    expect(new Bun.CryptoHasher("sha256").update(exact).digest("hex")).toBe(ready.diff.patch.reference.sha256)
  })
})

test("undo dispatches through the RPC schema and removes the file from the list", async () => {
  await withService(async (service, fixture, change) => {
    const path = join(fixture.root, "a")
    await change(path, "made\n")
    const list = await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    const command = { type: "session.changes.undo" as const, sessionId: fixture.sessionId, fileId: list.files[0]!.fileId, revision: list.revision }
    expect(Schema.decodeUnknownSync(dispatchRpc.payloadSchema)(command)).toEqual(command)
    for (const invalid of [{ ...command, fileIds: [command.fileId] }, { ...command, revision: -1 }, { ...command, fileId: "a" }]) expect(() => Schema.decodeUnknownSync(SessionChangesUndoSchema, { onExcessProperty: "error" })(invalid)).toThrow()
    expect(await service.undo({ ...command, revision: command.revision + 1 }, new AbortController().signal)).toEqual({ status: "refused", message: "Changes have moved on; refresh and try again" })
    const result = await service.undo(command, new AbortController().signal)
    expect(result).toEqual({ status: "completed" })
    expect(roundTrip(dispatchRpc, result)).toEqual(result)
    expect((await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })).files).toEqual([])
    for (const message of [{ status: "refused", message: "x" }, { status: "uncertain", message: "y" }]) expect(roundTrip(dispatchRpc, message)).toEqual(message)
  })
})

test("undo restores a file that a mutating bash command changed", async () => {
  await loadBashParser()
  await withService(async (service, fixture) => {
    const path = join(fixture.root, "a")
    writeFileSync(path, "one\ntwo\n")
    const bash = createBashDefinition({ operations: makeMockOps({ ensureDir: dir => { mkdirSync(dir, { recursive: true }) } }) })
    const result = await bash.execute({ command: "reshape", mutates: true }, makeContext({
      projectRoot: fixture.root, executionCwd: fixture.root, scratchDir: join(fixture.root, ".flywheel", "scratch"), toolUseId: "bash-1", sessionId: fixture.sessionId,
      sessionEventWriter: fixture.writer, spawnOwned: mutationSpawnProbe(cwd => writeFileSync(join(cwd, "a"), "one\nTWO\n")).spawnOwned,
    }))
    expect(readFileSync(path, "utf8")).toBe("one\nTWO\n")
    expect(result.content).toContain("Updated a")
    // The agent loop records the settled result with its details; undo reads the diff from there.
    await fixture.writer.record({ type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "bash-1", outcome: "ok", details: result.details } })
    const list = await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    expect(await service.undo({ type: "session.changes.undo", sessionId: fixture.sessionId, fileId: list.files[0]!.fileId, revision: list.revision }, new AbortController().signal)).toEqual({ status: "completed" })
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n")
  })
})

test("a background mutation command's settled record carries its diff to the original call's row and to undo", async () => {
  await loadBashParser()
  await withService(async (service, fixture) => {
    const path = join(fixture.root, "a")
    writeFileSync(path, "one\ntwo\n")
    const recordings: Promise<unknown>[] = []
    const registry = createBackgroundWorkRegistry({
      kind: "chat",
      enqueueNotification() {},
      // The runner's emitter and fact mapper, as production records a settled tail.
      onExecutionOutputRecorded: (toolUseId, output, identity, edits) => emitToolExecutionOutputRecorded((event) => {
        for (const fact of mapRuntimeEventToSessionRuntimeFacts(event)) recordings.push(fixture.writer.record(fact))
      }, toolUseId, output, identity, edits),
    })
    const bash = createBashDefinition({ operations: makeMockOps({
      ensureDir: dir => { mkdirSync(dir, { recursive: true }) },
      async writeScript(_path, content) {
        const log = backgroundLogPath(content)
        if (log) await Bun.write(log, "")
        return content.length
      },
    }) })
    await bash.execute({ command: "reshape", mutates: true, background: true }, makeContext({
      projectRoot: fixture.root, executionCwd: fixture.root, scratchDir: join(fixture.root, ".flywheel", "scratch"), toolUseId: "bash-1", sessionId: fixture.sessionId,
      sessionEventWriter: fixture.writer, spawnOwned: mutationSpawnProbe(cwd => writeFileSync(join(cwd, "a"), "one\nTWO\n")).spawnOwned,
      capabilityAccess: capabilityAccessHolding(["background-commands"]), backgroundTasks: registry,
    }))
    const deadline = Date.now() + 5_000
    while (registry.activeTaskCount() > 0 || recordings.length === 0) {
      if (Date.now() > deadline) throw new Error("background command did not settle")
      await Bun.sleep(5)
    }
    await Promise.all(recordings)
    expect(readFileSync(path, "utf8")).toBe("one\nTWO\n")
    const evidence = (await readToolResultDisplayMeta(asAsyncEventReadSurface(fixture.store), fixture.sessionId)).get("bash-1")?.mutationEvidence
    expect(evidence).toBeDefined()
    if (!evidence) throw new Error("Background mutation evidence is missing")
    const reader = asAsyncEventReadSurface(fixture.store)
    if (!reader.readSessionContentNode) throw new Error("Missing content reader")
    const page = await readMutationEvidenceFiles(evidence, 0, 128, hash => reader.readSessionContentNode!(fixture.sessionId, hash))
    expect(page.kind === "available" ? page.files.map(entry => entry.kind === "applied" ? entry.file.path : undefined) : []).toEqual([path])
    const list = await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })
    expect(await service.undo({ type: "session.changes.undo", sessionId: fixture.sessionId, fileId: list.files[0]!.fileId, revision: list.revision }, new AbortController().signal)).toEqual({ status: "completed" })
    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n")
  })
})

test("Viewed replays durably, survives unrelated edits, manually clears, and refuses stale same-byte tokens", async () => {
  await withService(async (service, fixture, change) => {
    const a = join(fixture.root, "a"), b = join(fixture.root, "b")
    writeFileSync(a, "one\n")
    await change(a, "two\n")
    let entry = (await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })).files[0]!
    const viewed = { type: "session.changes.set_viewed" as const, sessionId: fixture.sessionId, fileId: entry.fileId, editToken: entry.editToken, reviewed: true }
    expect(Schema.decodeUnknownSync(dispatchRpc.payloadSchema)(viewed)).toEqual(viewed)
    expect(Schema.decodeUnknownSync(SessionChangesSetViewedSchema)(viewed)).toEqual(viewed)
    expect(await service.setViewed(viewed)).toEqual({ status: "completed" })
    expect((await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })).files[0]?.review.status).toBe("viewed")
    const replayFixture = changeReviewFixture(fixture.store.read({ sessionId: fixture.sessionId }))
    const replay = await getSessionChangeReview(replayFixture.projectionReader, fixture.sessionId)
    const replayedFile = replay.file(entry.fileId)
    expect(replayedFile && replay.reviewStatus(replayedFile)).toBe("viewed")

    await change(b, "other\n")
    expect((await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })).files.find(file => file.fileId === entry.fileId)?.review.status).toBe("viewed")
    expect(await service.setViewed({ ...viewed, reviewed: false })).toEqual({ status: "completed" })
    expect((await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })).files.find(file => file.fileId === entry.fileId)?.review.status).toBe("unviewed")
    expect(await service.setViewed(viewed)).toEqual({ status: "completed" })

    await change(a, "one\n")
    await change(a, "two\n")
    entry = (await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })).files.find(file => file.fileId === entry.fileId)!
    expect(entry.editToken).not.toEqual(viewed.editToken)
    expect(entry.review.status).toBe("unviewed")
    expect(await service.setViewed(viewed)).toEqual({ status: "refused", message: "File changed; refresh and try again" })

    const rebuiltFixture = changeReviewFixture(fixture.store.read({ sessionId: fixture.sessionId }))
    const rebuilt = await getSessionChangeReview(rebuiltFixture.projectionReader, fixture.sessionId)
    const rebuiltFile = rebuilt.file(entry.fileId)
    expect(rebuiltFile && rebuilt.reviewStatus(rebuiltFile)).toBe("unviewed")
  })
})

test("Viewed makes one guarded append attempt and refuses aggregate contention", async () => {
  await withService(async (_service, fixture, change, manager) => {
    const path = join(fixture.root, "contended")
    writeFileSync(path, "before")
    await change(path, "after")
    const entry = (await _service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })).files[0]!
    const baseWriter = asAsyncEventWriter(fixture.store)
    let attempts = 0
    const writer = {
      ...baseWriter,
      appendGuarded: async (event: GuardedEventStoreAppend) => {
        attempts++
        return {
          kind: "conflict" as const,
          conflict: { aggregateId: event.aggregateId, expectedSeq: event.expectedSeq ?? 0, actualSeq: (event.expectedSeq ?? 0) + 1 },
        }
      },
    }
    const service = createSessionChangesService({ reader: asAsyncEventReadSurface(fixture.store), writer, manager, projectRoot: fixture.root })
    expect(await service.setViewed({
      type: "session.changes.set_viewed", sessionId: fixture.sessionId, fileId: entry.fileId,
      editToken: entry.editToken, reviewed: true,
    })).toEqual({ status: "refused", message: "File changed; refresh and try again" })
    expect(attempts).toBe(1)
  })
})

test("Viewed point validation hashes only the selected file", async () => {
  await withService(async (service, fixture, change) => {
    const a = join(fixture.root, "point-a"), b = join(fixture.root, "point-b")
    writeFileSync(a, "before-a")
    writeFileSync(b, "before-b")
    await change(a, "after-a")
    await change(b, "after-b")
    const entry = (await service.list({ type: "sessionChanges", sessionId: fixture.sessionId, offset: 0, maxFiles: 128, maxBytes: 65536 })).files.find(file => file.path === a)!
    const read = spyOn(fs, "readFileSync")
    try {
      expect(await service.setViewed({
        type: "session.changes.set_viewed", sessionId: fixture.sessionId, fileId: entry.fileId,
        editToken: entry.editToken, reviewed: true,
      })).toEqual({ status: "completed" })
      const paths = read.mock.calls.map(call => call[0])
      expect(paths).toContain(a)
      expect(paths).not.toContain(b)
    } finally {
      read.mockRestore()
    }
  })
})
