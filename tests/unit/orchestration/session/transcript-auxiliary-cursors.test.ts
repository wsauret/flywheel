import { describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, CorruptEventRowError, type EventStore } from "../../../../src/infra/event-store-types"
import { transcriptFixture, transcriptStores } from "./_transcript-projection-fixtures"
import {
  createToolResultDisplayMetaCursorReader,
  createToolResultDisplayMetaSetReader,
  readToolResultDisplayMeta,
} from "../../../../src/orchestration/session/conversation/tool-result-meta"
import { createMutationEvidenceRecovery } from "../../../../src/orchestration/session/mutation-evidence-recovery.js"
import { readMutationEvidenceFiles } from "../../../../src/infra/mutation-evidence.js"
import { readPatchContent } from "../../../../src/orchestration/session/session-change-sources.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"

function recoveredReader() {
  return createMutationEvidenceRecovery(asAsyncEventReadSurface(store), asAsyncEventWriter(store)).reader
}

let baseDir: string
let store: EventStore
const { appendSessionFact } = transcriptFixture(() => store, () => baseDir)
transcriptStores((nextStore, directory) => {
  store = nextStore
  baseDir = directory
})

describe("transcript auxiliary cursor readers", () => {
  it("isolates corrupt tool-source rows to the selected session", async () => {
    const sources = createToolResultDisplayMetaSetReader(asAsyncEventReadSurface(store))
    appendSessionFact("healthy", {
      type: "tool.execution_output.recorded", version: 1, actor: "flywheel",
      payload: { toolUseId: "tool", output: "kept" },
    })
    await sources.replay(["healthy"])
    appendSessionFact("damaged", { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: {} })
    const db = new Database(resolveEventStoreDbFile(baseDir))
    try {
      db.run("update event set payload = '{' where aggregate_id = ?", ["session:damaged"])
    } finally { db.close() }
    expect((await sources.replay(["healthy"])).get("healthy")?.sources.size).toBe(1)
    await expect(sources.replay(["damaged"])).rejects.toBeInstanceOf(CorruptEventRowError)
    expect((await sources.replay(["healthy"])).get("healthy")?.sources.size).toBe(1)
  })

  it.each([2, 20])("shares one advancing source cursor across changing subsets of %i children", async (children) => {
    const counter = countStateRequests(asAsyncEventReadSurface(store))
    const sources = createToolResultDisplayMetaSetReader(counter.reader)
    const ids = Array.from({ length: children }, (_, index) => `child-${index}`)
    for (const id of ids) {
      for (let index = 0; index < children; index++) appendSessionFact(id, {
        type: "tool.execution_output.recorded", version: 1, actor: "flywheel",
        payload: { toolUseId: `tool-${index}`, output: "output" },
      })
      await sources.replay([id])
    }
    counter.take()
    appendSessionFact(ids[0]!, {
      type: "tool.execution_output.recorded", version: 1, actor: "flywheel",
      payload: { toolUseId: "latest", output: "new output" },
    })
    const caughtUp = await sources.replay(ids)
    expect(caughtUp.get(ids[0]!)?.sources.size).toBe(children + 1)
    const requests = counter.take()
    expect(factsRead(requests)).toBe(1)
    expect(requests.length).toBeLessThanOrEqual(1)
    await createToolResultDisplayMetaSetReader(counter.reader).replay(ids.slice(1))
    expect(factsRead(counter.take())).toBe(0)
  })

  it.each([2, 20])("seeds a named session from its own facts only, beside %i unrelated sessions", async (others) => {
    const toolFact = (toolUseId: string) => ({ type: "tool.execution_output.recorded", version: 1, actor: "flywheel" as const, payload: { toolUseId, output: "output" } })
    for (let session = 0; session < others; session++) {
      for (let index = 0; index < 5; index++) appendSessionFact(`unrelated-${session}`, toolFact(`tool-${index}`))
    }
    for (let index = 0; index < 3; index++) appendSessionFact("named", toolFact(`tool-${index}`))
    const counter = countStateRequests(asAsyncEventReadSurface(store))
    const sources = createToolResultDisplayMetaSetReader(counter.reader)
    expect((await sources.replay(["named"])).get("named")?.sources.size).toBe(3)
    expect(factsRead(counter.take())).toBe(3)
    for (let session = 0; session < others; session++) appendSessionFact(`unrelated-${session}`, toolFact("later"))
    appendSessionFact("named", toolFact("later"))
    expect((await sources.replay(["named"])).get("named")?.sources.size).toBe(4)
    // The cursor reads each new tool fact once; no unrelated session is indexed or seeded.
    expect(factsRead(counter.take())).toBe(others + 1)
  })

  it("retains per-source positions and resolves only selected metadata", async () => {
    const sessionId = "tool-meta-session"
    const cursor = createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(store), sessionId)
    const empty = await cursor.replay()
    expect(empty.position).toBe(0)
    appendSessionFact(sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "ignored", outcome: "error", details: { diff: "unused" } },
    })
    const first = await cursor.replay()
    const position = first.sources.get("ignored")?.position
    if (position === undefined) throw new Error("Missing ignored source position")
    expect(first.position).toBe(position)
    expect(empty.position).toBe(0)
    expect(position).toBeGreaterThan(0)
    expect((await cursor.replay()).sources.get("ignored")?.position).toBe(position)
    expect(await (await cursor.replay()).readMeta((await cursor.replay()).sources.get("ignored"))).toBeUndefined()

    appendSessionFact(sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "tool-1", outcome: "ok", details: { diff: "-a\n+b", filetype: "text", resultAction: "updated" } },
    })
    appendSessionFact(sessionId, {
      type: "tool.execution_output.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "tool-1", output: "output" },
    })
    const caughtUp = await cursor.replay()
    const toolPosition = caughtUp.sources.get("tool-1")?.position
    if (toolPosition === undefined) throw new Error("Missing tool source position")

    expect(toolPosition).toBeGreaterThan(position)
    expect(caughtUp.position).toBe(toolPosition)
    expect(first.position).toBe(position)
    expect((await cursor.replay()).position).toBe(caughtUp.position)
    expect(await caughtUp.readMeta(caughtUp.sources.get("tool-1"))).toMatchObject({ diff: "-a\n+b", filetype: "text", resultAction: "updated", executionOutput: "output" })
    expect(await caughtUp.readMeta(caughtUp.sources.get("tool-1"))).toEqual((await readToolResultDisplayMeta(asAsyncEventReadSurface(store), sessionId)).get("tool-1"))
    expect((await cursor.replay()).sources.get("tool-1")?.position).toBe(caughtUp.sources.get("tool-1")?.position)
  })

  it("ignores retired Code result details while preserving ordinary execution output", async () => {
    const sessionId = "code-meta-session"
    appendSessionFact(sessionId, {
      type: "tool.execution_output.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "code-1", output: "ordinary output" },
    })
    appendSessionFact(sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "code-1",
        outcome: "ok",
        details: { containerKind: "code", source: "retired", result: { ok: true } },
      },
    })

    expect((await readToolResultDisplayMeta(asAsyncEventReadSurface(store), sessionId)).get("code-1")).toEqual({ executionOutput: "ordinary output" })
  })

  it("uses canonical mutation metadata when a durable fact also has legacy diffs", async () => {
    const sessionId = "dual-tool-meta-session"
    const mutation = { version: 1 as const, files: [], omissions: [{ path: ".env", reason: "sensitive" as const }] }
    appendSessionFact(sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "legacy-edit",
        outcome: "ok",
        details: {
          files: [{ path: ".env", diff: "-TOKEN=old\n+TOKEN=new", filetype: "text" }],
          mutation,
        },
      },
    })

    const reader = recoveredReader()
    const meta = (await readToolResultDisplayMeta(reader, sessionId)).get("legacy-edit")
    expect(meta).toEqual({ mutationEvidence: expect.objectContaining({ omissions: 1, retainedFiles: 0 }) })
    const files = await readMutationEvidenceFiles(meta!.mutationEvidence!, 0, 10, hash => reader.readSessionContentNode!(sessionId, hash))
    expect(files.kind === "available" ? files.files : []).toEqual([{ kind: "omitted", path: ".env", displayPath: ".env", reason: "sensitive" }])
  })

  it("keeps the edits a failed shell command landed, and nothing for a failed edit that published none", async () => {
    const sessionId = "failed-edits-tool-meta-session"
    const mutation = { version: 1 as const, files: [{ path: "a.ts", change: "modified" as const, unifiedDiff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n" }], omissions: [] }
    const notApplied = [{ path: "c.ts", reason: "the command deleted it" }]
    appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "timed-out-bash", outcome: "error", details: { background: false, exitCode: 124, durationMs: 5, mutation, conflictMarkers: ["a.ts"], notApplied } } })
    appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "failed-edit", outcome: "error", details: { diff: "-a\n+b", filetype: "text" } } })

    const reader = recoveredReader()
    const meta = await readToolResultDisplayMeta(reader, sessionId)

    const evidence = meta.get("timed-out-bash")?.mutationEvidence
    expect(meta.get("timed-out-bash")).toEqual({ mutationEvidence: expect.objectContaining({ applied: 1, retainedFiles: 1, notApplied: 1, conflictMarkers: 1 }) })
    if (!evidence) throw new Error("Missing evidence")
    const files = await readMutationEvidenceFiles(evidence, 0, 10, hash => reader.readSessionContentNode!(sessionId, hash))
    if (files.kind !== "available") throw new Error("Missing files")
    const first = files.files[0]
    if (first?.kind !== "display" || first.file.patch.kind !== "retained") throw new Error("Missing display patch")
    expect(first.file.conflictMarkers).toBe(true)
    expect(await readPatchContent(reader, sessionId, first.file.patch.reference)).toBe(mutation.files[0]!.unifiedDiff)
    expect(files.files[1]).toEqual({ kind: "not_applied", ...notApplied[0]! })
    expect(meta.get("failed-edit")).toBeUndefined()
  })

  it("reads the legacy conflicts of an earlier edits command, from its result and from its settled record, as files it did not apply", async () => {
    // Before conflict markers, `conflicts` named the files a mutating command refused to publish.
    const sessionId = "legacy-conflicts-tool-meta-session"
    appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "foreground-bash", outcome: "ok", details: { background: false, exitCode: 0, durationMs: 5, conflicts: ["b.ts"] } } })
    appendSessionFact(sessionId, { type: "tool.execution_output.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "background-bash", output: "", conflicts: ["b.ts"] } })

    const meta = await readToolResultDisplayMeta(recoveredReader(), sessionId)

    const notApplied = [{ path: "b.ts", reason: "project changed while the command ran" }]
    expect(meta.get("foreground-bash")).toEqual({ exitCode: 0, mutationEvidence: expect.objectContaining({ notApplied: 1, samples: notApplied.map(file => ({ kind: "not_applied", ...file })) }) })
    expect(meta.get("background-bash")).toEqual({ executionOutput: "", mutationEvidence: expect.objectContaining({ notApplied: 1, samples: notApplied.map(file => ({ kind: "not_applied", ...file })) }) })
  })

  it("marks a malformed historical artifact as a degraded fact instead of publishing decoration", async () => {
    const sessionId = "malformed-tool-meta-session"
    appendSessionFact(sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "broken-memory",
        outcome: "ok",
        details: { mutation: { version: 2, files: [], omissions: [] } },
      },
    })

    const reader = recoveredReader()
    const slice = await reader.readSlice({ sessionId, types: ["tool.result.recorded"] }, true)
    expect(slice.facts).toHaveLength(1)
    expect(slice.facts[0]).toBeInstanceOf(CorruptEventRowError)
    await expect(readToolResultDisplayMeta(reader, sessionId)).rejects.toThrow("Mutation evidence is unavailable")
  })

  it("keeps a durable fact that publishes no artifact, and every legacy omission variant", async () => {
    const sessionId = "legacy-tool-meta-session"
    appendSessionFact(sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "no-artifact", outcome: "ok", details: { diff: "-a\n+b", filetype: "text" } },
    })
    const legacy = { version: 1 as const, files: [], omissions: [{ path: "USER.md", reason: "private_reach" as const }] }
    appendSessionFact(sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "legacy-omission", outcome: "ok", details: { mutation: legacy } },
    })

    const reader = recoveredReader()
    const meta = await readToolResultDisplayMeta(reader, sessionId)

    expect(meta.get("no-artifact")?.mutationEvidence).toBeUndefined()
    const evidence = meta.get("legacy-omission")?.mutationEvidence
    if (!evidence) throw new Error("Missing omission evidence")
    const files = await readMutationEvidenceFiles(evidence, 0, 10, hash => reader.readSessionContentNode!(sessionId, hash))
    expect(files.kind === "available" ? files.files : []).toEqual([{ kind: "omitted", path: "USER.md", displayPath: "USER.md", reason: "private_reach" }])
  })

  it("omits an undecodable tool-result decoration and advances its cursor", async () => {
    const sessionId = "undecodable-tool-meta-session"
    let reads = 0
    const reader = {
      ...store,
      read: (...args: Parameters<EventStore["read"]>) => {
        if (args[0]?.positions === undefined) reads += 1
        return store.read(...args)
      },
      readTolerant: (...args: Parameters<EventStore["readTolerant"]>) => {
        if (args[0]?.positions === undefined) reads += 1
        return store.readTolerant(...args)
      },
    }
    appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: {} })
    appendSessionFact(sessionId, { type: "tool.execution_output.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "readable", output: "kept" } })
    const cursor = createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(reader), sessionId)

    const first = await cursor.replay()
    const second = await cursor.replay()

    expect(await first.readMeta(first.sources.get("readable"))).toEqual({ executionOutput: "kept" })
    expect(await second.readMeta(second.sources.get("readable"))).toEqual((await readToolResultDisplayMeta(asAsyncEventReadSurface(store), sessionId)).get("readable"))
    expect(reads).toBe(1)
    expect(second.sources.size).toBe(1)
    appendSessionFact(sessionId, { type: "tool.execution_output.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "readable", output: "updated" } })
    const advanced = await cursor.replay()
    expect(await advanced.readMeta(advanced.sources.get("readable"))).toEqual({ executionOutput: "updated" })
    expect(reads).toBe(2)
  })

  it("reads a group child again after a failed source read", async () => {
    const sessionId = "group-child-session"
    appendSessionFact(sessionId, {
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId: "child-1", toolName: "read", input: { path: "file" }, parentToolUseId: "parent",
        inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      },
    })
    const surface = asAsyncEventReadSurface(store)
    let failures = 1
    const failOnce = <T>(read: () => Promise<T>): Promise<T> => failures-- > 0 ? Promise.reject(new Error("state read refused")) : read()
    const reader = {
      ...surface,
      readSlice: (...args: Parameters<typeof surface.readSlice>) => args[0].positions ? failOnce(() => surface.readSlice(...args)) : surface.readSlice(...args),
      readPage: (...args: Parameters<typeof surface.readPage>) => args[0].positions ? failOnce(() => surface.readPage(...args)) : surface.readPage(...args),
    }
    const context = { executionCwd: baseDir, idSuffix: "", presentation: "container" as const }
    const children = (await createToolResultDisplayMetaCursorReader(reader, sessionId).replay()).children("parent", context)

    expect(Promise.resolve(children.readBlock(0))).rejects.toThrow("state read refused")
    expect(await children.readBlock(0)).toEqual(await (await createToolResultDisplayMetaCursorReader(surface, sessionId).replay()).children("parent", context).readBlock(0))
  })
})
