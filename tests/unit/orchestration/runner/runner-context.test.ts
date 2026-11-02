import { describe, expect, it } from "bun:test"
import type { Agent } from "../../../../src/orchestration/agent-runtime/types.js"
import { createAgentHost } from "../../../../src/orchestration/runner/host.js"

describe("runner host identity", () => {
  it("publishes the runner it owns without a forwarding wrapper", async () => {
    const runner: Agent = {
      send(): void {},
      abort(): void {},
      end(): void {},
      done: Promise.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } }),
    }
    let published: Agent | undefined
    // The host is generic over its context-options shape; this runner ignores them.
    const host = createAgentHost<{ readonly model: string }>({ createRunner: () => runner })

    await host.runTurn({
      createContextOptions: () => ({ model: "test" }),
      onContextCreated: (context) => { published = context },
      message: "hello",
      resilience: {},
    })

    expect(published).toBe(runner)
  })
})
