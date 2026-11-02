import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import {
  buildSessionContent, buildSessionContentManifest, readSessionContentRange,
  type SessionContentNode, type SessionContentNodeRow,
} from "../../../src/infra/session-content.js"
import { buildMutationEvidence, buildMutationFileEvidence, readMutationEvidenceFiles, type MutationEvidenceEntry } from "../../../src/infra/mutation-evidence.js"
import { MutationEvidenceSchema } from "../../../src/infra/mutation-evidence-schema.js"
import { formatFileSamples, formatNotAppliedFiles, summarizeNotAppliedFiles } from "../../../src/infra/not-applied-files.js"

function memoryContent() {
  const nodes = new Map<string, SessionContentNode>()
  const fetched: string[] = []
  return {
    nodes, fetched,
    stage: async (rows: readonly SessionContentNodeRow[]) => {
      for (const row of rows) {
        expect(Buffer.byteLength(JSON.stringify(row.node))).toBeLessThanOrEqual(65_536)
        if (row.node.kind === "text") {
          expect(Buffer.byteLength(row.node.text)).toBeLessThanOrEqual(65_536)
          expect(row.node.text.isWellFormed()).toBe(true)
        }
        if (row.node.kind === "index") {
          for (const child of row.node.children) expect(nodes.has(child.sha256)).toBe(true)
        }
        nodes.set(row.sha256, row.node)
      }
    },
    read: async (hash: string) => { fetched.push(hash); return nodes.get(hash) ?? null },
  }
}

async function changedFile(stage: ReturnType<typeof memoryContent>["stage"]) {
  const file = await buildMutationFileEvidence({
    mutationId: "mutation-1", path: "/project/a", displayPath: "a",
    before: { kind: "text", text: "old\n" }, after: { kind: "text", text: "new\n" }, conflictMarkers: true,
  }, stage)
  if (!file) throw new Error("expected a changed file")
  return file
}

describe("session content", () => {
  test("reconstructs exact UTF-8 bytes through windows that split characters", async () => {
    const content = memoryContent()
    const text = `${"a".repeat(65_535)}🙂${"é".repeat(70_000)}`
    const reference = await buildSessionContent(text, content.stage)
    const bytes: Buffer[] = []
    for (let offset = 0; offset < reference.bytes; offset += 8191) {
      const range = await readSessionContentRange(reference, offset, 8191, content.read)
      expect(range).toMatchObject({ kind: "available", offset })
      if (range.kind !== "available") throw new Error("missing bytes")
      expect(range.nextOffset).toBe(offset + 8191 < reference.bytes ? offset + 8191 : null)
      bytes.push(Buffer.from(range.base64, "base64"))
    }
    expect(Buffer.concat(bytes).toString("utf8")).toBe(text)
    expect(createHash("sha256").update(Buffer.concat(bytes)).digest("hex")).toBe(reference.sha256)
  })

  test("reduces chunks for escaped JSON and preserves an empty file without a missing reference", async () => {
    const content = memoryContent()
    const text = "\u0000".repeat(70_000)
    const stagedText: string[] = []
    const ref = await buildSessionContent(text, async rows => {
      for (const row of rows) if (row.node.kind === "text") stagedText.push(row.sha256)
      await content.stage(rows)
    })
    expect(stagedText.length).toBe(new Set(stagedText).size)
    const range = await readSessionContentRange(ref, 101, 321, content.read)
    expect(range.kind).toBe("available")
    if (range.kind !== "available") throw new Error("missing range")
    expect(Buffer.from(range.base64, "base64")).toEqual(Buffer.from(text).subarray(101, 422))
    const empty = await buildSessionContent("", content.stage)
    expect(await readSessionContentRange(empty, 0, 1, content.read)).toEqual({ kind: "available", offset: 0, base64: "", nextOffset: null })
    await expect(buildSessionContent("\ud800", content.stage)).rejects.toThrow("strict UTF-8")
  })

  test("seeks a multi-level file manifest without reading unrelated descriptor pages", async () => {
    const content = memoryContent()
    const file = await changedFile(content.stage)
    function* entries(): Generator<MutationEvidenceEntry> {
      for (let index = 0; index < 5000; index++) {
        yield { kind: "applied", file: { ...file, mutationId: `mutation-${index}`, path: `/project/${index}/${"x".repeat(1900)}` } }
      }
    }
    const summary = await buildMutationEvidence(entries(), content.stage)
    expect(summary).toMatchObject({ applied: 5000, modified: 5000, addedLines: 5000, removedLines: 5000 })
    content.fetched.length = 0
    const page = await readMutationEvidenceFiles(summary, 2500, 1, content.read)
    expect(page.kind).toBe("available")
    if (page.kind !== "available") throw new Error("missing manifest")
    expect(page.files).toHaveLength(1)
    expect(page.files[0]).toMatchObject({ kind: "applied", file: { mutationId: "mutation-2500" } })
    expect(page.nextOffset).toBe(2501)
    expect(content.fetched).toHaveLength(3)
    expect(Buffer.byteLength(JSON.stringify(summary))).toBeLessThanOrEqual(4096)
    const largerPage = await readMutationEvidenceFiles(summary, 2500, 128, content.read)
    if (largerPage.kind !== "available") throw new Error("missing bounded page")
    expect(largerPage.files.length).toBeLessThan(128)
    expect(largerPage.nextOffset).toBe(2500 + largerPage.files.length)
    expect(Buffer.byteLength(JSON.stringify(largerPage))).toBeLessThanOrEqual(65_536)
    if (largerPage.nextOffset === null) throw new Error("expected a continuation")
    const continued = await readMutationEvidenceFiles(summary, largerPage.nextOffset, 1, content.read)
    expect(continued).toMatchObject({ kind: "available", files: [{ kind: "applied", file: { mutationId: `mutation-${largerPage.nextOffset}` } }] })
  })

  test("fills a manifest page to exactly the encoded response limit and splits one byte later", async () => {
    // A seekable page must fit one records response at the largest possible nextOffset.
    const responseBytes = (records: readonly string[]) =>
      Buffer.byteLength(JSON.stringify({ kind: "available", records, nextOffset: Number.MAX_SAFE_INTEGER }))
    const first = `"é\\\n${"a".repeat(30_000)}`
    const fill = (extra: number) => {
      const second = "b".repeat(65_536 - responseBytes([first, ""]) + extra)
      return [first, second]
    }
    for (const [extra, pages] of [[0, [2]], [1, [1, 1]]] as const) {
      const content = memoryContent()
      const records = fill(extra)
      expect(responseBytes(records)).toBe(65_536 + extra)
      const manifest = await buildSessionContentManifest(records, content.stage)
      const leaves = [...content.nodes.values()].flatMap(node => node.kind === "records" ? [node.records.length] : [])
      expect(leaves).toEqual([...pages])
      expect(manifest.entries).toBe(2)
    }
  })

  test("separates applied, omitted and not-applied totals and retains bounded notice metadata", async () => {
    const content = memoryContent()
    const file = await changedFile(content.stage)
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-")
    const sensitive = await buildMutationFileEvidence({
      mutationId: "sensitive", path: "/project/private", before: { kind: "absent" },
      after: { kind: "text", text: `token: ${secret}\n` },
    }, content.stage)
    if (!sensitive) throw new Error("missing omission")
    const gone = await buildMutationFileEvidence({
      mutationId: "gone", path: "/project/gone", before: { kind: "text", text: "gone\n" }, after: { kind: "absent" },
    }, content.stage)
    if (!gone) throw new Error("missing deletion")
    const refusals = Array.from({ length: 200 }, (_, index) => ({ path: `blocked-${index}`, reason: "the project changed it" }))
    const summary = await buildMutationEvidence([
      { kind: "applied", file }, { kind: "applied", file: sensitive }, { kind: "applied", file: gone },
      ...refusals.map(entry => ({ kind: "not_applied" as const, ...entry })),
    ], content.stage)
    expect(summary).toMatchObject({
      version: 2, applied: 3, notApplied: 200, omissions: 1, added: 1, modified: 1, removed: 1,
      addedLines: 1, removedLines: 2, conflictMarkers: 1,
    })
    expect(JSON.stringify([...content.nodes.values()])).not.toContain(secret)
    expect(summary.samples).toHaveLength(3)
    const notice = summarizeNotAppliedFiles(refusals)
    expect(notice).toMatchObject({ total: 200 })
    expect(notice.samples).toHaveLength(3)
    expect(formatNotAppliedFiles(notice, "client")).toContain("197 more not-applied files (expand this result)")
    expect(formatNotAppliedFiles(notice, "model")).toContain("197 more not-applied files")
    expect(formatNotAppliedFiles(notice, "model")).not.toMatch(/expand|Session Changes/)
    expect(formatFileSamples({ total: 5, samples: ["applied.ts", "refused.ts"] }, { kind: "mixed", audience: "client" }))
      .toBe("applied.ts, refused.ts, and 3 more files (expand this result)")
    expect(formatNotAppliedFiles(summarizeNotAppliedFiles(refusals.slice(0, 1))))
      .toBe("Not applied, because the project also changed these files: blocked-0 (the project changed it)")
    expect(summarizeNotAppliedFiles([{ path: "x".repeat(10_000), reason: "changed" }])).toEqual({ total: 1, samples: [] })
    const largePath = { ...file, displayPath: "\"".repeat(5000) }
    const bounded = await buildMutationEvidence([{ kind: "applied", file: largePath }], content.stage)
    expect(bounded.samples).toEqual([])
    expect(bounded.applied).toBe(1)
    expect(() => Schema.decodeUnknownSync(MutationEvidenceSchema, { onExcessProperty: "error" })({ ...bounded, version: 3 })).toThrow()
  })

  test("preserves the existing retained-line limit and exact omitted counts", async () => {
    const content = memoryContent()
    const file = await buildMutationFileEvidence({
      mutationId: "many-lines", path: "a", before: { kind: "absent" },
      after: { kind: "text", text: "new\n".repeat(1500) },
    }, content.stage)
    expect(file).toMatchObject({ retainedLines: 1000, renderedLines: 1500, omittedLines: 500, addedLines: 1000, removedLines: 0 })
  })

  test("missing, corrupted and wrong-length children are unavailable, not empty", async () => {
    const content = memoryContent()
    const ref = await buildSessionContent("a".repeat(100_000), content.stage)
    const root = content.nodes.get(ref.root)
    if (root?.kind !== "index") throw new Error("expected an index")
    const first = root.children[0]
    if (!first) throw new Error("expected a child")
    const original = content.nodes.get(first.sha256)
    if (!original) throw new Error("expected a leaf")
    content.nodes.delete(first.sha256)
    expect(await readSessionContentRange(ref, 0, 5, content.read)).toEqual({ kind: "unavailable", reason: "missing" })
    content.nodes.set(first.sha256, { version: 1, kind: "text", text: "damaged" })
    expect(await readSessionContentRange(ref, 0, 5, content.read)).toEqual({ kind: "unavailable", reason: "corrupt" })
    content.nodes.set(first.sha256, original)
    const wrong = { ...root, children: root.children.map((child, index) => index === 0 ? { ...child, bytes: child.bytes + 1 } : child) }
    const hash = createHash("sha256").update(JSON.stringify(wrong)).digest("hex")
    content.nodes.set(hash, wrong)
    expect(await readSessionContentRange({ ...ref, root: hash, bytes: ref.bytes + 1 }, 0, 5, content.read))
      .toEqual({ kind: "unavailable", reason: "corrupt" })
    const summary = await buildMutationEvidence([{ kind: "applied", file: await changedFile(content.stage) }], content.stage)
    content.nodes.delete(summary.manifest.root)
    expect(await readMutationEvidenceFiles(summary, 0, 1, content.read)).toEqual({ kind: "unavailable", reason: "missing" })
  })
})
