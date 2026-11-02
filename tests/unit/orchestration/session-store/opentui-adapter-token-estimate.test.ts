import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { EventBus, createEmit } from "../../../../src/infra/event-bus.js"
import { createRuntimeEvent } from "../../../../src/infra/runtime-event-factory.js"
import type { RuntimeEvent } from "../../../../src/infra/runtime-event-types.js"
import type { ChatEntryPatch } from "../../../../src/orchestration/session-store/types.js"
import { SessionEventAdapter } from "../../../../src/orchestration/session-store/event-adapter.js"
import { createOutputSession } from "../../../../src/orchestration/runner/output-session.js"

type Emit = ReturnType<typeof createEmit>

function emitRuntime(emit: Emit, sessionId: string, event: RuntimeEvent): void {
  emit(event.type, { sessionId, data: event.data })
}

describe("SessionEventAdapter token estimate", () => {
  let adapter: SessionEventAdapter | null = null

  afterEach(() => {
    adapter?.disconnect()
    adapter = null
  })

  const publishedChars = (patches: readonly ChatEntryPatch[]): number | undefined =>
    patches.map((patch) => patch.streamingOutputChars).filter((chars) => chars !== undefined).at(-1)

  it("keeps status token estimate cumulative across tool-result user events", () => {
    // A live stream's events arrive more than one 16 ms store frame apart, so
    // each one syncs the store as it lands. The case steps a frozen clock one
    // frame before each event, so that timing does not depend on how fast
    // this process runs.
    let now = 1_000
    const clock = spyOn(performance, "now").mockImplementation(() => now)
    const nextFrame = (): void => { now += 20 }
    try {
      const bus = new EventBus()
      const emit = createEmit(bus)
      const patches: ChatEntryPatch[] = []

      const push = (patch: ChatEntryPatch) => { patches.push(patch) }
      adapter = new SessionEventAdapter({ updateEntry: push, outputSession: createOutputSession({ executionCwd: "/workspace", updateEntry: push }) })
      adapter.connect(bus)

      nextFrame()
      emitRuntime(emit, "wf-1", createRuntimeEvent("model.content.delta", {
          type: "model.content.delta",
          delta: { type: "text_delta", text: "before" },
          block_key: "answer",
        }))
      adapter.flush()
      expect(publishedChars(patches)).toBe(6)

      nextFrame()
      emitRuntime(emit, "wf-1", createRuntimeEvent("model.user_message.recorded", {
          type: "model.user_message.recorded",
          message: {
            content: [
              {
                type: "tool.result.recorded",
                tool_use_id: "tool-1",
                content: [{ type: "text", text: "ok" }],
              },
            ],
          },
        }))
      adapter.flush()
      expect(publishedChars(patches)).toBe(6)

      nextFrame()
      emitRuntime(emit, "wf-1", createRuntimeEvent("model.content.delta", {
          type: "model.content.delta",
          delta: { type: "text_delta", text: "after" },
          block_key: "answer",
        }))
      adapter.flush()
      // The phase change into thinking publishes the count the generating
      // phase ended on plus the thinking text of the event that changed it:
      // cumulative across the tool result.
      nextFrame()
      emitRuntime(emit, "wf-1", createRuntimeEvent("model.content.delta", {
          type: "model.content.delta",
          delta: { type: "thinking_delta", thinking: "hm" },
          block_key: "thinking",
        }))
      adapter.flush()
      expect(publishedChars(patches)).toBe(13)
    } finally {
      clock.mockRestore()
    }
  })

  it("resets status token estimate from logical turn lifecycle, not user-message runtime event", () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: ChatEntryPatch[] = []

    const push = (patch: ChatEntryPatch) => { patches.push(patch) }
    adapter = new SessionEventAdapter({ updateEntry: push, outputSession: createOutputSession({ executionCwd: "/workspace", updateEntry: push }) })
    adapter.connect(bus)

    emitRuntime(emit, "wf-1", createRuntimeEvent("model.content.delta", {
        type: "model.content.delta",
        delta: { type: "text_delta", text: "before" },
        block_key: "answer",
      }))
    adapter.flush()
    expect(publishedChars(patches)).toBe(6)

    emitRuntime(emit, "wf-1", createRuntimeEvent("model.user_message.recorded", {
        type: "model.user_message.recorded",
        message: {
          content: [{ type: "text", text: "follow up" }],
        },
      }))
    adapter.flush()
    expect(publishedChars(patches)).toBe(6)

    emit("agent.logical_turn.started", {
      sessionId: "wf-1",
      data: { origin: "user", reason: "queued_input" },
    })
    adapter.flush()
    expect(publishedChars(patches)).toBe(0)
  })
})
