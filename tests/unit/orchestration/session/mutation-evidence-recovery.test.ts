import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { temporaryDirectories } from "../../../helpers/directories.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, CorruptEventRowError, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { buildMutationDiff, type MutationDiff } from "../../../../src/infra/mutation-diff.js"
import { readMutationEvidenceFiles } from "../../../../src/infra/mutation-evidence.js"
import { MutationEvidenceSchema } from "../../../../src/infra/mutation-evidence-schema.js"
import { ManagedRuntime, Schema } from "effect"
import { Database } from "bun:sqlite"
import { createMutationEvidenceRecovery } from "../../../../src/orchestration/session/mutation-evidence-recovery.js"
import { parseFileMutationOperationHeader, readFileMutationOperation } from "../../../../src/orchestration/session/file-mutation-operation.js"
import { parseStoredSessionRuntimeFact } from "../../../../src/infra/runtime-fact-parser.js"
import { parseConversationTreeFact } from "../../../../src/orchestration/session/conversation/conversation-facts.js"
import { parseFileMutationFact } from "../../../../src/orchestration/session/file-mutation-facts.js"
import { readPatchContent } from "../../../../src/orchestration/session/session-change-sources.js"
import { row, timestamp } from "./_session-change-fixtures.js"
import { encodeProjectStateResponse } from "../../../../src/orchestration/app-service/project-state-protocol.js"
import { extractContent } from "../../../../src/infra/tool-content.js"
import { hydrateToolContentFact } from "../../../../src/infra/tool-content-hydration.js"
import { EventReaderService, EventStoreLive, EventStoreService, LocalEventStoreService } from "../../../../src/infra/event-store-effect.js"
import { closeFixtures, fixture as stateChannelFixture } from "../app-service/_project-state-worker-fixture.js"
import { asRecord } from "../../../../src/infra/record.js"

const directory = temporaryDirectories()
const stores: ReturnType<typeof createSqliteEventStore>[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
afterEach(closeFixtures)

function fixture() {
  const path = join(directory("mutation-recovery-"), "facts.sqlite")
  const store = createSqliteEventStore(path)
  stores.push(store)
  const reader = asAsyncEventReadSurface(store)
  const writer = asAsyncEventWriter(store)
  let stages = 0
  let swaps = 0
  const recovery = createMutationEvidenceRecovery(reader, {
    ...writer,
    async stageSessionContentNodes(sessionId, nodes) { stages += 1; await writer.stageSessionContentNodes!(sessionId, nodes) },
    async swapInFlight(...args) { swaps += 1; return writer.swapInFlight!(...args) },
  })
  return { store, path, reader: recovery.reader, recovery, counts: () => ({ stages, swaps }) }
}

const mutation = buildMutationDiff([{ path: "/root/a", before: { kind: "text", text: "old\n" }, after: { kind: "text", text: "new\n" } }])
const endpoint = (text: string) => ({ bytes: Buffer.byteLength(text), sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"), preview: text })
const changed = {
  mutationId: "m", path: "/root/a", displayPath: "a", changeKind: "modified",
  before: endpoint("old\n"), after: endpoint("new\n"), toolUseId: "tool",
}
const checkpoint = {
  conversationId: "c", toolUseId: "tool", toolName: "edit", budgetExempt: false, registrationOrdinal: 7,
  content: [{ type: "text", text: "changed" }], outcome: "error", details: { mutation }, executionOutputTail: "tail",
}

function value(fact: StoredFact | CorruptEventRowError): StoredFact {
  if (fact instanceof Error) throw fact
  expect(encodeProjectStateResponse({ id: 1, result: { kind: "fact-slice", facts: [fact], contentRows: [], encodedBytes: 0 } }).byteLength).toBeLessThan(65_536)
  return fact
}

describe("state-local mutation evidence recovery", () => {
  test("joins historical Undo endpoints once per selected recovery batch", async () => {
    const { store } = fixture()
    for (let index = 0; index < 8; index++) {
      const mutationId = `undo-${index}`
      store.append(row(index * 2 + 1, "file.changed", { ...changed, mutationId }, 2))
      store.append(row(index * 2 + 2, "file.artifact.recorded", {
        mutationId, artifactId: `artifact-${index}`, ownerKind: "runtime", ownerId: mutationId,
        artifactKind: "mutation_diff", path: "/root/a", mutation,
      }, 3))
    }
    const raw = asAsyncEventReadSurface(store)
    let endpointReads = 0
    const reader = createMutationEvidenceRecovery({
      ...raw, async readSlice(query, tolerant) {
        if (query.types?.includes("file.changed")) endpointReads++
        return raw.readSlice(query, tolerant)
      },
    }, asAsyncEventWriter(store)).reader
    const selected = await reader.readSlice({ sessionId: "s", types: ["file.artifact.recorded"] })
    expect(selected.facts).toHaveLength(8)
    expect(selected.facts.every(fact => !(fact instanceof Error) && fact.version === 4)).toBe(true)
    expect(endpointReads).toBe(1)
  })
  test("local composition shares the canonical channel view while retaining the raw connection and service identity", async () => {
    const channel = await stateChannelFixture()
    const original = channel.store.append(row(1, "tool.result.recorded", { toolUseId: "t", outcome: "ok", details: { mutation } }))
    channel.store.putInFlight("s", "finalized-tool-result", "c:tool", checkpoint)
    let factoryCalls = 0
    let reads = 0
    let stages = 0
    let swaps = 0
    let recovery: ReturnType<typeof createMutationEvidenceRecovery> | undefined
    const runtime = ManagedRuntime.make(EventStoreLive(channel.path, (raw, writer) => {
      factoryCalls += 1
      const observed = {
        ...raw,
        readSlice: (...args: Parameters<typeof raw.readSlice>) => { reads += 1; return raw.readSlice(...args) },
        readPage: (...args: Parameters<typeof raw.readPage>) => { reads += 1; return raw.readPage(...args) },
        readInFlight: (...args: Parameters<typeof raw.readInFlight>) => { reads += 1; return raw.readInFlight(...args) },
      }
      recovery = createMutationEvidenceRecovery(observed, {
        ...writer,
        async stageSessionContentNodes(sessionId, nodes) {
          stages += 1
          await writer.stageSessionContentNodes!(sessionId, nodes)
        },
        async swapInFlight(...args) {
          swaps += 1
          return writer.swapInFlight!(...args)
        },
      })
      return recovery.reader
    }))
    try {
      const reader = await runtime.runPromise(EventReaderService)
      const state = await runtime.runPromise(EventStoreService)
      const raw = await runtime.runPromise(LocalEventStoreService)
      expect(reads).toBe(0)
      expect(stages).toBe(0)
      expect(swaps).toBe(0)
      const current = row(2, "tool.result.recorded", { toolUseId: "current", outcome: "ok" }, 3)
      expect(await recovery!.normalizeFact(current)).toBe(current)
      expect(reads).toBe(0)
      expect(stages).toBe(0)
      expect(swaps).toBe(0)
      expect(reader).toBe(state)
      expect(raw.read({ types: ["tool.result.recorded"] })).toEqual([original])
      const query = { aggregateId: "session:s", types: ["tool.result.recorded"] }
      const selected = await reader.readSlice(query)
      expect(selected.facts[0]).toMatchObject({ version: 3, payload: { details: { mutationEvidence: { retainedFiles: 1 } } } })
      expect(factoryCalls).toBe(1)
      expect((await channel.client.readSlice(query)).facts).toEqual(selected.facts)
      expect((await state.readPage(query, original.position, 0)).facts).toEqual(selected.facts)
      expect(await reader.readLatestByAggregateAndTypes(query.aggregateId, query.types)).toEqual(selected.facts.map(value))
      expect(value(selected.facts[0]!).payload).toEqual(JSON.parse((await reader.readLatestPayloadByAggregateAndType(query.aggregateId, query.types[0]!))!))
      expect((await reader.readInFlight("s", "finalized-tool-result"))[0]?.payload).toMatchObject({ version: 2, details: { mutationEvidence: { retainedFiles: 1 } } })
      expect(swaps).toBe(1)
      expect(await channel.client.readInFlight("s", "finalized-tool-result")).toEqual(await reader.readInFlight("s", "finalized-tool-result"))
      expect(raw.read({ types: ["tool.result.recorded"] })).toEqual([original])
      expect(await reader.capturePosition()).toBe(original.position)
    } finally {
      await runtime.dispose()
    }
  })

  for (const version of [1, 2]) {
    for (const type of ["tool.result.recorded", "tool.execution_output.recorded"]) {
      test(`converts literal ${type} v${version} while retaining immutable identity and exact display bytes`, async () => {
        const { store, reader, recovery } = fixture()
        const text = "ordinary output\n".repeat(300)
        const ordinary = extractContent(text)
        if (ordinary.kind !== "reference") throw new Error("expected ordinary text reference")
        const payload = type === "tool.result.recorded"
          ? { toolUseId: "tool", outcome: "error", details: { mutation, filetype: "typescript" }, ...(version === 2 ? { content: ordinary.reference, parentToolUseId: "parent" } : {}) }
          : { toolUseId: "tool", output: version === 2 ? ordinary.reference : "tail", mutation }
        const stored = store.append({ ...row(1, type, payload, version), ...(version === 2 ? { contentRows: [ordinary.row] } : {}) })
        const raw = store.readLatestPayloadByAggregateAndType("session:s", type)
        const recovered = value(await recovery.normalizeFact(stored))
        expect(recovered).toMatchObject({ id: stored.id, seq: stored.seq, position: stored.position, aggregateId: stored.aggregateId, version: version === 1 ? 3 : 4 })
        parseStoredSessionRuntimeFact({ type, version: recovered.version, actor: recovered.actor, payload: recovered.payload })
        const details = type === "tool.result.recorded" ? recovered.payload.details : recovered.payload
        const summary = Schema.decodeUnknownSync(MutationEvidenceSchema)(asRecord(details)?.mutationEvidence)
        expect(Buffer.byteLength(JSON.stringify(recovered))).toBeLessThan(4096)
        const files = await readMutationEvidenceFiles(summary, 0, 10, hash => reader.readSessionContentNode!("s", hash))
        expect(files.kind).toBe("available")
        if (files.kind !== "available") throw new Error("unavailable files")
        const file = files.files[0]
        expect(file?.kind).toBe("display")
        if (file?.kind !== "display" || file.file.patch.kind !== "retained") throw new Error("missing patch")
        expect(file.file).not.toHaveProperty("before")
        expect(file.file).not.toHaveProperty("after")
        expect(await readPatchContent(reader, "s", file.file.patch.reference)).toBe(mutation.files[0]!.unifiedDiff)
        expect(store.readLatestPayloadByAggregateAndType("session:s", type)).toBe(raw)
        expect(store.currentPosition()).toBe(stored.position)
        expect(store.aggregateSeq("session:s")).toBe(stored.seq)
        if (version === 2) {
          const hydrated = hydrateToolContentFact(recovered, store.toolContent)
          expect(hydrated.version).toBe(3)
          expect(type === "tool.result.recorded" ? hydrated.payload.content : hydrated.payload.output).toBe(text)
          expect(hydrated.payload).toHaveProperty(type === "tool.result.recorded" ? "details.mutationEvidence" : "mutationEvidence")
        }
      })
    }
  }

  test("preserves sensitive omissions and exact retained-line remainders without granting display Undo authority", async () => {
    const { reader, recovery } = fixture()
    const old: MutationDiff = {
      version: 1, files: [{ ...mutation.files[0]!, omittedLines: 12 }],
      omissions: [{ path: "secret", reason: "sensitive" }, { path: "legacy", reason: "collection_over_budget" }],
    }
    const recovered = value(await recovery.normalizeFact(row(1, "tool.execution_output.recorded", { toolUseId: "t", output: "", mutation: old })))
    const summary = Schema.decodeUnknownSync(MutationEvidenceSchema)(recovered.payload.mutationEvidence)
    expect(summary).toMatchObject({ retainedFiles: 1, omissions: 3, unknownChanges: 2 })
    const page = await readMutationEvidenceFiles(summary, 0, 10, hash => reader.readSessionContentNode!("s", hash))
    if (page.kind !== "available") throw new Error("unavailable evidence")
    expect(page.files[0]).toMatchObject({ kind: "display", file: { omittedLines: 12 } })
    expect(page.files[1]).toEqual({ kind: "omitted", path: "secret", displayPath: "secret", reason: "sensitive" })
    expect(page.files[1]).not.toHaveProperty("file")
  })

  test("converts Undo artifacts using the matching file.changed endpoints, not fabricated endpoints", async () => {
    const { store, recovery, reader } = fixture()
    store.append(row(1, "file.changed", changed, 2))
    const old = store.append(row(2, "file.artifact.recorded", { mutationId: "m", artifactId: "artifact", ownerKind: "runtime", ownerId: "undo", artifactKind: "mutation_diff", path: "/root/a", mutation }, 3))
    const next = value(await recovery.normalizeFact(old))
    expect(next.version).toBe(4)
    const parsed = parseFileMutationFact({ type: next.type, version: next.version, actor: next.actor, payload: next.payload })
    if (parsed.type !== "file.artifact.recorded" || parsed.version !== 4) throw new Error("missing artifact")
    expect(parsed.payload.evidence).toMatchObject({ mutationId: "m", path: "/root/a", before: { bytes: 4, sha256: changed.before.sha256 }, after: { bytes: 4, sha256: changed.after.sha256 } })
    if (parsed.payload.evidence.patch.kind !== "retained") throw new Error("missing patch")
    expect(await readPatchContent(reader, "s", parsed.payload.evidence.patch.reference)).toBe(mutation.files[0]!.unifiedDiff)
    expect(store.read({ types: ["file.artifact.recorded"] })[0]).toEqual(old)
  })

  test("normalizes historical review notices and conversation entries without changing provider text or entry identity", async () => {
    const { recovery } = fixture()
    const reviewMutations = [{ name: "skill", action: "updated", reach: "project", mutation }]
    const system = value(await recovery.normalizeFact(row(1, "agent.system_message.recorded", { message: "review complete", reviewMutations })))
    expect(system).toMatchObject({ version: 2, payload: { message: "review complete", mutationEvidence: { retainedFiles: 1 } } })
    const original = row(2, "chat.entries.appended", { conversationId: "c", entries: [
      { id: "parent", parentId: null, timestamp, kind: "message", message: { kind: "user", content: "inspect" } },
      { id: "notice", parentId: "parent", timestamp, kind: "message", displayOnly: true, message: { kind: "system", content: "review complete", reviewMutations } },
    ] }, 3)
    const next = value(await recovery.normalizeFact(original))
    const parsed = parseConversationTreeFact({ type: next.type, version: next.version, actor: next.actor, payload: next.payload })
    expect(parsed).toMatchObject({ version: 7, payload: { entries: [
      { id: "parent", message: { content: "inspect" } },
      { id: "notice", parentId: "parent", displayOnly: true, message: { kind: "system", content: "review complete", mutationEvidence: { retainedFiles: 1 } } },
    ] } })
    expect(JSON.stringify(next)).not.toContain("unifiedDiff")
    expect(JSON.stringify(next)).not.toContain("reviewMutations")
  })

  test("CAS-converts finalized cells once and keeps registration order, identity and recovery fields", async () => {
    const { store, reader, counts } = fixture()
    store.putInFlight("s", "finalized-tool-result", "c:tool", checkpoint)
    const original = store.readInFlight("s", "finalized-tool-result")[0]!
    const first = (await reader.readInFlight("s", "finalized-tool-result"))[0]!
    expect(first.payload).toMatchObject({ ...checkpoint, version: 2, details: { mutationEvidence: { retainedFiles: 1 } } })
    expect(first.payload).not.toHaveProperty("details.mutation")
    expect(first.raw).toBe(JSON.stringify(first.payload))
    expect(first.raw).not.toBe(original.raw)
    expect(encodeProjectStateResponse({ id: 1, result: { kind: "in-flight", records: [first] } }).byteLength).toBeLessThan(4096)
    const before = counts()
    expect(await reader.readInFlight("s", "finalized-tool-result")).toEqual([first])
    expect(counts()).toEqual(before)
    expect(before.swaps).toBe(1)
    expect(store.currentPosition()).toBe(0)
  })

  test("repeated immutable reads reuse the same content rows and manifest root", async () => {
    const { store, path, recovery } = fixture()
    const old = store.append(row(1, "tool.result.recorded", { toolUseId: "t", outcome: "ok", details: { mutation } }))
    const first = value(await recovery.normalizeFact(old))
    const db = new Database(path, { readonly: true })
    try {
      const count = db.query("select count(*) as count from tool_content").get()
      const second = value(await recovery.normalizeFact(old))
      expect(second).toEqual(first)
      expect(db.query("select count(*) as count from tool_content").get()).toEqual(count)
    } finally { db.close() }
  })

  test("normalizes selected pages, exact slices and latest views before returning them to local owners", async () => {
    const { store, reader } = fixture()
    const original = store.append(row(1, "tool.result.recorded", { toolUseId: "t", outcome: "ok", details: { mutation } }))
    const query = { aggregateId: "session:s", types: ["tool.result.recorded"] }
    const slice = await reader.readSlice(query)
    const page = await reader.readPage(query, original.position, 0)
    const latest = await reader.readLatestByAggregateAndTypes("session:s", query.types)
    const payload = await reader.readLatestPayloadByAggregateAndType("session:s", query.types[0]!)
    expect(slice.facts[0]).toMatchObject({ version: 3, payload: { details: { mutationEvidence: { retainedFiles: 1 } } } })
    expect(page.facts).toEqual(slice.facts)
    expect(latest).toEqual(slice.facts.map(value))
    expect(JSON.parse(payload!)).toEqual(value(slice.facts[0]!).payload)
    expect(store.read(query)[0]).toEqual(original)
  })

  test("a losing finalized-cell CAS returns the current winner without overwriting it", async () => {
    const { store } = fixture()
    store.putInFlight("s", "finalized-tool-result", "c:tool", checkpoint)
    const writer = asAsyncEventWriter(store)
    const winner = { ...checkpoint, version: 2, outcome: "ok", details: {} }
    const recovery = createMutationEvidenceRecovery(asAsyncEventReadSurface(store), {
      ...writer,
      async swapInFlight(...args) {
        store.putInFlight("s", "finalized-tool-result", "c:tool", winner)
        return writer.swapInFlight!(...args)
      },
    })
    const result = await recovery.reader.readInFlight("s", "finalized-tool-result")
    expect(result[0]?.payload).toEqual(winner)
    expect(store.readInFlight("s", "finalized-tool-result")[0]?.payload).toEqual(winner)
  })

  test("leaves literal per-file preparation cells readable by the existing recovery boundary", async () => {
    const { store, reader, counts } = fixture()
    store.putInFlight("s", "file.mutation", "m", changed)
    const old = store.readInFlight("s", "file.mutation")
    expect(await reader.readInFlight("s", "file.mutation")).toEqual(old)
    expect(counts()).toEqual({ stages: 0, swaps: 0 })
  })

  for (const version of [1, 2, 3]) test(`preserves a legacy v${version} file operation's ordered plan and cursor while converting candidate evidence`, async () => {
    const { store, reader } = fixture()
    const { toolUseId: _toolUseId, ...content } = changed
    const evidence = version === 1 ? changed : { ...content, operationId: "op", origin: { kind: "user_undo", reviewRevision: 0, fileId: "file", sourceMutationIds: Array.from({ length: 2_000 }, () => randomUUID()) } }
    const proofs = [0, 1].map(index => {
      const access = index === 0 ? { kind: "posix", mode: 0o640 } : { kind: "win32", daclBase64: "AQIDBA==" }
      const proof = { kind: "file", sha256: "a".repeat(64), bytes: 4, linkCount: 1, executable: false, access }
      return { precondition: { ...proof, identity: `file-${index}` }, postcondition: { ...proof, identity: { kind: "new", replaced: `file-${index}` } } }
    })
    const cell = { version, operationId: "op", cursor: 1, items: [0, 1].map(index => ({
      evidence: { ...evidence, mutationId: `m-${index}` }, ...proofs[index], mayCreateMissingParents: index === 1,
      ...(version === 3 ? {} : { mutationDiff: mutation }),
    })) }
    store.putInFlight("s", "file.mutation", "op", cell)
    const next = (await reader.readInFlight("s", "file.mutation"))[0]!
    expect(encodeProjectStateResponse({ id: 1, result: { kind: "in-flight", records: [next] } }).byteLength).toBeLessThan(65_536)
    const header = parseFileMutationOperationHeader(next.payload)
    const parsed = await readFileMutationOperation(header, hash => reader.readSessionContentNode!("s", hash))
    expect(parsed).toMatchObject({ version: 3, operationId: "op", cursor: 1, items: [
      { evidence: { mutationId: "m-0" }, ...(version === 3 ? {} : { candidateEvidence: { mutationId: "m-0" } }) },
      { evidence: { mutationId: "m-1" }, ...(version === 3 ? {} : { candidateEvidence: { mutationId: "m-1" } }) },
    ] })
    expect<unknown>(parsed.items.map(item => item.evidence)).toEqual(cell.items.map(item => item.evidence))
    expect<unknown>(parsed.items.map(({ precondition, postcondition }) => ({ precondition, postcondition }))).toEqual(proofs)
    expect(parsed.items.map(item => item.mayCreateMissingParents)).toEqual([false, true])
    expect(header.plan.entries).toBe(2)
    expect(next.payload).not.toHaveProperty("items")
    expect(JSON.stringify(next)).not.toContain("unifiedDiff")
    expect(store.readInFlight("s", "file.mutation")[0]?.raw).toBe(next.raw)
  })

  test.each(["before-stage", "before-swap", "after-swap"] as const)("recovers a conversion interrupted %s without losing the original plan", async point => {
    const { store, reader } = fixture()
    const cell = { version: 1, operationId: "op", cursor: 1, items: [0, 1].map(index => ({
      evidence: { ...changed, mutationId: `m-${index}` }, precondition: null, postcondition: null,
      mayCreateMissingParents: false, mutationDiff: mutation,
    })) }
    store.putInFlight("s", "file.mutation", "op", cell)
    const oldRaw = store.readInFlight("s", "file.mutation")[0]!.raw
    const writer = asAsyncEventWriter(store)
    const interrupted = createMutationEvidenceRecovery(asAsyncEventReadSurface(store), {
      ...writer,
      async stageSessionContentNodes(...args) {
        if (point === "before-stage") throw new Error("crash")
        await writer.stageSessionContentNodes!(...args)
      },
      async swapInFlight(...args) {
        if (point === "before-swap") throw new Error("crash")
        await writer.swapInFlight!(...args)
        throw new Error("crash")
      },
    })
    await expect(interrupted.reader.readInFlight("s", "file.mutation")).rejects.toThrow("crash")
    if (point === "after-swap") expect(store.readInFlight("s", "file.mutation")[0]!.raw).not.toBe(oldRaw)
    else expect(store.readInFlight("s", "file.mutation")[0]!.raw).toBe(oldRaw)
    const recovered = (await reader.readInFlight("s", "file.mutation"))[0]!
    const header = parseFileMutationOperationHeader(recovered.payload)
    const plan = await readFileMutationOperation(header, hash => reader.readSessionContentNode!("s", hash))
    expect(plan.cursor).toBe(1)
    expect<unknown>(plan.items.map(item => item.evidence)).toEqual(cell.items.map(item => item.evidence))
    expect(plan.items.every(item => item.candidateEvidence?.patch.kind === "retained")).toBe(true)
    expect(await reader.readInFlight("s", "file.mutation")).toEqual([recovered])
  })

  test("keeps unknown and malformed bytes local, exposes bounded gaps, and leaves other sessions writable", async () => {
    const { store, reader, recovery } = fixture()
    const old = { ...checkpoint, details: { mutation: { wrong: "x".repeat(80_000) } } }
    store.putInFlight("s", "finalized-tool-result", "c:tool", old)
    const raw = store.readInFlight("s", "finalized-tool-result")[0]!.raw
    const rows = await reader.readInFlight("s", "finalized-tool-result")
    expect(rows[0]).toMatchObject({ raw: "", payload: { kind: "degraded" } })
    expect(Buffer.byteLength(JSON.stringify(rows))).toBeLessThan(1024)
    expect(encodeProjectStateResponse({ id: 1, result: { kind: "in-flight", records: rows } }).byteLength).toBeLessThan(1024)
    expect(store.readInFlight("s", "finalized-tool-result")[0]!.raw).toBe(raw)
    const invalid = store.append(row(1, "tool.result.recorded", old))
    const gap = await recovery.normalizeFact(invalid)
    expect(gap).toBeInstanceOf(CorruptEventRowError)
    expect(Buffer.byteLength(JSON.stringify(gap))).toBeLessThan(2048)
    const unknown = await recovery.normalizeFact({ ...invalid, version: 100 })
    expect(unknown).toBeInstanceOf(CorruptEventRowError)
    store.append({ ...row(2, "test.fact", { valid: true }), aggregateId: "session:other", sessionId: "other" })
    expect((await reader.readSlice({ sessionId: "other" })).facts).toHaveLength(1)
  })

  test("construction and selected current views perform no staging, content fetches or cell swaps", async () => {
    const { recovery, counts } = fixture()
    expect(counts()).toEqual({ stages: 0, swaps: 0 })
    const current = row(1, "tool.result.recorded", { toolUseId: "t", outcome: "ok" }, 3)
    expect(await recovery.normalizeFact(current)).toBe(current)
    expect(counts()).toEqual({ stages: 0, swaps: 0 })
  })
})
