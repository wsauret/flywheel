import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { contentEvidence } from "../../../../src/infra/content-evidence"
import { asAsyncEventReadSurface, type AsyncEventReadSurface, type EventStore } from "../../../../src/infra/event-store-types"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import type { ContentResolver, ToolContentRow } from "../../../../src/infra/tool-content"
import { createToolResultDisplayMetaCursorReader, readToolResultDisplayMeta } from "../../../../src/orchestration/session/conversation/tool-result-meta"
import {
  createToolExecutionProjection,
  loadToolExecutionTimelineFromEvents,
  TOOL_EXECUTION_FACT_TYPES,
  toolExecutionTimelineFromProjection,
} from "../../../../src/orchestration/session/tool-execution-projection"

const SESSION_ID = "session-1"
const AGGREGATE = `session:${SESSION_ID}`
const CONTENT_TEXT = "nested tool result body\n".repeat(200)
const OUTPUT_TEXT = "captured execution output\n".repeat(200)

let tmpDir: string
let store: EventStore

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-tool-content-seams-"))
  store = createSqliteEventStore(path.join(tmpDir, "flywheel.sqlite"))
})

afterEach(() => {
  store.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function contentRow(text: string): ToolContentRow {
  const evidence = contentEvidence(text)
  return { sha256: evidence.sha256, content: text, bytes: evidence.bytes }
}

function reference(text: string) {
  const evidence = contentEvidence(text)
  return { sha256: evidence.sha256, bytes: evidence.bytes, preview: evidence.preview }
}

function append(type: string, version: number, actor: "agent" | "flywheel", payload: { [key: string]: unknown }, contentRows?: readonly ToolContentRow[]): void {
  store.append({
    aggregateId: AGGREGATE,
    type,
    version,
    timestamp: Date.now(),
    actor,
    sessionId: SESSION_ID,
    payload,
    ...(contentRows ? { contentRows } : {}),
  })
}

function seedReferencedToolFacts(): void {
  const inputText = JSON.stringify({})
  const inputEvidence = contentEvidence(inputText)
  append("tool.input.completed", 1, "agent", {
    toolUseId: "t1",
    toolName: "bash",
    input: {},
    inputBytes: inputEvidence.bytes,
    inputSha256: inputEvidence.sha256,
    inputPreview: inputText,
    executionMode: "foreground",
    traceKind: "tool",
    childHasOwnViewport: false,
    parentToolUseId: "parent-1",
  })
  append("tool.execution_output.recorded", 2, "flywheel", {
    toolUseId: "t1",
    output: reference(OUTPUT_TEXT),
    parentToolUseId: "parent-1",
  }, [contentRow(OUTPUT_TEXT)])
  append("tool.result.recorded", 2, "flywheel", {
    toolUseId: "t1",
    outcome: "ok",
    content: reference(CONTENT_TEXT),
    contentPreview: contentEvidence(CONTENT_TEXT).preview,
    details: { exitCode: 0, displayContent: reference(OUTPUT_TEXT) },
    parentToolUseId: "parent-1",
  }, [contentRow(CONTENT_TEXT)])
}

describe("tool projections resolve tool-content references", () => {
  test("keeps management notices out of nested shell history before and after output settles", async () => {
    append("tool.input.completed", 2, "agent", {
      toolUseId: "shell", parentToolUseId: "code", toolName: "bash", providerCallId: "shell", providerToolName: "bash", modelRequestId: "request",
      input: { command: "echo ready" }, inputBytes: 24, inputSha256: "sha", inputPreview: "{}",
      executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    })
    append("tool.result.recorded", 1, "flywheel", {
      toolUseId: "shell", outcome: "ok", contentPreview: "Running in background. Use process wait.", details: { background: true },
    })
    const cursor = createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(store), SESSION_ID)
    const context = { executionCwd: tmpDir, idSuffix: "", presentation: "execute" as const }
    const quiet = await (await cursor.replay()).children("code", context).readBlock(0)
    expect(quiet).toMatchObject({ kind: "tool", status: "completed" })
    expect(quiet.kind === "tool" ? quiet.content : "wrong kind").toBeUndefined()
    append("tool.execution_output.recorded", 1, "flywheel", { toolUseId: "shell", output: "ready\n" })
    expect(await (await cursor.replay()).children("code", context).readBlock(0)).toMatchObject({ content: "ready\n" })
  })

  test("the tool execution projection folds referenced facts without resolving their content", async () => {
    seedReferencedToolFacts()
    const base = asAsyncEventReadSurface(store)
    const refusing: ContentResolver = { resolve: () => { throw new Error("the tool execution fold resolved tool content") } }
    const reader: AsyncEventReadSurface = { ...base, readPage: async (...args) => ({ ...await base.readPage(...args), toolContent: refusing }) }
    const timeline = toolExecutionTimelineFromProjection(await createToolExecutionProjection(reader, SESSION_ID).replay())
    expect(timeline).toEqual([expect.objectContaining({ toolUseId: "t1", resultOutcome: "ok", contentPreview: contentEvidence(CONTENT_TEXT).preview })])
    expect(timeline[0]).not.toHaveProperty("content")
  })

  test("the pure from-events fold reads stored references without content", () => {
    seedReferencedToolFacts()
    const timeline = loadToolExecutionTimelineFromEvents(store.read({ aggregateId: AGGREGATE, types: TOOL_EXECUTION_FACT_TYPES }))
    expect(timeline.map((tool) => [tool.toolUseId, tool.resultOutcome])).toEqual([["t1", "ok"]])
  })

  test("a nested call's row shows the referenced result text its result fact recorded", async () => {
    append("tool.input.completed", 1, "agent", {
      toolUseId: "read-1", toolName: "read", input: { path: "a.ts" }, inputBytes: 15, inputSha256: "sha", inputPreview: "{}",
      executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false, parentToolUseId: "code",
    })
    append("tool.result.recorded", 2, "flywheel", {
      toolUseId: "read-1", outcome: "ok", content: reference(CONTENT_TEXT), contentPreview: contentEvidence(CONTENT_TEXT).preview, parentToolUseId: "code",
    }, [contentRow(CONTENT_TEXT)])
    const cursor = createToolResultDisplayMetaCursorReader(asAsyncEventReadSurface(store), SESSION_ID)
    const row = await (await cursor.replay()).children("code", { executionCwd: tmpDir, idSuffix: "", presentation: "execute" }).readBlock(0)
    expect(row).toMatchObject({ kind: "tool", status: "completed", content: CONTENT_TEXT })
  })

  test("tool result display meta resolves referenced execution output and details", async () => {
    seedReferencedToolFacts()
    const meta = (await readToolResultDisplayMeta(asAsyncEventReadSurface(store), SESSION_ID)).get("t1")
    expect(meta?.executionOutput).toBe(OUTPUT_TEXT)
    expect(meta?.exitCode).toBe(0)
  })
})
