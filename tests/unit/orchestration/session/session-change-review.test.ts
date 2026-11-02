import { expect, test } from "bun:test"
import type { MutationDiff } from "../../../../src/infra/mutation-diff.js"
import { getSessionChangeReview } from "../../../../src/orchestration/session/session-change-review.js"
import { getSessionFileChanges } from "../../../../src/orchestration/session/session-file-changes.js"
import { edit, entries, fixture, human, row } from "./_session-change-fixtures.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, CorruptEventRowError, type FactQuery } from "../../../../src/infra/event-store-types.js"
import { buildMutationFileEvidence } from "../../../../src/infra/mutation-evidence.js"
import { readSessionContentRange } from "../../../../src/infra/session-content.js"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { buildMutationDiff } from "../../../../src/infra/mutation-diff.js"
import { createMutationEvidenceRecovery } from "../../../../src/orchestration/session/mutation-evidence-recovery.js"
import { reconstructOriginal } from "../../../../src/orchestration/file-edits/session-file-restoration.js"
import { RetainedFileEditAuthority } from "../../../../src/orchestration/file-edits/retained-file-edit-host.js"
import { fileAccessProof } from "../../../../src/orchestration/session/file-mutation-access.js"
import { extractContent } from "../../../../src/infra/tool-content.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

const directory = temporaryDirectories()

for (const type of ["tool.result.recorded", "tool.execution_output.recorded"]) {
  for (const version of [1, 2]) {
    test.each(["retained", "ambiguous", "omitted", "unavailable"])(`canonical ${type} v${version} preserves exact historical Undo only for %s evidence`, async kind => {
      const root = directory("historical-review-")
      const path = join(root, "a.txt")
      writeFileSync(path, "new\n")
      const authority = RetainedFileEditAuthority.admitWritable(path)
      const store = createSqliteEventStore(join(root, "facts.sqlite"))
      try {
        const endpoint = (text: string) => ({ bytes: Buffer.byteLength(text), sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex"), preview: text })
        const access = fileAccessProof(authority.existingSnapshot().metadata)
        store.append({ ...row(1, "file.changed", {
          mutationId: "historical", operationId: "operation", origin: { kind: "tool_call", toolUseId: "tool" },
          path: authority.canonicalPath, displayPath: "a.txt", changeKind: "modified",
          before: endpoint("old\n"), after: endpoint("new\n"), beforeAccess: access, afterAccess: access,
        }, 4) })
        const retained = buildMutationDiff([{ path: authority.canonicalPath, before: { kind: "text", text: "old\n" }, after: { kind: "text", text: "new\n" } }])
        const mutation: MutationDiff = { ...retained,
          files: kind === "omitted" ? [] : retained.files,
          omissions: kind === "ambiguous" || kind === "omitted" ? [{ path: authority.canonicalPath, reason: "sensitive" }] : [],
        }
        const content = extractContent("output".repeat(1000))
        if (content.kind !== "reference") throw new Error("Expected content reference")
        const original = store.append({ ...row(2, type, type === "tool.result.recorded"
          ? { toolUseId: "tool", outcome: "ok", details: { mutation }, ...(version === 2 ? { content: content.reference, parentToolUseId: "parent" } : {}) }
          : { toolUseId: "tool", output: version === 2 ? content.reference : "output", mutation }, version),
          ...(version === 2 ? { contentRows: [content.row] } : {}),
        })
        const raw = asAsyncEventReadSurface(store)
        const reader = createMutationEvidenceRecovery(raw, asAsyncEventWriter(store)).reader
        const review = await getSessionChangeReview(reader, "s")
        if (kind === "unavailable") reader.readSessionContentNode = async () => null
        const file = review.netFiles()[0]!
        const reconstructed = await reconstructOriginal(reader, review, file, authority)
        if (kind === "retained") {
          expect(await review.patchFor(file.changes[0]!)).toBe(mutation.files[0]!.unifiedDiff)
          expect(reconstructed).toMatchObject({ kind: "ready", original: "old\n" })
        } else {
          expect(await review.patchFor(file.changes[0]!)).toBeUndefined()
          expect(reconstructed.kind).toBe("unavailable")
        }
        expect(store.read({ types: [type] })).toEqual([original])
      } finally { authority.close(); store.close() }
    })
  }
}

function diff(paths: readonly string[], extra: Partial<MutationDiff> = {}): MutationDiff {
  return { version: 1, files: paths.map(path => ({ path, change: "modified", unifiedDiff: `PATCH ${path}` })), omissions: [], ...extra }
}
function tool(position: number, toolUseId: string, mutation?: MutationDiff | { broken: true }) {
  return row(position, "tool.result.recorded", { toolUseId, outcome: "ok", ...(mutation ? { details: { mutation } } : {}) })
}
function artifact(position: number, mutationId: string, mutation: MutationDiff) {
  return row(position, "file.artifact.recorded", { mutationId, artifactId: `art-${position}`, ownerKind: "runtime", ownerId: `op-${position}`, artifactKind: "mutation_diff", path: "/root/a", mutation }, 3)
}

test("settled per-file evidence survives a missing final result and reads only that file", async () => {
  const nodes = new Map<string, unknown>()
  const evidence = await buildMutationFileEvidence({
    mutationId: "m-1", path: "/root/a", before: { kind: "text", text: "before\n" },
    after: { kind: "text", text: "after\n" },
  }, async rows => { for (const node of rows) nodes.set(node.sha256, node.node) })
  if (!evidence) throw new Error("Expected changed file evidence")
  const data = fixture([edit(1, "/root/a", "x", "y"), row(2, "file.artifact.recorded", {
    mutationId: "m-1", artifactId: "art-2", ownerKind: "tool_call", ownerId: "tool-1",
    artifactKind: "mutation_diff", path: "/root/a", evidence,
  }, 4)])
  let ranges = 0
  data.projectionReader.readSessionContentRange = async (_session, reference, offset, length) => {
    ranges++
    return readSessionContentRange(reference, offset, length, async hash => nodes.get(hash) ?? null)
  }
  const review = await getSessionChangeReview(data.projectionReader, "s")
  expect(ranges).toBe(0)
  const change = review.file("file:fact-1")!.changes[0]!
  data.queries.length = 0
  expect(await review.patchSourceFor(change)).toEqual({ kind: "evidence" as const, evidence })
  expect(ranges).toBe(0)
  expect(data.queries).toEqual([{ sessionId: "s", positions: [2], types: ["file.artifact.recorded"] }])
  expect(await review.patchFor(change)).toContain("-before\n+after")
  expect(ranges).toBe(1)
  nodes.clear()
  expect(await review.patchFor(change)).toBeUndefined()
  expect(review.netFiles()).toHaveLength(1)
})

test("a malformed per-file settlement cannot fall back to an older tool summary", async () => {
  const data = fixture([edit(1, "/root/a", "x", "y"), tool(2, "tool-1", diff(["/root/a"])),
    row(3, "file.artifact.recorded", { mutationId: "m-1", artifactKind: "mutation_diff", evidence: { broken: true } }, 4)])
  const review = await getSessionChangeReview(data.projectionReader, "s")
  expect(await review.patchFor(review.file("file:fact-1")!.changes[0]!)).toBeUndefined()
  expect(review.netFiles()).toHaveLength(1)
  expect(review.unknownFileMutationGaps()).toBe(0)
})

test("exposes net files and revision as the count's lane does, and reads only the catalog and lineage types", async () => {
  const data = fixture([edit(1, "/root/a", "x", "y"), tool(2, "tool-1", diff(["/root/a"])), entries(3, [human("h")]), edit(4, "/root/b", null, "b"), edit(5, "/root/b", "b", null)])
  const review = await getSessionChangeReview(data.projectionReader, "s")
  expect(review.netFiles().map(file => file.path)).toEqual(["/root/a"])
  expect(review.unknownFileMutationGaps()).toBe(0)
  expect(review.revision()).toBe(3)
  expect(review.file("file:fact-1")?.path).toBe("/root/a")
  expect(review.file("file:fact-4")?.changes).toHaveLength(2)
  expect(review.netChange(review.file("file:fact-4")!)).toBeUndefined()
  const lineage = ["session.created", "session.child.linked", "session.label.updated"]
  expect(data.queries.every(query => JSON.stringify(query.types) === JSON.stringify(lineage) || query.types?.every(type => ["file.changed", "file.reviewed", "tool.result.recorded", "tool.execution_output.recorded", "file.artifact.recorded"].includes(type)))).toBe(true)
  expect((await getSessionFileChanges(data.projectionReader, "s")).netFiles()).toEqual(review.netFiles())
  data.queries.length = 0
  const readPage = data.projectionReader.readPage.bind(data.projectionReader)
  let appended = false
  data.projectionReader.readPage = async (...args) => {
    if (!appended) {
      appended = true
      data.rows.push(edit(7, "/root/d", null, "d"))
    }
    return readPage(...args)
  }
  data.rows.push(edit(6, "/root/c", null, "c"))
  expect((await getSessionChangeReview(data.projectionReader, "s")).revision()).toBe(4)
  expect(review.netFiles().map(file => file.path)).toEqual(["/root/a", "/root/c"])
  expect((await getSessionChangeReview(data.projectionReader, "s")).revision()).toBe(5)
  expect(review.netFiles().map(file => file.path)).toEqual(["/root/a", "/root/c", "/root/d"])
})

test("patchFor prefers the runtime mutation_diff artifact and falls back to the tool diff", async () => {
  const data = fixture([
    edit(1, "/root/a", "x", "y"), artifact(2, "m-1", diff(["/root/a"], { files: [{ path: "/root/a", change: "modified", unifiedDiff: "RUNTIME" }] })), tool(3, "tool-1", diff(["/root/a"])),
    edit(4, "/root/b", "x", "y"), tool(5, "tool-4", diff(["/root/b", "/root/z"])),
    edit(6, "/root/c", "x", "y"),
  ])
  const review = await getSessionChangeReview(data.projectionReader, "s")
  const change = (fileId: string) => review.file(fileId)!.changes[0]!
  data.queries.length = 0
  expect(await review.patchFor(change("file:fact-1"))).toBe("RUNTIME")
  expect(data.queries).toEqual([
    { sessionId: "s", positions: [2], types: ["file.artifact.recorded"] },
    { sessionId: "s", types: ["file.changed"] },
  ])
  expect(await review.patchFor(change("file:fact-4"))).toBe("PATCH /root/b")
  expect(await review.patchFor(change("file:fact-6"))).toBeUndefined()
  expect(data.reader.toolContent.resolve).not.toHaveBeenCalled()
})

test.each([
  ["omitted", diff([], { omissions: [{ path: "/root/a", reason: "sensitive" }] })],
  ["truncated", diff([], { files: [{ path: "/root/a", change: "modified", unifiedDiff: "PART", omittedLines: 4 }] })],
  ["multi-target", diff(["/root/a", "/root/a"])],
  ["foreign path", diff(["/root/other"])],
] as const)("patchFor returns undefined for %s evidence", async (_name, mutation) => {
  const data = fixture([edit(1, "/root/a", "x", "y"), tool(2, "tool-1", mutation)])
  const review = await getSessionChangeReview(data.projectionReader, "s")
  expect(await review.patchFor(review.file("file:fact-1")!.changes[0]!)).toBeUndefined()
})

test("an undecodable tool diff leaves history known and the change unretained", async () => {
  const data = fixture([edit(1, "/root/a", "x", "y"), tool(2, "tool-1", { broken: true }), row(3, "file.artifact.recorded", { broken: true }, 3)])
  const review = await getSessionChangeReview(data.projectionReader, "s")
  expect(review.unknownFileMutationGaps()).toBe(0)
  expect(review.netFiles()).toHaveLength(1)
  expect(await review.patchFor(review.file("file:fact-1")!.changes[0]!)).toBeUndefined()
})

test("a corrupt file row is an unknown gap and a later readable row still folds", async () => {
  const data = fixture([row(1, "file.changed", { broken: true }, 4), edit(2, "/root/a", null, "a")])
  const review = await getSessionChangeReview(data.projectionReader, "s")
  expect(review.unknownFileMutationGaps()).toBe(1)
  expect(review.netFiles()).toHaveLength(1)
  expect(review.revision()).toBe(2)
})

test("malformed review payload degrades that file instead of preserving an older assertion", async () => {
  const data = fixture([
    edit(1, "/root/a", "x", "y"),
    row(2, "file.reviewed", { fileId: "file:fact-1", editToken: { position: 1, eventId: "fact-1" }, reviewed: true }),
    row(3, "file.reviewed", { fileId: "file:fact-1", reviewed: "yes" }),
  ])
  const review = await getSessionChangeReview(data.projectionReader, "s")
  expect(review.reviewStatus(review.file("file:fact-1")!)).toBe("unknown")
})

test("a corrupt review envelope with no recoverable file identity degrades the session review authority", async () => {
  const data = fixture([edit(1, "/root/a", "x", "y")])
  const corrupt = new CorruptEventRowError({
    aggregateId: "session:s", seq: 2, type: "file.reviewed", version: 1, timestamp: 2,
    actor: "flywheel", sessionId: "s", eventId: "broken-review", position: 2, rawPayload: "{",
  }, "invalid JSON")
  const readTolerant = data.reader.readTolerant.bind(data.reader)
  const reader = {
    ...data.reader,
    currentPosition: () => 2,
    readTolerant: (query: FactQuery = {}) => {
      const rows = readTolerant(query)
      return query.types?.includes("file.reviewed") && (query.afterPosition ?? 0) < 2 ? [...rows, corrupt] : rows
    },
  }
  const review = await getSessionChangeReview(asAsyncEventReadSurface(reader), "s")
  expect(review.reviewStatus(review.file("file:fact-1")!)).toBe("unknown")
})

test("a diff source that is no longer readable is unretained without throwing", async () => {
  const data = fixture([edit(1, "/root/a", "x", "y"), tool(2, "tool-1", diff(["/root/a"]))])
  const review = await getSessionChangeReview(data.projectionReader, "s")
  const change = review.file("file:fact-1")!.changes[0]!
  expect(await review.patchFor(change)).toBe("PATCH /root/a")
  data.rows[1] = tool(2, "tool-1", { broken: true })
  expect(await review.patchFor(change)).toBeUndefined()
  const readSlice = data.projectionReader.readSlice.bind(data.projectionReader)
  data.projectionReader.readSlice = async (query, tolerant) => {
    expect(tolerant).toBe(true)
    const slice = await readSlice(query, tolerant)
    return { ...slice, facts: [new CorruptEventRowError({
      aggregateId: "session:s", seq: 2, type: "tool.result.recorded", version: 1,
      timestamp: 2, actor: "flywheel", sessionId: "s", eventId: "fact-2", position: 2, rawPayload: "{",
    }, "invalid JSON")] }
  }
  expect(await review.patchFor(change)).toBeUndefined()
})
