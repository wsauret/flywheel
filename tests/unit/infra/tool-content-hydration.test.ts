import { describe, expect, test } from "bun:test"

import { contentEvidence } from "../../../src/infra/content-evidence"
import type { StoredFact } from "../../../src/infra/event-store-types"
import { InvariantViolation } from "../../../src/infra/invariant"
import { nestedFactProjectionEvents } from "../../../src/infra/output/nested-fact-projection"
import { hydrateToolContentFact } from "../../../src/infra/tool-content-hydration"
import { extractToolContentFact } from "../../../src/infra/tool-content-extraction"
import type { ContentResolver, ToolContentReference } from "../../../src/infra/tool-content"
import type { SessionRuntimeFact } from "../../../src/infra/runtime-fact-types"

const LARGE_TEXT = "nested subagent result text\n".repeat(150)

function reference(text: string): ToolContentReference {
  const evidence = contentEvidence(text)
  return { sha256: evidence.sha256, bytes: evidence.bytes, preview: evidence.preview }
}

function resolverFor(rows: ReadonlyMap<string, string>): ContentResolver {
  return { resolve: (_sessionId, sha256) => rows.get(sha256) ?? null }
}

function storedFact(type: string, version: number, payload: StoredFact["payload"]): StoredFact {
  return {
    aggregateId: "session:s1",
    type,
    version,
    timestamp: 1,
    actor: "flywheel",
    sessionId: "s1",
    payload,
    position: 7,
    id: "f1",
    seq: 0,
  }
}

describe("hydrateToolContentFact", () => {
  test("a missing content row throws the canonical invariant", () => {
    const fact = storedFact("tool.execution_output.recorded", 2, {
      toolUseId: "t1",
      output: { ...reference(LARGE_TEXT) },
    })
    expect(() => hydrateToolContentFact(fact, resolverFor(new Map()))).toThrow(InvariantViolation)
  })

  test("a sha256 mismatch throws the canonical invariant", () => {
    const ref = reference(LARGE_TEXT)
    const fact = storedFact("tool.execution_output.recorded", 2, { toolUseId: "t1", output: { ...ref } })
    expect(() => hydrateToolContentFact(fact, resolverFor(new Map([[ref.sha256, "different bytes"]])))).toThrow(InvariantViolation)
  })

  test("recovery-produced result and execution output facts round-trip through content rows", () => {
    const facts: SessionRuntimeFact[] = [{
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "nested-result",
        outcome: "ok",
        content: LARGE_TEXT,
        contentPreview: LARGE_TEXT.slice(0, 80),
        parentToolUseId: "parent",
        details: { displayContent: LARGE_TEXT },
      },
    }, {
      type: "tool.execution_output.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "nested-result",
        output: LARGE_TEXT,
        parentToolUseId: "parent",
      },
    }]
    const extracted = facts.map(extractToolContentFact)
    const rows = new Map(extracted.flatMap(({ contentRows }) => contentRows ?? []).map((row) => [row.sha256, row.content]))

    const hydrated = extracted.map(({ fact }) => hydrateToolContentFact(storedFact(fact.type, fact.version, fact.payload), resolverFor(rows)))

    expect(hydrated.map((fact) => fact.payload)).toEqual(facts.map((fact) => fact.payload))
  })
})

describe("nested-fact projection over hydrated facts", () => {
  test("a hydrated nested tool result renders its full text, not the preview", () => {
    const ref = reference(LARGE_TEXT)
    const fact = storedFact("tool.result.recorded", 2, {
      toolUseId: "t1",
      outcome: "ok",
      content: { ...ref },
      contentPreview: ref.preview,
      parentToolUseId: "parent-1",
    })
    const hydrated = hydrateToolContentFact(fact, resolverFor(new Map([[ref.sha256, LARGE_TEXT]])))

    const events = nestedFactProjectionEvents(hydrated)

    expect(events).toHaveLength(1)
    const event = events[0]
    if (event?.type !== "tool-result") throw new Error("expected a tool-result projection event")
    expect(event.content).toEqual([{ type: "text", text: LARGE_TEXT }])
  })

  test("a hydrated nested execution output carries the full text", () => {
    const ref = reference(LARGE_TEXT)
    const fact = storedFact("tool.execution_output.recorded", 2, {
      toolUseId: "t1",
      output: { ...ref },
      parentToolUseId: "parent-1",
    })
    const hydrated = hydrateToolContentFact(fact, resolverFor(new Map([[ref.sha256, LARGE_TEXT]])))

    const events = nestedFactProjectionEvents(hydrated)

    expect(events).toHaveLength(1)
    const event = events[0]
    if (event?.type !== "tool-execution-output-recorded") throw new Error("expected an execution output projection event")
    expect(event.output).toBe(LARGE_TEXT)
  })
})
