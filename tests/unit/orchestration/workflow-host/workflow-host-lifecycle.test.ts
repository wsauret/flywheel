import { describe, expect, it } from "bun:test"
import { composeWorkflowHostLifecycle } from "../../../../src/orchestration/workflow-host/lifecycle.js"
import { createMemoryStore, initialFacts, testHost } from "../../workflows/vm/host-test-support.js"

describe("workflow host lifecycle", () => {
  it("composes production resource disposal in host order and aggregates failures", async () => {
    const order: string[] = []
    const lifecycle = composeWorkflowHostLifecycle({
      drainEventBus: async () => { order.push("event bus"); throw new Error("bus failed") },
      drainWriter: async () => { order.push("writer"); throw new Error("writer failed") },
      disposeProjections: () => { order.push("projections") },
    }, {
      flushConversation: () => { order.push("conversation") },
      settleBackground: () => { order.push("background") },
      disposeAdapters: () => { order.push("adapter") },
      disposeRemaining: () => { order.push("scope") },
    })
    const host = testHost(createMemoryStore(initialFacts()), { lifecycle })

    const result = await host.dispose()

    expect(order).toEqual(["conversation", "background", "event bus", "writer", "projections", "adapter", "scope"])
    expect(result).toMatchObject({
      kind: "failed",
      failure: {
        operation: "dispose",
        failures: ["event bus drain: bus failed", "writer drain: writer failed"],
      },
    })
  })
})
