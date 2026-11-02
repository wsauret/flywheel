import { describe, expect, it } from "bun:test"
import { EventBus, createEmit } from "../../../../src/infra/event-bus"
import { createChatSession } from "../../../../src/orchestration/chat/session"
import { captureBlocks, createTestChatSessionDeps } from "./_chat-session-agent-runtime-fixtures"

async function setup(percentRef: { percent: number }) {
  const eventBus = new EventBus()
  const { updateEntry, blocks } = captureBlocks()
  const session = await createChatSession({ onError: () => {}, onEnded: () => {} }, createTestChatSessionDeps({
    sessionId: "chat-context-warning",
    createAgent: () => { throw new Error("no runner needed") },
    eventBus,
    updateEntry,
  }))
  const emitMetrics = async () => {
    createEmit(eventBus)("budget.metrics.changed", {
      sessionId: "chat-context-warning",
      data: { tokens: 1, cost: 0, billedCost: 0, priceUnavailable: false, contextPercent: percentRef.percent, contextPromptTokens: percentRef.percent * 1000 },
    })
    await eventBus.drain()
  }
  const warningBlocks = () => blocks().filter((b) => b.kind === "system")
  return { session, emitMetrics, warningBlocks }
}

describe("chat context growth on budget.metrics.changed", () => {
  it("does not add a conversation restart warning when utilization grows", async () => {
    const percentRef = { percent: 42 }
    const { session, emitMetrics, warningBlocks } = await setup(percentRef)
    await emitMetrics()
    percentRef.percent = 73
    await emitMetrics()
    expect(warningBlocks()).toHaveLength(0)

    percentRef.percent = 90
    await emitMetrics()
    expect(warningBlocks()).toHaveLength(0)
    await session.dispose()
  })
})
