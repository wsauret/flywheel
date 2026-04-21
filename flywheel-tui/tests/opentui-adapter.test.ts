import { afterEach, describe, expect, it } from "bun:test"
import { EventBus, createEmit } from "../src/infra/event-bus"
import { createNDJSONEvent } from "../src/infra/ndjson-event-factory"
import type { AnyBlock } from "../src/infra/output-blocks"
import type { WorkflowSessionEntry } from "../src/orchestration/session-store-types"
import { OpenTUIAdapter } from "../src/tui/adapters/opentui"

describe("OpenTUIAdapter", () => {
  let adapter: OpenTUIAdapter | null = null

  afterEach(() => {
    adapter?.disconnect()
    adapter = null
  })

  it("resolves pending workflow messages on user ndjson echoes", async () => {
    const bus = new EventBus()
    const emit = createEmit(bus)
    const patches: Array<Partial<WorkflowSessionEntry>> = []

    adapter = new OpenTUIAdapter({
      updateEntry: (patch) => patches.push(patch),
    })
    adapter.connect(bus)

    emit("engine:injected", {
      workflowId: "wf-1",
      message: "follow up",
      origin: "user",
      pending: true,
    })
    await Promise.resolve()

    emit("engine:ndjson", {
      workflowId: "wf-1",
      ndjsonEvent: createNDJSONEvent("user", {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "text", text: "follow up" }],
        },
      }),
    })
    await Promise.resolve()

    const blockPatch = patches.filter((p) => p.outputBlocks !== undefined).pop()
    expect(blockPatch).toBeDefined()

    const blocks = blockPatch!.outputBlocks as AnyBlock[]
    const userBlock = blocks.find((b) => b.kind === "userMessage")
    expect(userBlock).toBeDefined()
    expect((userBlock as Extract<AnyBlock, { kind: "userMessage" }>).pending).toBe(false)
  })
})
