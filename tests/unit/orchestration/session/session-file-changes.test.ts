import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { asAsyncEventReadSurface, CorruptEventRowError, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { buildSessionChildLinkedFact, buildSessionCreatedFact } from "../../../../src/orchestration/session/session-metadata-facts.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { countStateRequests, factsRead } from "../../../helpers/state-requests.js"
import { filesAsWritten, getSessionFileChanges, netChange, sessionChangeCounts, type NetChange } from "../../../../src/orchestration/session/session-file-changes.js"
import { edit, entries, fixture, human, mutation, row } from "./_session-change-fixtures.js"

test("acquisition is passive and the summary reads only bounded file facts", async () => {
  const initial = Array.from({ length: 300 }, (_, n) => edit(n + 1, `/root/${String(300 - n).padStart(3, "0")}`, null, "a"))
  const foreign = { ...mutation(301, "other"), sessionId: "other", aggregateId: "session:other" }
  const data = fixture([...initial, foreign, entries(302, [human("human")]), row(303, "tool.result.recorded", { toolUseId: "tool", outcome: "ok" })])
  const readPage = data.projectionReader.readPage.bind(data.projectionReader)
  let appended = false
  data.projectionReader.readPage = async (...args) => {
    if (!appended) {
      appended = true
      data.rows.push(edit(304, "/root/001", "a", "b"))
    }
    return readPage(...args)
  }
  expect(data.queries).toEqual([])
  const lane = await getSessionFileChanges(data.projectionReader, "s")
  const fileQueries = () => data.queries.filter(query => query.types?.includes("file.changed"))
  expect(lane.netFiles()).toHaveLength(300)
  expect(lane.gaps.size).toBe(0)
  expect(lane.revision()).toBe(300)
  expect(fileQueries().map(query => query.afterPosition)).toEqual([0, 256])
  expect(fileQueries().every(query => JSON.stringify(query.aggregateIds) === '["session:s"]' && query.limit === 257 && query.order === "asc" && JSON.stringify(query.types) === '["file.changed"]' && !query.positions)).toBe(true)
  expect(lane.netFiles()[0]).toMatchObject({ id: "file:fact-300", path: "/root/001" })
  expect(lane.netFiles().at(-1)).toMatchObject({ id: "file:fact-1", path: "/root/300" })
  expect(lane.netFiles().map(file => file.path)).toEqual(lane.files.map(file => file.path).toSorted())
  expect(lane.file("file:fact-300")).toBe(lane.netFiles()[0])
  expect(lane.file("file:fact-300")?.changes).toHaveLength(1)
  expect(lane.file("file:missing")).toBeUndefined()
  expect(data.reader.toolContent.resolve).not.toHaveBeenCalled()
  data.queries.length = 0
  expect(await getSessionFileChanges(data.projectionReader, "s")).toBe(lane)
  expect(fileQueries()).toEqual([{ aggregateIds: ["session:s"], types: ["file.changed"], afterPosition: 303, beforePosition: 305, limit: 257, order: "asc" }])
  expect(lane.file("file:fact-300")?.changes).toHaveLength(2)
  data.queries.length = 0
  expect((await getSessionFileChanges(data.projectionReader, "s")).netFiles()).toHaveLength(300)
  expect(lane.revision()).toBe(301)
  expect(fileQueries()).toEqual([])
})

const netCases: [string, readonly (readonly [string | null, string | null])[], NetChange | undefined][] = [
  ["added", [[null, "a"]], "added"],
  ["modified", [["a", "b"]], "modified"],
  ["removed", [["a", null]], "removed"],
  ["created then edited", [[null, "a"], ["a", "b"]], "added"],
  ["edited then deleted", [["a", "b"], ["b", null]], "removed"],
  ["deleted then recreated differently", [["a", null], [null, "b"]], "modified"],
  ["restored bytes", [["a", "b"], ["b", "a"]], undefined],
  ["created then deleted", [[null, "a"], ["a", null]], undefined],
  ["deleted then recreated identically", [["a", null], [null, "a"]], undefined],
]
test.each(netCases)("net change of %s", async (_name, steps, expected) => {
  const data = fixture(steps.map(([before, after], index) => edit(index + 1, "/root/a", before, after)))
  const lane = await getSessionFileChanges(data.projectionReader, "s")
  const [file] = lane.files
  expect(file && netChange(file)).toBe(expected)
  expect([...lane.netFiles()]).toEqual(expected === undefined ? [] : lane.files)
})

test("net files stay in path order and exclude restored files while membership keeps them", async () => {
  const data = fixture([edit(1, "/root/b", null, "b"), edit(2, "/root/a", "a", "x"), edit(3, "/root/c", "c", "d"), edit(4, "/root/a", "x", "a")])
  const lane = await getSessionFileChanges(data.projectionReader, "s")
  expect(lane.files.map(file => file.path).toSorted()).toEqual(["/root/a", "/root/b", "/root/c"])
  expect(lane.netFiles().map(file => [file.path, netChange(file)])).toEqual([["/root/b", "added"], ["/root/c", "modified"]])
  expect(lane.netFiles()).toBe(lane.netFiles())
  data.rows.push(edit(5, "/root/b", "b", null))
  expect((await getSessionFileChanges(data.projectionReader, "s")).netFiles().map(file => file.path)).toEqual(["/root/c"])
})

test("files another process edited after the session's last write are neither listed nor counted", async () => {
  const root = mkdtempSync(join(tmpdir(), "session-file-changes-"))
  try {
    const sha = (text: string) => ({ bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex"), preview: text })
    const asWritten = edit(1, join(root, "kept.txt"), null, "kept")
    asWritten.payload.after = sha("kept\n")
    const drifted = edit(2, join(root, "drifted.txt"), null, "x")
    drifted.payload.after = sha("session\n")
    const sameSize = edit(3, join(root, "same-size.txt"), null, "x")
    sameSize.payload.after = sha("aaaa\n")
    const deleted = edit(4, join(root, "deleted.txt"), "x", null)
    const recreated = edit(5, join(root, "recreated.txt"), "x", null)
    writeFileSync(join(root, "kept.txt"), "kept\n")
    writeFileSync(join(root, "drifted.txt"), "someone else\n")
    writeFileSync(join(root, "same-size.txt"), "bbbb\n")
    writeFileSync(join(root, "recreated.txt"), "back\n")
    const lane = await getSessionFileChanges(fixture([asWritten, drifted, sameSize, deleted, recreated]).projectionReader, "s")
    expect(lane.netFiles()).toHaveLength(5)
    expect(filesAsWritten(lane.netFiles(), root).map(file => file.path)).toEqual([join(root, "deleted.txt"), join(root, "kept.txt")])
    expect(sessionChangeCounts(lane, root)).toEqual({ fileCount: 2, unknownFileMutationGaps: 0 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Flywheel-owned files are neither listed nor counted", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "session-file-changes-")))
  try {
    const paths = [
      join(root, ".flywheel", "memory.md"),
      join(root, ".flywheel", "sessions", "note.md"),
      join(root, ".flywheel-old", "kept.md"),
      join(root, "src", "kept.ts"),
    ]
    mkdirSync(join(root, ".flywheel", "sessions"), { recursive: true })
    mkdirSync(join(root, ".flywheel-old"), { recursive: true })
    mkdirSync(join(root, "src"), { recursive: true })
    const changes = paths.map((path, index) => {
      writeFileSync(path, "changed")
      const change = edit(index + 1, path, null, "changed")
      change.payload.after = { bytes: 7, sha256: createHash("sha256").update("changed").digest("hex"), preview: "changed" }
      return change
    })
    const lane = await getSessionFileChanges(fixture(changes).projectionReader, "s")

    expect(filesAsWritten(lane.netFiles(), root).map(file => file.path)).toEqual(paths.slice(2))
    expect(sessionChangeCounts(lane, root)).toEqual({ fileCount: 2, unknownFileMutationGaps: 0 })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("unreadable file facts retain positioned gaps, bump the revision, and hide raw bytes", async () => {
  const data = fixture([row(1, "file.changed", { broken: true }, 4), mutation(3, "request")])
  const read = data.reader.readTolerant
  data.reader.readTolerant = query => {
    const rows = read(query)
    if (query?.types?.includes("file.changed") && (query.afterPosition ?? 0) < 2) {
      rows.push(new CorruptEventRowError({ aggregateId: "session:s", seq: 2, type: "file.changed", version: 4, timestamp: 2, actor: "flywheel", sessionId: "s", eventId: "bad-json", position: 2, rawPayload: "SECRET" }, "bad JSON"))
      rows.sort((a, b) => a.position - b.position)
    }
    return rows
  }
  const lane = await getSessionFileChanges(data.projectionReader, "s")
  expect(lane.netFiles()).toHaveLength(1)
  expect(lane.gaps.size).toBe(2)
  expect(lane.revision()).toBe(3)
  expect([...lane.gaps.values()]).toEqual([{ position: 1, eventId: "fact-1", sessionId: "s" }, { position: 2, eventId: "bad-json", sessionId: "s" }])
  expect(JSON.stringify([...lane.gaps.values()])).not.toContain("SECRET")
})

/** A store where `root` launched `children` subagents, each with `history` recorded edits. */
function launchedTree(children: number, history: number) {
  const events: StoredFact[] = []
  const append = (sessionId: string, fact: Pick<StoredFact, "type" | "version" | "actor" | "payload">) => {
    const position = events.length + 1
    events.push({ ...fact, position, id: `fact-${position}`, seq: position, aggregateId: `session:${sessionId}`, sessionId, timestamp: position })
  }
  const now = "2026-01-01T00:00:00.000Z"
  const launch = (sessionId: string, parentSessionId: string) => {
    append(sessionId, buildSessionCreatedFact({ kind: "subagent", command: "subagent", label: sessionId, conversationId: `${sessionId}-c`, createdAt: now, lastUpdated: now, lifecycleState: "inactive", executionCwd: resolve("/root"), launchedFrom: { parentSessionId, conversationId: `${parentSessionId}-c`, toolUseId: `launch-${sessionId}` } }))
    append(parentSessionId, buildSessionChildLinkedFact(sessionId, now))
  }
  const change = (sessionId: string, path: string) => {
    const { type, version, actor, payload } = edit(events.length + 1, path, null, sessionId)
    append(sessionId, { type, version, actor, payload })
  }
  for (let index = 0; index < children; index++) {
    launch(`child-${index}`, "root")
    for (let step = 0; step < history; step++) change(`child-${index}`, `/root/${index}-${step}`)
  }
  return { events, launch, change }
}

test("the root's count holds every launched session's changes, and a change costs reads that grow with neither the child count nor history", async () => {
  const costs = async (children: number, history: number) => {
    const tree = launchedTree(children, history)
    const counter = countStateRequests(asAsyncEventReadSurface(inMemoryEventReader(tree.events)))
    expect((await getSessionFileChanges(counter.reader, "root")).netFiles()).toHaveLength(children * history)
    counter.take()
    const steps: [number, number][] = []
    const step = async () => {
      const lane = await getSessionFileChanges(counter.reader, "root")
      const requests = counter.take()
      steps.push([requests.length, factsRead(requests)])
      return lane.netFiles().length
    }
    expect(await step()).toBe(children * history)
    for (let change = 0; change < 3; change++) {
      tree.change(`child-${change % children}`, `/root/new-${change}`)
      expect(await step()).toBe(children * history + change + 1)
    }
    // A session that joins later folds its own history once, and its edits count.
    tree.launch("late", "child-0")
    tree.change("late", "/root/late")
    expect(await step()).toBe(children * history + 4)
    return steps
  }
  const few = await costs(3, 1)
  // Eighty children exceed the sixty-four projections the registry holds per family.
  expect(await costs(80, 20)).toEqual(few)
  // An idle read folds nothing; each change folds its own fact and no history,
  // and a join folds its two lineage facts and its one edit.
  expect(few.map(([, facts]) => facts)).toEqual([0, 1, 1, 1, 3])
})
