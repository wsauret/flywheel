import { expect, test } from "bun:test"
import { chmodSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { asAsyncEventReadSurface } from "../../../../src/infra/event-store-types.js"
import { publishFileEdits } from "../../../../src/orchestration/file-edits/file-edit-operation.js"
import { RetainedFileEditAuthority } from "../../../../src/orchestration/file-edits/retained-file-edit-host.js"
import { reconstructOriginal } from "../../../../src/orchestration/file-edits/session-file-restoration.js"
import { getSessionChangeReview } from "../../../../src/orchestration/session/session-change-review.js"
import { readChangeFact, readPatchContent } from "../../../../src/orchestration/session/session-change-sources.js"
import { withStore } from "../session/file-mutation-recovery-fixture.js"

type Fixture = Parameters<Parameters<typeof withStore>[0]>[0]
async function change(fixture: Fixture, path: string, after: string | undefined) {
  const outcome = await publishFileEdits({ executionCwd: fixture.root, sessionEventWriter: fixture.writer, origin: { kind: "user_undo", reviewRevision: 0, fileId: "fixture", sourceMutationIds: [] } }, { paths: [path], admit: RetainedFileEditAuthority.admitWritable, plan: admitted => [{ admitted: admitted[0]!, after }] })
  expect(outcome.status).toBe("completed")
}
async function reconstruct(fixture: Fixture, path: string) {
  const review = await getSessionChangeReview(asAsyncEventReadSurface(fixture.store), fixture.sessionId)
  const file = review.file(`file:${fixture.store.read({ sessionId: fixture.sessionId, types: ["file.changed"] }).find(fact => fact.payload.path === path)!.id}`)!
  const authority = RetainedFileEditAuthority.admitWritable(path)
  try { return await reconstructOriginal(asAsyncEventReadSurface(fixture.store), review, file, authority) } finally { authority.close() }
}

test.each([
  ["created", undefined, ["created\n"]],
  ["modified", "before\n", ["after\n"]],
  ["deleted", "deleted\n", [undefined]],
  ["created empty", undefined, [""]],
  ["deleted empty", "", [undefined]],
  ["BOM CRLF", "\ufeffa\r\nb\r\n", ["\ufeffa\r\nc\r\n"]],
  ["chain", "old\n", ["new\n", "newer\n", undefined, "back\n"]],
  ["restored chain", "same\n", ["other\n", "same\n"]],
  ["long Unicode line across byte windows", "€".repeat(24_000), ["é".repeat(40_000), "界".repeat(24_000)]],
] as const)("reconstructs the pre-session %s file exactly", async (_name, before, steps) => {
  await withStore(async fixture => {
    const path = join(fixture.root, "text")
    if (before !== undefined) writeFileSync(path, before)
    for (const step of steps) await change(fixture, path, step)
    const result = await reconstruct(fixture, path)
    expect(result).toMatchObject({ kind: "ready", original: before })
    if (result.kind !== "ready") throw new Error("unreachable")
    expect(result.sourceMutationIds).toHaveLength(steps.length)
    expect(before === undefined ? result.originalAccess === null : result.originalAccess?.kind === (process.platform === "win32" ? "win32" : "posix")).toBe(true)
  })
})

test.each(["bytes", "encoding", "access"] as const)("current %s drift is drifted, not unretained", async drift => {
  if (drift === "access" && process.platform === "win32") return
  await withStore(async fixture => {
    const path = join(fixture.root, "text")
    writeFileSync(path, "old\n", { mode: 0o600 })
    await change(fixture, path, "new\n")
    if (drift === "bytes") writeFileSync(path, "external\n")
    else if (drift === "encoding") writeFileSync(path, Buffer.from([0xff, 0xfe, 0x00]))
    else chmodSync(path, 0o644)
    expect(await reconstruct(fixture, path)).toEqual({ kind: "unavailable", reason: "drifted" })
  })
})

test.each(["partial", "omitted", "incorrect", "missing", "malformed"] as const)("%s retained evidence is unretained even when the net endpoint is a no-op", async kind => {
  await withStore(async fixture => {
    const path = join(fixture.root, "a")
    writeFileSync(path, "old\n")
    await change(fixture, path, "new\n")
    await change(fixture, path, "old\n")
    const artifact = fixture.store.read({ sessionId: fixture.sessionId, types: ["file.artifact.recorded"] })[0]!
    const fact = readChangeFact(artifact)
    if (fact.type !== "file.artifact.recorded" || fact.version !== 4 || fact.payload.evidence.patch.kind !== "retained") throw new Error("Missing runtime diff")
    const patch = await readPatchContent(asAsyncEventReadSurface(fixture.store), fixture.sessionId, fact.payload.evidence.patch.reference)
    if (patch === undefined) throw new Error("Missing patch bytes")
    const target = { path, change: "modified" as const, unifiedDiff: patch }
    const mutation = kind === "omitted" ? { version: 1 as const, files: [], omissions: [{ path, reason: "sensitive" as const }] }
      : kind === "missing" ? { version: 1 as const, files: [], omissions: [] }
      // A hunk header that promises lines its body does not carry passes the schema but makes the diff parser throw.
      : kind === "malformed" ? { version: 1 as const, files: [{ ...target, unifiedDiff: "--- a\n+++ b\n@@ -1 +1 @@\n" }], omissions: [] }
      : { version: 1 as const, files: [{ ...target, ...(kind === "partial" ? { omittedLines: 1 } : { unifiedDiff: target.unifiedDiff.replace("\n-old", "\n-bad") }) }], omissions: [] }
    const { evidence: _evidence, ...payload } = fact.payload
    await fixture.writer.record({ ...fact, version: 3, payload: { ...payload, ownerKind: "runtime", mutation } })
    expect(await reconstruct(fixture, path)).toEqual({ kind: "unavailable", reason: "unretained" })
  })
})

test.each(["missing", "corrupt", "truncated", "offset", "continuation", "hash", "partial", "sensitive", "unavailable"] as const)("%s reference evidence refuses reconstruction without hiding history", async kind => {
  await withStore(async fixture => {
    const path = join(fixture.root, "text")
    writeFileSync(path, "old\n")
    await change(fixture, path, "new\n")
    const reader = asAsyncEventReadSurface(fixture.store)
    const artifact = readChangeFact(fixture.store.read({ sessionId: fixture.sessionId, types: ["file.artifact.recorded"] })[0]!)
    if (artifact.type !== "file.artifact.recorded" || artifact.version !== 4) throw new Error("Missing descriptor")
    if (kind === "partial" || kind === "sensitive" || kind === "unavailable") {
      const evidence = artifact.payload.evidence
      if (evidence.patch.kind !== "retained") throw new Error("Missing retained patch")
      await fixture.writer.record({ ...artifact, payload: { ...artifact.payload, evidence: {
        ...evidence, ...(kind === "partial" ? { omittedLines: 1 } : { patch: kind === "sensitive" ? { kind: "omitted", reason: "sensitive" } : { kind: "unavailable" } }),
      } } })
    } else {
      const read = reader.readSessionContentRange!.bind(reader)
      reader.readSessionContentRange = async (...args) => {
        if (kind === "missing" || kind === "corrupt") return { kind: "unavailable", reason: kind }
        const range = await read(...args)
        if (range.kind !== "available") return range
        if (kind === "offset") return { ...range, offset: range.offset + 1 }
        if (kind === "continuation") return { ...range, nextOffset: 1 }
        if (kind === "hash") {
          const bytes = Buffer.from(range.base64, "base64")
          bytes[0] = 0x21
          return { ...range, base64: bytes.toString("base64") }
        }
        return { ...range, base64: Buffer.from(range.base64, "base64").subarray(1).toString("base64") }
      }
    }
    expect(await reconstruct(fixture, path)).toEqual({ kind: "unavailable", reason: "unretained" })
    const review = await getSessionChangeReview(reader, fixture.sessionId)
    expect(review.netFiles()).toHaveLength(1)
    expect(review.unknownFileMutationGaps()).toBe(0)
  })
})

test("a complete hash does not make invalid UTF-8 patch bytes usable", async () => {
  await withStore(async fixture => {
    const bytes = Buffer.from([0xff])
    const reader = asAsyncEventReadSurface(fixture.store)
    reader.readSessionContentRange = async () => ({ kind: "available", offset: 0, base64: bytes.toString("base64"), nextOffset: null })
    expect(await readPatchContent(reader, fixture.sessionId, {
      version: 1, root: "0".repeat(64), bytes: 1,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    })).toBeUndefined()
  })
})

test("a change recorded without access evidence is unretained", async () => {
  await withStore(async fixture => {
    const path = join(fixture.root, "a")
    await change(fixture, path, "new\n")
    const [fact] = fixture.store.read({ sessionId: fixture.sessionId, types: ["file.changed"] })
    const { beforeAccess: _b, afterAccess: _a, ...legacy } = fact!.payload
    fixture.store.append({ sessionId: fixture.sessionId, aggregateId: fact!.aggregateId, type: "file.changed", version: 3, actor: "flywheel", timestamp: Date.now(), payload: { ...legacy, mutationId: "legacy", path: join(fixture.root, "b"), before: null, after: legacy.after } })
    writeFileSync(join(fixture.root, "b"), "new\n")
    expect(await reconstruct(fixture, join(fixture.root, "b"))).toEqual({ kind: "unavailable", reason: "unretained" })
    expect(await reconstruct(fixture, path)).toMatchObject({ kind: "ready", original: undefined })
  })
})
