import { describe, expect, test } from "bun:test"

import { createRuntimeEvent } from "../../../src/infra/runtime-event-factory"
import type { RuntimeEvent } from "../../../src/infra/runtime-event-types"
import { emitToolInputComplete } from "../../../src/orchestration/agent-runtime/emit"
import { mapRuntimeEventToSessionRuntimeFacts } from "../../../src/infra/runtime-fact-mapper"

/** Composed at runtime so this test file holds no secret-shaped literal of its
 *  own; the joined value matches the token shape `redactSecrets` masks. */
const SECRET = ["sk", "proj", "aB3".repeat(12)].join("-")
const REDACTED = "[redacted secret]"

const EXECUTION = { mode: "foreground" as const, trace_kind: "tool" as const }

interface ToolInput { [key: string]: unknown }
function emitted(name: string, input: ToolInput): RuntimeEvent {
  const events: RuntimeEvent[] = []
  emitToolInputComplete((event) => events.push(event), { id: "tool-1", name, input })
  const event = events[0]
  if (!event) throw new Error("nothing was emitted")
  return event
}

function inputOf(event: RuntimeEvent) {
  if (event.type !== "tool.input.completed") throw new Error(`unexpected event ${event.type}`)
  return event.data.tool_use.input
}

interface FactPayload { [key: string]: unknown }
function factPayload(event: RuntimeEvent): FactPayload {
  const [fact] = mapRuntimeEventToSessionRuntimeFacts(event)
  if (!fact) throw new Error("the event mapped to no fact")
  return fact.payload
}

describe("the durable record of a learning-store tool call", () => {
  test("redacts the memory tool's entry content at emission", () => {
    const input = { action: "add", title: "Save the key", content: `Remember ${SECRET}` }

    expect(inputOf(emitted("memory", input))).toEqual({
      action: "add",
      title: "Save the key",
      content: `Remember ${REDACTED}`,
    })
  })

  test("redacts every operation of a memory batch, however deep", () => {
    const input = {
      title: "Consolidate",
      operations: [
        { action: "remove", old_text: "stale" },
        { action: "add", content: SECRET },
      ],
    }

    expect(inputOf(emitted("memory", input))).toEqual({
      title: "Consolidate",
      operations: [
        { action: "remove", old_text: "stale" },
        { action: "add", content: REDACTED },
      ],
    })
  })

  test("redacts the skill_manage content-bearing fields at emission", () => {
    const input = {
      action: "save",
      name: "provider-quirks",
      description: `Use when ${SECRET}`,
      body: `Step one: ${SECRET}`,
      new_string: SECRET,
    }

    expect(inputOf(emitted("skill_manage", input))).toEqual({
      action: "save",
      name: "provider-quirks",
      description: `Use when ${REDACTED}`,
      body: `Step one: ${REDACTED}`,
      new_string: REDACTED,
    })
  })

  test("redacts every tool input before durable publication", () => {
    const input = { command: `echo ${SECRET}` }

    expect(inputOf(emitted("bash", input))).toEqual({ command: `echo ${REDACTED}` })
  })

  // The mapping is the last boundary before the event store, so it redacts again:
  // no producer of this event, present or future, can make the durable fact the
  // place an authored secret survives.
  test("redacts a raw input the mapping is handed anyway", () => {
    const event = createRuntimeEvent("tool.input.completed", {
      model_request_id: "request-1",
      tool_use: { id: "tool-1", name: "memory", provider_call_id: "call-1", provider_tool_name: "memory", executable_tool_name: "memory", input: { action: "add", content: SECRET }, execution: EXECUTION },
    })

    const payload = factPayload(event)
    expect(payload.input).toEqual({ action: "add", content: REDACTED })
    // The evidence measures what is retained, not what was handed in.
    expect(payload.inputPreview).not.toContain(SECRET)
    expect(payload.inputSha256).toBe(factPayload(createRuntimeEvent("tool.input.completed", {
      model_request_id: "request-1",
      tool_use: { id: "tool-1", name: "memory", provider_call_id: "call-1", provider_tool_name: "memory", executable_tool_name: "memory", input: { action: "add", content: REDACTED }, execution: EXECUTION },
    })).inputSha256)
  })

  test("redacts the input of a call that failed validation", () => {
    const event = createRuntimeEvent("tool.validation.failed", {
      tool_use_id: "tool-1",
      tool_name: "skill_manage",
      input: { action: "save", body: SECRET },
      reason: "body is required",
      execution: EXECUTION,
    })

    expect(factPayload(event).input).toEqual({ action: "save", body: REDACTED })
  })
})
