import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { Database } from "bun:sqlite"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { AnyBlock, ToolEntry } from "../../../../src/infra/output-blocks.js"
import { getToolDisplay } from "../../../../src/infra/tools/tool-display-registry.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store.js"
import { OutputProjector } from "../../../../src/infra/output/output-projector.js"
import { hydrateDerivedOutputGroupChildren, paginateOutputGroupChildren } from "../../../../src/orchestration/app-service/transcript-queries.js"
import {
  createFilteredSubagentStream,
  createSubagentStats,
} from "../../../../src/orchestration/modules/subagents/execution/stream-filter.js"
import type { SessionRuntimeFact } from "../../../../src/orchestration/session/session-runtime-event-types.js"
import { createToolResultDisplayMetaCursorReader } from "../../../../src/orchestration/session/conversation/tool-result-meta.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../../src/infra/runtime-fact-mapper.js"

function child(id: string): Extract<AnyBlock, { kind: "tool" }> {
  return { kind: "tool", id, name: "read", presentation: { name: "Read", detail: `${id}.ts` }, status: "completed", timestamp: 1 }
}

function history(status: "active" | "completed", totalToolCount: number, children: ToolEntry[] = []) {
  const visible = children.filter((entry) => !getToolDisplay(entry.name).hiddenFromTranscript)
  return {
    totalCount: children.length,
    ...(status === "completed" ? { settledCount: totalToolCount } : {}),
    blockCount: visible.length,
    readBlock(index: number) {
      const entry = visible[index]
      if (!entry) throw new Error("Child index out of bounds")
      return entry
    },
  }
}

async function readChildren(group: ReturnType<typeof hydrateDerivedOutputGroupChildren>) {
  return Promise.all(Array.from({ length: group.totalChildren }, (_, index) => group.readBlock(index)))
}



describe("hydrateDerivedOutputGroupChildren totalToolCount invariant", () => {
  it("skips prior groups and children before materialization and validates continuation bounds", async () => {
    const calls: string[] = []
    const groups = ["first", "second"].map((groupBlockId) => ({
      groupBlockId,
      totalChildren: 4,
      readBlock(index: number) { calls.push(`${groupBlockId}:${index}`); return child(`${groupBlockId}-${index}`) },
    }))
    const page = await paginateOutputGroupChildren(groups, { groupBlockIds: ["first", "second"], maxBytes: 10000, cursor: { groupBlockId: "second", childIndex: 2 } })
    expect(calls).toEqual(["second:2", "second:3"])
    expect(page.groups[0]?.children).toEqual([])
    expect(page.groups[1]?.children.map((entry) => entry.id)).toEqual(["second-2", "second-3"])
    calls.length = 0
    await expect(paginateOutputGroupChildren(groups, { groupBlockIds: ["first", "second"], maxBytes: 10000, cursor: { groupBlockId: "second", childIndex: 5 } })).rejects.toThrow("exceeds")
    expect(calls).toEqual([])
    await expect(paginateOutputGroupChildren(groups, { groupBlockIds: ["first", "second"], maxBytes: 10000, cursor: { groupBlockId: "missing", childIndex: 0 } })).rejects.toThrow("not in the request")
  })

  it("allows per-tool facts to lag the live counter while the group is in flight", async () => {
    const result = hydrateDerivedOutputGroupChildren("agentGroup:agent-1", history("active", 5, [child("c0"), child("c1")]))
    expect(result.totalChildren).toBe(2)
    expect((await readChildren(result)).map((item) => item.id)).toEqual(["c0", "c1"])
  })

  it("throws loudly on a settled group whose fact count mismatches", () => {
    expect(() => hydrateDerivedOutputGroupChildren("agentGroup:agent-1", history("completed", 5, [child("c0")])))
      .toThrow("expected 5 operations, found 1")
  })

})

const PARENT_TOOL_USE_ID = "tu-agent-1"
const SESSION_ID = "hidden-child-session"
const CWD = "/scratch/project"
const TMP_ROOT = path.join(os.tmpdir(), `flywheel-output-history-group-children-test-${process.pid}-${Date.now()}`)

let tmpDir: string

beforeEach(() => {
  tmpDir = path.join(TMP_ROOT, crypto.randomUUID())
  fs.mkdirSync(tmpDir, { recursive: true })
})

const openStores: Array<{ close(): void }> = []

afterEach(() => {
  // Stores first: an open database file keeps its directory undeletable on
  // Windows, so a store outliving the temporary root fails the teardown.
  while (openStores.length > 0) openStores.pop()!.close()
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

function appendFact(store: EventStore, fact: SessionRuntimeFact): void {
  store.append({
    aggregateId: `session:${SESSION_ID}`,
    type: fact.type,
    version: fact.version,
    timestamp: Date.now(),
    actor: fact.actor,
    sessionId: SESSION_ID,
    payload: fact.payload,
  })
}

const CHILD_EXECUTION = { executionMode: "foreground" as const, traceKind: "tool" as const, childHasOwnViewport: false }

/** Both facts the runtime can produce for one attempted child call, appended
 *  under the dispatching subagent's tool-use id. */
function appendHiddenValidationFailure(store: EventStore): void {
  appendFact(store, {
    type: "tool.validation.failed",
    version: 1,
    actor: "flywheel",
    payload: {
      toolUseId: "child-memory",
      toolName: "memory",
      input: { action: "add" },
      inputBytes: 18,
      inputSha256: "memory-input-hash",
      inputPreview: "{\"action\":\"add\"}",
      ...CHILD_EXECUTION,
      reason: "content is required for add",
      parentToolUseId: PARENT_TOOL_USE_ID,
    },
  })
}

function appendSuccessfulSibling(store: EventStore): void {
  appendFact(store, {
    type: "tool.input.completed",
    version: 1,
    actor: "agent",
    payload: {
      toolUseId: "child-read",
      toolName: "read",
      input: { path: "a.ts" },
      inputBytes: 16,
      inputSha256: "read-input-hash",
      inputPreview: "{\"path\":\"a.ts\"}",
      ...CHILD_EXECUTION,
      parentToolUseId: PARENT_TOOL_USE_ID,
    },
  })
  appendFact(store, {
    type: "tool.result.recorded",
    version: 1,
    actor: "flywheel",
    payload: {
      toolUseId: "child-read",
      outcome: "ok",
      contentBytes: 4,
      contentSha256: "read-content-hash",
      contentPreview: "code",
      parentToolUseId: PARENT_TOOL_USE_ID,
    },
  })
}

describe("settled group holding a validation-failed child", () => {
  it("hydrates without throwing and ships every transcript-visible child", async () => {
    // The attempted-call count the run records must cover every durable child
    // row, including a call rejected before execution: the stream filter is the
    // counting seam and the tool-execution timeline is the fold it is asserted
    // against.
    const stats = createSubagentStats()
    const filtered = createFilteredSubagentStream({
      onRenderEvent: () => {},
      agentType: "explorer",
      stats,
      textState: { finalAssistantText: "" },
    })
    filtered(createRuntimeEvent("tool.input.completed", {
      tool_use: { id: "child-read", name: "read", input: { path: "a.ts" } },
      parent_tool_use_id: PARENT_TOOL_USE_ID,
    }))
    filtered(createRuntimeEvent("tool.validation.failed", {
      tool_use_id: "child-memory",
      tool_name: "memory",
      input: { action: "add" },
      reason: "content is required for add",
      parent_tool_use_id: PARENT_TOOL_USE_ID,
    }))

    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    openStores.push(store)
    appendSuccessfulSibling(store)
    appendHiddenValidationFailure(store)
    const children = (await createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(store), SESSION_ID).replay()).children(PARENT_TOOL_USE_ID, {
      executionCwd: CWD, idSuffix: "", presentation: "container", settledCount: stats.toolUseCount,
    })
    const result = hydrateDerivedOutputGroupChildren("agentGroup:agent-1", children)

    expect((await readChildren(result)).map((entry) => [entry.name, entry.status])).toEqual([["read", "completed"], ["memory", "error"]])
    expect((await readChildren(result)).map((entry) => entry.id)).toEqual(["child-read", "child-memory"])
    expect(result.totalChildren).toBe(2)
    expect(stats.toolUseCount).toBe(children.totalCount)
  })
})

describe("shared visible-container child reads", () => {
  it("uses one cursor replay for one or many visible parents and preserves event order", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    openStores.push(store)
    appendSuccessfulSibling(store)
    appendHiddenValidationFailure(store)
    // Drawing a row reads its own facts by position; only a cursor replay
    // scans the session.
    let reads = 0
    const reader: EventStore = {
      ...store,
      read(query) {
        if (query?.positions === undefined) reads += 1
        return store.read(query)
      },
      readTolerant(query) {
        if (query?.positions === undefined) reads += 1
        return store.readTolerant(query)
      },
    }

    const replay = await createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(reader), SESSION_ID).replay()
    const context = { executionCwd: CWD, idSuffix: "", presentation: "container" as const }
    const one = replay.children(PARENT_TOOL_USE_ID, context)
    expect(reads).toBe(1)
    expect((await readChildren(hydrateDerivedOutputGroupChildren("agentGroup:agent-1", one))).map((entry) => entry.id)).toEqual(["child-read", "child-memory"])
    const many = [PARENT_TOOL_USE_ID, "empty-parent"].map((parent) => replay.children(parent, context))
    expect(many[0]).toBe(one)
    expect(await readChildren(hydrateDerivedOutputGroupChildren("agentGroup:empty-parent", many[1]!))).toEqual([])
    expect(reads).toBe(1)
  })

})

describe("parent-indexed byte-budgeted child history", () => {
  it("bounds the parent-filtered read to the session aggregate index on a long session", () => {
    const dbFile = resolveEventStoreDbFile(tmpDir)
    const store = createSqliteEventStore(dbFile)
    for (let index = 0; index < 1_000; index += 1) {
      appendFact(store, {
        type: "tool.input.completed",
        version: 1,
        actor: "agent",
        payload: {
          toolUseId: `unrelated-${index}`,
          toolName: "read",
          input: { path: `${index}.ts` },
          inputBytes: 1,
          inputSha256: "hash",
          inputPreview: "{}",
          ...CHILD_EXECUTION,
          parentToolUseId: `other-${index}`,
        },
      })
    }
    appendSuccessfulSibling(store)
    store.close()
    const db = new Database(dbFile, { readonly: true })
    try {
      const plan = db.query<{ detail: string }, [string, string]>(`
        explain query plan select * from event indexed by event_aggregate_type_position_idx
        where aggregate_id = ?1
          and type in ('tool.input.completed', 'tool.result.recorded', 'tool.execution_output.recorded', 'tool.result.acknowledged', 'tool.validation.failed')
          and json_extract(payload, '$.parentToolUseId') in (?2)
        order by position asc
      `).all(`session:${SESSION_ID}`, PARENT_TOOL_USE_ID)
      expect(plan.map((row) => row.detail).join("\n")).toContain("event_aggregate_type_position_idx")
    } finally {
      db.close()
    }
  })

  it("creates no payload expression index for parent-filtered reads at store open", () => {
    // Regression guard: a json_extract expression index over tool facts is
    // built synchronously inside store open and stalls runtime readiness for
    // seconds on a large workspace. The parent-filtered read must ride the
    // aggregate index instead.
    const dbFile = resolveEventStoreDbFile(tmpDir)
    createSqliteEventStore(dbFile).close()
    const db = new Database(dbFile, { readonly: true })
    try {
      const names = db.query<{ name: string }, []>("select name from sqlite_master where type = 'index' and tbl_name = 'event'").all().map((row) => row.name)
      expect(names).not.toContain("event_parent_tool_fact_idx")
      expect(names).not.toContain("event_stream_request_position_idx")
    } finally {
      db.close()
    }
  })

})

const CHILD_MUTATION = {
  version: 1 as const,
  files: [{ path: ".flywheel/memory/MEMORY.md", change: "added" as const, unifiedDiff: "@@ -0,0 +1 @@\n+Prefers tabs." }],
  omissions: [],
}

function appendChildMemoryCall(store: EventStore): void {
  appendFact(store, {
    type: "tool.input.completed",
    version: 1,
    actor: "agent",
    payload: {
      toolUseId: "child-memory",
      toolName: "memory",
      input: { action: "add", content: "Prefers tabs." },
      inputBytes: 42,
      inputSha256: "memory-input-hash",
      inputPreview: "{\"action\":\"add\"}",
      ...CHILD_EXECUTION,
      parentToolUseId: PARENT_TOOL_USE_ID,
    },
  })
}

function appendChildMemoryResult(store: EventStore, outcome: "ok" | "error" | "blocked" | "interrupted"): void {
  appendFact(store, {
    type: "tool.result.recorded",
    version: 1,
    actor: "flywheel",
    payload: {
      toolUseId: "child-memory",
      outcome,
      contentPreview: outcome === "ok" ? "{\"success\":true}" : "memory is full",
      ...(outcome === "ok" ? { details: { mutation: CHILD_MUTATION, resultAction: "created" } } : {}),
      parentToolUseId: PARENT_TOOL_USE_ID,
    },
  })
  // The provider ack arrives after the result and overwrites the execution
  // status, so it must not decide what the row reports.
  appendFact(store, {
    type: "tool.result.acknowledged",
    version: 1,
    actor: "provider",
    payload: { toolUseId: "child-memory", parentToolUseId: PARENT_TOOL_USE_ID },
  })
}

describe("agent-update child of an agent group across settlement", () => {
  it("hydrates a called-but-unresulted update child while the group is in flight", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    openStores.push(store)
    appendChildMemoryCall(store)
    const children = (await createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(store), SESSION_ID).replay()).children(PARENT_TOOL_USE_ID, {
      executionCwd: CWD, idSuffix: "", presentation: "container",
    })
    const result = hydrateDerivedOutputGroupChildren("agentGroup:agent-1", children)

    expect((await readChildren(result)).map((entry) => [entry.name, entry.status])).toEqual([["memory", "pending"]])
    expect((await readChildren(result)).map((entry) => [entry.id, entry.status])).toEqual([["child-memory", "pending"]])
    expect(result.totalChildren).toBe(1)
  })

  it.each([
    ["error", "error"],
    ["blocked", "blocked"],
    ["interrupted", "interrupted"],
  ] as const)("hydrates a %s update child after its result is acknowledged", async (outcome, status) => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    openStores.push(store)
    appendChildMemoryCall(store)
    appendChildMemoryResult(store, outcome)
    const children = (await createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(store), SESSION_ID).replay()).children(PARENT_TOOL_USE_ID, {
      executionCwd: CWD, idSuffix: "", presentation: "container", settledCount: 1,
    })
    const result = hydrateDerivedOutputGroupChildren("agentGroup:agent-1", children)

    expect((await readChildren(result)).map((entry) => [entry.name, entry.status])).toEqual([["memory", status]])
    expect((await readChildren(result)).map((entry) => [entry.id, entry.status])).toEqual([["child-memory", status]])
  })

  it("omits only children whose display contract hides them", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    openStores.push(store)
    for (const [toolUseId, toolName] of [["visible", "memory"], ["hidden", "process"]] as const) {
      appendFact(store, {
        type: "tool.validation.failed", version: 1, actor: "flywheel",
        payload: {
          toolUseId, toolName, input: {}, inputBytes: 2, inputSha256: "hash", inputPreview: "{}",
          ...CHILD_EXECUTION, reason: "Failed", parentToolUseId: PARENT_TOOL_USE_ID,
        },
      })
    }
    const children = (await createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(store), SESSION_ID).replay()).children(PARENT_TOOL_USE_ID, {
      executionCwd: CWD, idSuffix: "", presentation: "container", settledCount: 2,
    })
    const result = hydrateDerivedOutputGroupChildren("agentGroup:agent-1", children)

    expect(children.totalCount).toBe(2)
    expect((await readChildren(result)).map((entry) => entry.id)).toEqual(["visible"])
    expect(result.totalChildren).toBe(1)
  })

  it("presents a successful update child with the mutation its result recorded", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    openStores.push(store)
    appendChildMemoryCall(store)
    appendChildMemoryResult(store, "ok")
    const { createMutationEvidenceRecovery } = await import("../../../../src/orchestration/session/mutation-evidence-recovery.js")
    const { readMutationEvidenceFiles } = await import("../../../../src/infra/mutation-evidence.js")
    const { readPatchContent } = await import("../../../../src/orchestration/session/session-change-sources.js")
    const reader = createMutationEvidenceRecovery(asAsyncEventReadSurface(store), asAsyncEventWriter(store)).reader
    const children = (await createToolResultDisplayMetaCursorReader(reader, SESSION_ID).replay()).children(PARENT_TOOL_USE_ID, {
      executionCwd: CWD, idSuffix: "", presentation: "container", settledCount: 1,
    })
    const result = hydrateDerivedOutputGroupChildren("agentGroup:agent-1", children)

    expect((await readChildren(result)).map((entry) => [entry.id, entry.status])).toEqual([["child-memory", "completed"]])
    const evidence = (await result.readBlock(0)).mutationEvidence
    if (!evidence) throw new Error("Missing recovered evidence")
    const page = await readMutationEvidenceFiles(evidence, 0, 10, hash => reader.readSessionContentNode!(SESSION_ID, hash))
    if (page.kind !== "available") throw new Error("Missing recovered files")
    const entry = page.files[0]
    if (entry?.kind !== "display" || entry.file.patch.kind !== "retained") throw new Error("Missing retained patch")
    expect(await readPatchContent(reader, SESSION_ID, entry.file.patch.reference)).toBe(CHILD_MUTATION.files[0]!.unifiedDiff)
    expect((await result.readBlock(0)).resultAction).toBe("created")
  })
})

describe("historical nested children", () => {
  const longContent = `full-${"x".repeat(300)}-tail\u001b[31m`
  const canonicalDisplayContent = `display-${"y".repeat(300)}-tail\u001b[31m`
  const cases = [
    { id: "success", outcome: "ok" as const, content: longContent, displayContent: canonicalDisplayContent },
    { id: "error", outcome: "error" as const, content: "Error: Failed to read 'missing.ts': ENOENT: no such file, open 'missing.ts'" },
    { id: "blocked", outcome: "blocked" as const, content: "Waiting for approval\nMore detail" },
    { id: "interrupted", outcome: "interrupted" as const, content: "Tool was interrupted" },
  ]
  const settlement = (row: ToolEntry) => ({
    status: row.status,
    errorMessage: row.status === "error" ? row.errorMessage : undefined,
    statusMessage: row.status === "blocked" ? row.statusMessage : undefined,
  })

  async function recordCases(store: EventStore): Promise<void> {
    const writer = createSessionFactWriter({ sessionId: SESSION_ID, writer: asAsyncEventWriter(store) })
    for (const item of cases) {
      for (const event of [
        createRuntimeEvent("tool.input.completed", {
          model_request_id: `request-${item.id}`,
          tool_use: { id: item.id, name: "read", provider_call_id: `call-${item.id}`, provider_tool_name: "read", executable_tool_name: "read", input: { path: `${item.id}.ts` }, execution: { mode: "foreground", trace_kind: "tool" } },
          parent_tool_use_id: PARENT_TOOL_USE_ID,
        }),
        createRuntimeEvent("tool.result.recorded", {
          model_request_id: `request-${item.id}`,
          tool_use_id: item.id,
          content: [{ type: "text", text: item.content }],
          outcome: item.outcome,
          is_error: item.outcome !== "ok",
          ...("displayContent" in item ? { details: { displayContent: { text: item.displayContent, startLine: 7 } } } : {}),
          ...(item.outcome === "interrupted" ? { interrupted: true } : {}),
          parent_tool_use_id: PARENT_TOOL_USE_ID,
        }),
      ]) {
        for (const fact of mapRuntimeEventToSessionRuntimeFacts(event)) await writer.record(fact)
      }
    }
    await writer.record({
      type: "tool.input.completed", version: 1, actor: "agent",
      payload: {
        toolUseId: "legacy", toolName: "read", input: { path: "legacy.ts" }, inputBytes: 20, inputSha256: "legacy-input", inputPreview: "legacy.ts",
        ...CHILD_EXECUTION, parentToolUseId: PARENT_TOOL_USE_ID,
      },
    })
    await writer.record({
      type: "tool.result.recorded", version: 1, actor: "flywheel",
      payload: { toolUseId: "legacy", outcome: "ok", contentPreview: "legacy preview", parentToolUseId: PARENT_TOOL_USE_ID },
    })
    writer.dispose()
    expect(store.read({ aggregateId: `session:${SESSION_ID}` }).filter((event) => event.type.startsWith("tool.")).map((event) => event.payload.parentToolUseId)).toEqual([
      PARENT_TOOL_USE_ID, PARENT_TOOL_USE_ID,
      PARENT_TOOL_USE_ID, PARENT_TOOL_USE_ID,
      PARENT_TOOL_USE_ID, PARENT_TOOL_USE_ID,
      PARENT_TOOL_USE_ID, PARENT_TOOL_USE_ID,
      PARENT_TOOL_USE_ID, PARENT_TOOL_USE_ID,
    ])
  }

  async function historicalChildren(presentation: "execute" | "container"): Promise<ToolEntry[]> {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    openStores.push(store)
    await recordCases(store)
    const children = (await createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(store), SESSION_ID).replay()).children(PARENT_TOOL_USE_ID, {
      executionCwd: CWD, idSuffix: "", presentation,
    })
    return Promise.all(Array.from({ length: children.blockCount }, (_, index) => children.readBlock(index)))
  }

  function liveProjector(parent: { name: string; input: { [key: string]: unknown } }): OutputProjector {
    const live = new OutputProjector({ executionCwd: CWD })
    live.apply({ type: "tool-use", toolUseId: PARENT_TOOL_USE_ID, ...parent, timestamp: 0 })
    for (const item of cases) {
      live.apply({ type: "tool-use", toolUseId: item.id, name: "read", input: { path: `${item.id}.ts` }, timestamp: 1, parentToolUseId: PARENT_TOOL_USE_ID })
      live.apply({ type: "tool-result", toolUseId: item.id, outcome: item.outcome, content: [{ type: "text", text: item.content }], source: "render", timestamp: 2, parentToolUseId: PARENT_TOOL_USE_ID })
    }
    return live
  }

  it("replays subagent row settlement with the same short messages as live rows", async () => {
    const historical = await historicalChildren("container")
    const group = liveProjector({ name: "subagent", input: { persona: "explorer", description: "Look", prompt: "Look" } }).getBlocks()
      .find((block) => block.kind === "agentGroup")
    const liveRows = group?.kind === "agentGroup" ? group.children.filter((block): block is ToolEntry => block.kind === "tool") : []

    expect(liveRows).toHaveLength(cases.length)
    expect(historical.slice(0, cases.length).map(settlement)).toEqual(liveRows.map(settlement))
  })

  it("names a running card's message row by the recipient its result states, and states a held outcome, as the live row does", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    openStores.push(store)
    appendFact(store, {
      type: "tool.input.completed", version: 1, actor: "agent",
      payload: {
        toolUseId: "child-message", toolName: "message_session", input: { to: "14d393567c5e", text: "SIBLING-NOTE" },
        inputBytes: 40, inputSha256: "message-input-hash", inputPreview: "{}", ...CHILD_EXECUTION,
      },
    })
    appendFact(store, {
      type: "tool.result.recorded", version: 1, actor: "flywheel",
      payload: { toolUseId: "child-message", outcome: "ok", contentPreview: "Held for 14d393567c5e.", details: { targetName: "Bravo waits and reports", statusMessage: "Held: it is interrupted." } },
    })
    const children = (await createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(store), SESSION_ID).replay()).sessionChildren({
      executionCwd: CWD, idSuffix: "#card", presentation: "container",
    })

    expect(await children.readBlock(0)).toMatchObject({ presentation: { name: "Message to", detail: "Bravo waits and reports" }, status: "blocked", statusMessage: "Held: it is interrupted." })
  })

  it("replays Code Mode result content and settlement semantics with live parity", async () => {
    const historical = await historicalChildren("execute")
    const liveRows = liveProjector({ name: "code", input: { source: "nested calls" } }).getBlocks()
      .filter((block): block is ToolEntry => block.kind === "tool" && block.runCategoryOverride === "execute")

    expect(historical.slice(0, cases.length).map(settlement)).toEqual(liveRows.map(settlement))
    expect(historical[0]?.content?.length).toBeGreaterThan(240)
    expect(historical[0]?.content).toBe(canonicalDisplayContent.replace("\u001b[31m", ""))
    expect(historical[0]?.content).toEndWith("-tail")
    expect(historical[1]).toMatchObject({ status: "error", errorMessage: "No such file" })
    expect(historical[2]).toMatchObject({ status: "blocked", statusMessage: "Waiting for approval" })
    expect(historical[3]).toMatchObject({ status: "interrupted" })
    expect(historical[4]).toMatchObject({ status: "completed", content: "legacy preview\n[Historical result content truncated]" })
  })
})
