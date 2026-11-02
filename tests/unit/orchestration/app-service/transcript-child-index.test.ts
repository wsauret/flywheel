import { describe, expect, it, spyOn } from "bun:test"
import { createHash } from "node:crypto"
import { asAsyncEventReadSurface, type StoredFact } from "../../../../src/infra/event-store-types.js"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/transcript-projection-cache.js"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection.js"
import { entryRuntimeDefaults } from "../../../../src/orchestration/session-store/entry-defaults.js"
import type { AgentGroupBlock } from "../../../../src/infra/output-blocks.js"
import { frontendOutputBlockBytes } from "../../../../src/protocol/frontend-output-block-metrics.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"

const context = { executionCwd: process.cwd(), idSuffix: "", presentation: "container" as const }

function harness(count: number) {
  const events: StoredFact[] = []
  const append = (type: string, payload: StoredFact["payload"], timestamp = events.length, version = 1) => {
    const position = events.length + 1
    const actor = type === "tool.input.completed" ? "agent" : type === "tool.result.acknowledged" ? "provider" : "flywheel"
    events.push({ id: String(position), aggregateId: "session:session", sessionId: "session", position, seq: position, type, version, timestamp, actor, payload })
  }
  for (let index = 0; index < count; index += 1) append("tool.input.completed", {
    toolUseId: `child-${index}`, parentToolUseId: "parent", toolName: "read", input: { path: `file-${index}` },
    inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
  }, Math.floor(index / 2))
  const reader = inMemoryEventReader(events)
  const cache = createTranscriptProjectionCache({
    reader: asAsyncEventReadSurface(reader), projectRoot: context.executionCwd, sessionStore: { get: () => undefined },
    projectionReader: asAsyncEventReadSurface(reader),
    createProjection: () => ({ read: async () => null, dispose: async () => {} }),
  })
  return { cache, append, reader }
}

describe("subagent card projection", () => {
  it("reads each unchanged subagent call from the store once across live updates", async () => {
    const { cache, append, reader } = harness(0)
    const subagent = (toolUseId: string) => append("tool.input.completed", {
      toolUseId, toolName: "subagent", input: { kind: "run", prompt: "p" },
      inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    })
    for (const id of ["sub-0", "sub-1", "sub-2"]) subagent(id)
    const block = { kind: "tool", id: "sub-0", name: "subagent", presentation: { name: "Agent", detail: "" }, status: "pending", timestamp: 1 } as const
    const reads = spyOn(reader, "read")
    const positionReads = () => reads.mock.calls.filter(([query]) => query?.positions !== undefined).length
    await cache.projectBlock("session", block)
    // The projected row and the three calls the assignment pass needs share one batched read.
    expect(positionReads()).toBe(1)
    reads.mockClear()
    // An unrelated tool fact moves the tool-meta position, which rebuilds the
    // card assignments; only the projected row is read again.
    append("tool.input.completed", {
      toolUseId: "other", toolName: "read", input: { path: "file" },
      inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    })
    await cache.projectBlock("session", block)
    expect(positionReads()).toBe(1)
  })
})

describe("session-owned child index", () => {
  it("indexes one large parent and batches results and acknowledgements without quadratic sibling searches", async () => {
    const count = 256
    const { cache, append } = harness(count)
    let comparisons = 0
    const original = Array.prototype.findIndex
    const probe = spyOn(Array.prototype, "findIndex").mockImplementation(function (this: unknown[], predicate, thisArg) {
      return original.call(this, (value, index, array) => {
        if (value && typeof value === "object" && "positions" in value && "toolUseId" in value) comparisons += 1
        return predicate.call(thisArg, value, index, array)
      })
    })
    const sort = Array.prototype.sort
    const sorting = spyOn(Array.prototype, "sort").mockImplementation(function (this: unknown[], compare) {
      return compare ? sort.call(this, (a, b) => {
        if (a && typeof a === "object" && "positions" in a && "toolUseId" in a) comparisons += 1
        return compare(a, b)
      }) : sort.call(this)
    })
    try {
      const first = await cache.children("session", "parent", context)
      expect(first.blockCount).toBe(count)
      const coldComparisons = comparisons
      comparisons = 0
      for (let index = 0; index < count; index += 1) {
        append("tool.result.recorded", { toolUseId: `child-${index}`, outcome: "ok", contentPreview: "done" })
        append("tool.result.acknowledged", { toolUseId: `child-${index}` })
      }
      const completed = await cache.children("session", "parent", context)
      expect(await completed.readBlock(128)).toMatchObject({ id: "child-128", status: "completed" })
      expect(coldComparisons).toBeGreaterThan(0)
      expect(coldComparisons).toBeLessThan(count * 16)
      expect(comparisons).toBeLessThan(count * 16)
    } finally {
      probe.mockRestore()
      sorting.mockRestore()
      await cache.dispose()
    }
  })

  it("reuses unchanged views and selected bodies across pages and invalidates only changed children", async () => {
    const { cache, append } = harness(128)
    try {
      const first = await cache.children("session", "parent", context)
      const selected = await first.readBlock(64)
      const sibling = await first.readBlock(65)
      expect(await cache.children("session", "parent", context)).toBe(first)
      expect(await first.readBlock(64)).toBe(selected)
      append("tool.result.recorded", { toolUseId: "child-64", outcome: "error", contentPreview: "failed" })
      append("tool.result.acknowledged", { toolUseId: "child-64" })
      append("tool.result.recorded", { toolUseId: "child-66", outcome: "ok", contentPreview: "done" })
      const next = await cache.children("session", "parent", context)
      expect(next).not.toBe(first)
      expect(await next.readBlock(64)).toMatchObject({ status: "error" })
      expect(await next.readBlock(65)).toBe(sibling)
      expect(await first.readBlock(64)).toBe(selected)
      expect(await first.readBlock(66)).toMatchObject({ status: "pending" })
      expect(await next.readBlock(66)).toMatchObject({ status: "completed" })
      expect(await cache.children("session", "parent", context)).toBe(next)
    } finally {
      await cache.dispose()
    }
  })

  it("serves warm live continuation pages without traversing child metadata or hydrating skipped bodies", async () => {
    const { cache, append, reader } = harness(128)
    const content = "exact selected content"
    const sha256 = createHash("sha256").update(content).digest("hex")
    for (let index = 0; index < 128; index += 1) append("tool.result.recorded", {
      toolUseId: `child-${index}`, parentToolUseId: "parent", outcome: "ok",
      content: { sha256: index >= 64 && index <= 70 ? sha256 : `missing-${index}`, bytes: content.length, preview: "body" },
    }, 128 + index, 2)
    append("tool.input.completed", {
      toolUseId: "skipped-child", parentToolUseId: "skipped", toolName: "read", input: { path: "skipped" },
      inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    })
    append("tool.result.recorded", { toolUseId: "skipped-child", parentToolUseId: "skipped", outcome: "ok", content: { sha256: "missing-skipped", bytes: 1, preview: "" } }, 300, 2)
    const hydrate = spyOn(reader.toolContent, "resolve").mockImplementation((_sessionId, hash) => hash === sha256 ? content : null)
    const group = (id: string, toolUseId: string): AgentGroupBlock => ({
      kind: "agentGroup", containerKind: "subagent", id, toolUseId, label: "Explorer", description: "Read files",
      status: "active", timestamp: 0, children: [], totalToolCount: 128,
    })
    const entry = {
      ...entryRuntimeDefaults(() => [group("uuid-before", "skipped"), group("uuid-live", "parent")], 0),
      kind: "chat" as const, runner: null, conversationId: "uncommitted", description: "Live",
    }
    const projection = createSessionDetailProjection({
      transcriptCache: cache, reader: asAsyncEventReadSurface(reader), projectionReader: asAsyncEventReadSurface(reader), projectRoot: context.executionCwd, sessionStore: { get: () => entry },
      manager: { read: async () => ({
        label: "Session", lastUpdated: "2026-01-01T00:00:00.000Z", lifecycleState: "active",
        name: "Session", kind: "chat", command: "chat", conversationId: "uncommitted", executionCwd: context.executionCwd,
      }) },
    })
    let visibilityVisits = 0
    const filter = Array.prototype.filter
    const traversal = spyOn(Array.prototype, "filter").mockImplementation(function (this: unknown[], predicate: Parameters<unknown[]["filter"]>[0], thisArg?: unknown) {
      return filter.call(this, (value, index, array) => {
        if (value && typeof value === "object" && "visible" in value && "toolUseId" in value) visibilityVisits += 1
        return predicate.call(thisArg, value, index, array)
      })
    })
    const reads = spyOn(reader, "read")
    try {
      const children = await cache.children("session", "parent", context)
      await cache.children("session", "skipped", context)
      expect(visibilityVisits).toBe(129)
      expect(hydrate).not.toHaveBeenCalled()
      const selected = await children.readBlock(64)
      const maxBytes = frontendOutputBlockBytes(selected) * 2
      visibilityVisits = 0
      reads.mockClear()
      let cursor = { groupBlockId: "tool:uuid-live", childIndex: 64 }
      const ids: string[] = []
      for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
        const page = await projection.outputGroupChildren("session", { groupBlockIds: ["tool:uuid-before", "tool:uuid-live"], maxBytes, cursor })
        expect(page.groups[0]?.children).toEqual([])
        const rows = page.groups[1]?.children ?? []
        if (pageIndex === 0) expect(rows[0]).toBe(selected)
        ids.push(...rows.map((row) => row.id))
        if (!page.nextCursor) throw new Error("Expected continuation")
        cursor = page.nextCursor
      }
      expect(ids).toEqual(Array.from({ length: 6 }, (_, index) => `child-${index + 64}`))
      expect(visibilityVisits).toBe(0)
      expect(hydrate).toHaveBeenCalledTimes(7)
      expect(await cache.children("session", "parent", context)).toBe(children)
      expect(await children.readBlock(64)).toBe(selected)
      expect(hydrate).toHaveBeenCalledTimes(7)
      // Each newly drawn row reads only its own facts by position; no page
      // scans the session's tool facts.
      const scans = reads.mock.calls.flatMap(([query], index) => {
        const result = reads.mock.results[index]
        return query?.positions === undefined && result?.type === "return" ? result.value : []
      })
      expect(scans.filter((fact) => fact.type.startsWith("tool."))).toEqual([])
      // One read per body hydrated after the reset: 7 bodies, 1 before it.
      expect(reads.mock.calls.filter(([query]) => query?.positions !== undefined)).toHaveLength(6)
    } finally {
      traversal.mockRestore()
      hydrate.mockRestore()
      reads.mockRestore()
      await cache.dispose()
    }
  })

  it("preserves timestamp ties, hidden counts, ordered insertion, and parent-local revisions", async () => {
    const { cache, append } = harness(4)
    try {
      const old = await cache.children("session", "parent", context)
      const sibling = await old.readBlock(1)
      const input = { input: { path: "late" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false }
      append("tool.input.completed", { ...input, toolUseId: "late", parentToolUseId: "parent", toolName: "read" }, 0)
      append("tool.result.recorded", { toolUseId: "late", outcome: "error", contentPreview: "failed" })
      append("tool.input.completed", { ...input, toolUseId: "hidden", parentToolUseId: "parent", toolName: "process" }, 0)
      append("tool.input.completed", { ...input, toolUseId: "other", parentToolUseId: "other-parent", toolName: "read" }, 0)
      const next = await cache.children("session", "parent", context)
      expect(next.totalCount).toBe(6)
      expect(next.blockCount).toBe(5)
      expect(await Promise.all(Array.from({ length: next.blockCount }, async (_, index) => (await next.readBlock(index)).id))).toEqual(["child-0", "child-1", "late", "child-2", "child-3"])
      expect(await next.readBlock(2)).toMatchObject({ status: "error" })
      expect(await next.readBlock(1)).toBe(sibling)
      expect(old.blockCount).toBe(4)
      append("tool.result.recorded", { toolUseId: "other", outcome: "ok", contentPreview: "done" })
      expect(await cache.children("session", "parent", context)).toBe(next)
      expect(await (await cache.children("session", "other-parent", context)).readBlock(0)).toMatchObject({ id: "other", status: "completed" })
    } finally {
      await cache.dispose()
    }
  })
})
