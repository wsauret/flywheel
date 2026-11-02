import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { MutationEvidence } from "../../../src/infra/mutation-evidence.js"
import { AgentSystemMessageV2DataSchema } from "../../../src/infra/events.js"
import { ToolResultEventDataV2Schema, ToolExecutionOutputRecordedDataV2Schema } from "../../../src/infra/runtime-event-payload-types.js"
import { parseSessionRuntimeFact, parseStoredSessionRuntimeFact } from "../../../src/infra/runtime-fact-parser.js"
import { extractToolContentFact } from "../../../src/infra/tool-content-extraction.js"
import { hydrateToolContentFact } from "../../../src/infra/tool-content-hydration.js"
import { parseConversationTreeFact, chatEntriesAppendedVersion } from "../../../src/orchestration/session/conversation/conversation-facts.js"
import { extractTreeFactContent } from "../../../src/orchestration/session/conversation/conversation-tree-content-extraction.js"

const evidence = {
  version: 2,
  manifest: { version: 1, root: "a".repeat(64), bytes: 20_000_000, entries: 5000 },
  applied: 5000, retainedFiles: 4999, omissions: 1, notApplied: 2, added: 1, modified: 4998, removed: 1,
  addedLines: 6000, removedLines: 5000, conflictMarkers: 1,
  samples: [{ kind: "applied", path: "file.ts" }],
} satisfies MutationEvidence
const inline = {
  version: 1,
  files: [{ path: "file.ts", change: "modified", unifiedDiff: "+new\n-old", omittedLines: 7 }],
  omissions: [{ path: "secret", reason: "sensitive" }],
} as const
const reference = { sha256: "b".repeat(64), bytes: 100, preview: "output" }
const fact = <const T extends string, const V extends number, P>(type: T, version: V, payload: P) => ({ type, version, actor: "flywheel" as const, payload })
const entry = <M>(message: M) => ({
  id: "notice", parentId: null, timestamp: "2026-10-16T00:00:00.000Z", kind: "message" as const, message,
})

describe("reference-backed mutation evidence contracts", () => {
  test("current result and output versions keep root counts with either ordinary text representation", () => {
    for (const [version, text] of [[3, "output"], [4, reference]] as const) {
      const result = fact("tool.result.recorded", version, {
        toolUseId: "tool", parentToolUseId: "parent", outcome: "ok", content: text,
        details: { mutationEvidence: evidence, displayContent: text, exitCode: 0 },
      })
      const output = fact("tool.execution_output.recorded", version, {
        toolUseId: "tool", output: text, mutationEvidence: evidence,
      })
      expect<unknown>(parseStoredSessionRuntimeFact(result)).toEqual(result)
      expect<unknown>(parseStoredSessionRuntimeFact(output)).toEqual(output)
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(4096)
      const badEvidence = { ...evidence, files: inline.files }
      expect(() => parseStoredSessionRuntimeFact({ ...result, payload: { ...result.payload, details: { mutationEvidence: badEvidence } } })).toThrow()
      expect(() => parseStoredSessionRuntimeFact({ ...output, payload: { ...output.payload, mutationEvidence: inline } })).toThrow()
      expect(() => parseStoredSessionRuntimeFact({ ...result, payload: { ...result.payload, details: { mutationEvidence: evidence, mutation: inline } } })).toThrow()
      expect(() => parseStoredSessionRuntimeFact({ ...output, payload: { ...output.payload, mutation: inline } })).toThrow()
    }
  })

  test("evidence that names removed directories decodes beside the previous shape that has none", () => {
    const withDirectories = {
      ...evidence, removedDirectories: 1, filesInRemovedDirectories: 454,
      samples: [{ kind: "removed_directory", path: "scratch/dl", files: 454, bytes: 12_000_000 }],
    } satisfies MutationEvidence
    for (const mutationEvidence of [evidence, withDirectories]) {
      const output = fact("tool.execution_output.recorded", 4, { toolUseId: "tool", output: reference, mutationEvidence })
      expect<unknown>(parseStoredSessionRuntimeFact(output)).toEqual(output)
    }
  })

  test("current evidence rejects oversized summaries without restricting the represented file count", () => {
    const payload = { toolUseId: "tool", output: "", mutationEvidence: evidence }
    expect(parseSessionRuntimeFact(fact("tool.execution_output.recorded", 3, payload))).toEqual(fact("tool.execution_output.recorded", 3, payload))
    for (const mutationEvidence of [
      { ...evidence, samples: Array.from({ length: 4 }, () => ({ kind: "applied", path: "file" })) },
      { ...evidence, samples: [{ kind: "applied", path: "x".repeat(4096) }] },
    ]) {
      expect(() => parseSessionRuntimeFact(fact("tool.execution_output.recorded", 3, { ...payload, mutationEvidence }))).toThrow()
    }
  })

  test("literal previous inline payloads stay readable only at their previous versions", () => {
    const result = { toolUseId: "tool", outcome: "ok", details: { mutation: inline } }
    const output = { toolUseId: "tool", output: "output", mutation: inline }
    for (const version of [1, 2]) {
      expect(parseStoredSessionRuntimeFact(fact("tool.result.recorded", version, result)).payload).toEqual(result)
      expect(parseStoredSessionRuntimeFact(fact("tool.execution_output.recorded", version, output)).payload).toEqual(output)
    }
    expect(() => parseStoredSessionRuntimeFact(fact("tool.result.recorded", 3, result))).toThrow()
    expect(() => parseStoredSessionRuntimeFact(fact("tool.execution_output.recorded", 3, output))).toThrow()
  })

  test("ordinary text extraction and hydration preserve the evidence version and exact root", () => {
    const text = "output\n".repeat(500)
    for (const input of [
      parseSessionRuntimeFact(fact("tool.result.recorded", 3, {
        toolUseId: "tool", outcome: "ok", parentToolUseId: "parent", content: text,
        details: { mutationEvidence: evidence, displayContent: text },
      })),
      parseSessionRuntimeFact(fact("tool.execution_output.recorded", 3, {
        toolUseId: "tool", output: text, mutationEvidence: evidence,
      })),
    ]) {
      const extracted = extractToolContentFact(input)
      expect(extracted.fact.version).toBe(4)
      expect(extracted.contentRows).toHaveLength(1)
      const stored = { ...extracted.fact, id: "id", aggregateId: "session:s", sessionId: "s", timestamp: 1, position: 1, seq: 1 }
      const hydrated = hydrateToolContentFact(stored, {
        resolve: (_session, sha256) => extracted.contentRows?.find(row => row.sha256 === sha256)?.content ?? null,
      })
      expect(parseSessionRuntimeFact(fact(hydrated.type, hydrated.version, hydrated.payload))).toEqual(input)
    }
  })

  test("current live event boundaries reject inline mutation payloads", () => {
    const result = { tool_use_id: "tool", details: { mutationEvidence: evidence } }
    const output = { tool_use_id: "tool", output: "", mutationEvidence: evidence }
    const notice = { message: "Skills updated", mutationEvidence: evidence }
    expect(Schema.decodeUnknownSync(ToolResultEventDataV2Schema)(result)).toEqual(result)
    expect(Schema.decodeUnknownSync(ToolExecutionOutputRecordedDataV2Schema)(output)).toEqual(output)
    expect(Schema.decodeUnknownSync(AgentSystemMessageV2DataSchema)(notice)).toEqual(notice)
    expect(() => Schema.decodeUnknownSync(ToolResultEventDataV2Schema)({ ...result, details: { mutation: inline } })).toThrow()
    expect(() => Schema.decodeUnknownSync(ToolExecutionOutputRecordedDataV2Schema)({ ...output, mutation: inline })).toThrow()
    expect(() => Schema.decodeUnknownSync(AgentSystemMessageV2DataSchema)({ ...notice, reviewMutations: [] })).toThrow()
  })

  test("review notices carry one flat evidence root in version 7 and keep prior notices historical", () => {
    const message = { kind: "system" as const, content: "Skills updated", mutationEvidence: evidence }
    const current = fact("chat.entries.appended", 7, { conversationId: "conversation", entries: [entry(message)] })
    expect(parseConversationTreeFact(current)).toEqual(current)
    expect(chatEntriesAppendedVersion([entry(message)])).toBe(7)
    const previous = entry({ kind: "system", content: "Skills updated", reviewMutations: [{ name: "skill", action: "patched", reach: "project", mutation: inline }] })
    const historical = fact("chat.entries.appended", 6, { conversationId: "conversation", entries: [previous] })
    expect<unknown>(parseConversationTreeFact(historical)).toEqual(historical)
    expect(chatEntriesAppendedVersion([previous])).toBe(3)
    expect(() => parseConversationTreeFact({ ...current, payload: { ...current.payload, entries: [previous] } })).toThrow()
    expect(() => parseConversationTreeFact({ ...historical, payload: current.payload })).toThrow()
    for (const mutationEvidence of [inline, [evidence], { ...evidence, files: inline.files }]) {
      expect(() => parseConversationTreeFact({ ...current, payload: { ...current.payload, entries: [entry({ ...message, mutationEvidence })] } })).toThrow()
    }
    const withText = parseConversationTreeFact({
      ...current,
      payload: { ...current.payload, entries: [
        entry(message),
        { ...entry({ kind: "toolResult", toolUseId: "tool", content: [{ type: "text", text: "output".repeat(1000) }] }), id: "result" },
      ] },
    })
    const extracted = extractTreeFactContent(withText)
    expect(extracted.fact.version).toBe(7)
    expect(extracted.contentRows).toHaveLength(1)
    expect(parseConversationTreeFact(extracted.fact)).toEqual(extracted.fact)
  })
})
