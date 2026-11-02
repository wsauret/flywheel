import { describe, expect, it } from "bun:test"
import type { StoredFact } from "../../../../src/infra/event-store-types.js"
import { nestedFactProjectionEvents } from "../../../../src/infra/output/nested-fact-projection.js"
import { OutputProjector } from "../../../../src/infra/output/output-projector.js"

function stored(type: string, actor: string, payload: StoredFact["payload"], timestamp = 42): StoredFact {
  return {
    aggregateId: "session:s1",
    type,
    version: 1,
    timestamp,
    actor,
    sessionId: "s1",
    payload,
    position: 1,
    id: "event-1",
    seq: 1,
  }
}

describe("nestedFactProjectionEvents", () => {
  it("maps nested input, result, and execution output facts", () => {
    expect(nestedFactProjectionEvents(stored("tool.input.completed", "agent", {
      toolUseId: "nested-1",
      toolName: "list",
      input: { path: "." },
      inputBytes: 12,
      inputSha256: "hash",
      inputPreview: "preview",
      executionMode: "foreground",
      traceKind: "tool",
      childHasOwnViewport: false,
      parentToolUseId: "code-1",
    }))).toEqual([{
      type: "tool-input-complete",
      toolUseId: "nested-1",
      name: "list",
      input: { path: "." },
      timestamp: 42,
      parentToolUseId: "code-1",
      nestedInCode: true,
    }])

    expect(nestedFactProjectionEvents(stored("tool.result.recorded", "flywheel", {
      toolUseId: "nested-1",
      outcome: "ok",
      content: "three entries",
      contentPreview: "preview",
      details: { count: 3 },
      parentToolUseId: "code-1",
    }))).toEqual([{
      type: "tool-result",
      toolUseId: "nested-1",
      outcome: "ok",
      content: [{ type: "text", text: "three entries" }],
      source: "render",
      timestamp: 42,
      parentToolUseId: "code-1",
      details: { count: 3 },
    }])

    expect(nestedFactProjectionEvents(stored("tool.execution_output.recorded", "flywheel", {
      toolUseId: "nested-1",
      output: "progress",
      parentToolUseId: "code-1",
    }))).toEqual([{
      type: "tool-execution-output-recorded",
      toolUseId: "nested-1",
      output: "progress",
      parentToolUseId: "code-1",
    }])
  })

  it("ignores supported top-level facts and unrelated facts", () => {
    expect(nestedFactProjectionEvents(stored("tool.result.recorded", "flywheel", {
      toolUseId: "top-1",
      outcome: "ok",
      contentPreview: "done",
    }))).toEqual([])
    expect(nestedFactProjectionEvents(stored("model.turn.completed", "provider", {
      isError: false,
    }))).toEqual([])
  })

  it("materializes a translated nested row as an execute child", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" })
    projector.apply({ type: "tool-input-complete", toolUseId: "code-1", name: "code", input: { source: "return tools.list({ path: '.' })" }, timestamp: 1 })
    const facts = [
      stored("tool.input.completed", "agent", {
        toolUseId: "nested-1", toolName: "list", input: { path: "." }, inputBytes: 12, inputSha256: "hash", inputPreview: "preview", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false, parentToolUseId: "code-1",
      }, 2),
      stored("tool.result.recorded", "flywheel", { toolUseId: "nested-1", outcome: "ok", content: "three entries", parentToolUseId: "code-1" }, 3),
    ]
    for (const fact of facts) for (const event of nestedFactProjectionEvents(fact)) projector.apply(event)

    expect(projector.getBlocks()).toMatchObject([
      { kind: "tool", name: "code" },
      { kind: "tool", name: "list", runCategoryOverride: "execute", content: "three entries", status: "completed" },
    ])
  })

  it("refines one visible child by id without a live body and omits hidden children", () => {
    const projector = new OutputProjector({ executionCwd: "/workspace" })
    projector.apply({ type: "tool-input-complete", toolUseId: "code-1", name: "code", input: { source: "nested calls" }, timestamp: 1 })
    const facts = [
      stored("tool.input.completed", "agent", {
        toolUseId: "memory-1", toolName: "memory", input: { action: "add", content: "Prefers Bun." }, inputBytes: 40, inputSha256: "memory-hash", inputPreview: "preview", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false, parentToolUseId: "code-1",
      }, 2),
      stored("tool.result.recorded", "flywheel", {
        toolUseId: "memory-1", outcome: "error", content: "Memory write failed", parentToolUseId: "code-1",
      }, 3),
      stored("tool.input.completed", "agent", {
        toolUseId: "process-1", toolName: "process", input: { action: "list" }, inputBytes: 17, inputSha256: "process-hash", inputPreview: "preview", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false, parentToolUseId: "code-1",
      }, 4),
    ]
    for (const fact of facts) for (const event of nestedFactProjectionEvents(fact)) projector.apply(event)

    const children = projector.getBlocks().filter((block) => block.kind === "tool" && block.runCategoryOverride === "execute")
    expect(children).toHaveLength(1)
    expect(children[0]).toMatchObject({ id: "memory-1", name: "memory", status: "error", errorMessage: "Memory write failed" })
    expect(children[0]).not.toHaveProperty("invocationBody")
  })
})
