import { describe, expect, test } from "bun:test"
import { createContextTokenAnchor, type OutgoingContextSnapshot } from "../../../../../src/orchestration/agent-runtime/context-token-anchor"
import { FUNCTION_TOOL_PRESENTATION, type ServingAttempt } from "../../../../../src/orchestration/agent-runtime/llm/types"

const attempt: ServingAttempt = {
  accessProvider: "anthropic_api",
  modelFamily: "anthropic",
  model: "test",
  toolPresentation: FUNCTION_TOOL_PRESENTATION,
  contextLimit: 100_000,
  outputLimit: 8_000,
  supportsReasoning: false,
  promptNotes: { progress: "", modelNotes: "" },
  priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" } as const),
}

describe("context token anchor", () => {
  test("tracks a live system-prompt token delta before and after provider usage", () => {
    let current: OutgoingContextSnapshot = { staticTokens: 100, messageTokens: 10, anchorKey: "anthropic:test:a" }
    const anchor = createContextTokenAnchor({
      attempt: () => attempt,
      current: () => current,
      onEvent: () => {},
    })

    expect(anchor.estimate()).toBe(110)

    anchor.observeApiUsage(
      { inputTokens: 180, cacheReadTokens: 20, cacheWriteTokens: 0 },
      { staticTokens: 100, messageTokens: 10, anchorKey: "anthropic:test:a" },
    )
    current = { staticTokens: 100, messageTokens: 15, anchorKey: "anthropic:test:a" }
    expect(anchor.estimate()).toBe(205)
    expect(anchor.estimateInputTokenClasses()).toEqual({ uncachedInputTokens: 185, cacheTokens: 20 })

    current = { staticTokens: 130, messageTokens: 15, anchorKey: "anthropic:test:a" }
    expect(anchor.estimate()).toBe(235)

    anchor.reset()
    expect(anchor.estimate()).toBe(145)
  })

  test("keeps the estimate non-negative when a capability reduction shrinks the system prompt", () => {
    let current: OutgoingContextSnapshot = { staticTokens: 5_000, messageTokens: 10, anchorKey: "anthropic:test:a" }
    const anchor = createContextTokenAnchor({
      attempt: () => attempt,
      current: () => current,
      onEvent: () => {},
    })

    anchor.observeApiUsage(
      { inputTokens: 4_980, cacheReadTokens: 20, cacheWriteTokens: 0 },
      { staticTokens: 5_000, messageTokens: 10, anchorKey: "anthropic:test:a" },
    )

    current = { staticTokens: 100, messageTokens: 10, anchorKey: "anthropic:test:a" }
    expect(anchor.estimate()).toBe(100)
    expect(anchor.estimateInputTokenClasses()).toEqual({ uncachedInputTokens: 80, cacheTokens: 20 })

    current = { staticTokens: 100, messageTokens: 40, anchorKey: "anthropic:test:a" }
    expect(anchor.estimate()).toBe(130)
  })

  test("applies the non-negative invariant after negative message growth", () => {
    const current: OutgoingContextSnapshot = { staticTokens: 100, messageTokens: 100, anchorKey: "anthropic:test:a" }
    const anchor = createContextTokenAnchor({
      attempt: () => attempt,
      current: () => current,
      onEvent: () => {},
    })

    anchor.observeApiUsage(
      { inputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { staticTokens: 100, messageTokens: 1_000, anchorKey: "anthropic:test:a" },
    )

    expect(anchor.estimate()).toBe(0)
  })

  test("anchors usage to the sent request before later tool output growth", () => {
    const sent = { staticTokens: 100, messageTokens: 20, anchorKey: "anthropic:test:a" }
    let current = sent
    const anchor = createContextTokenAnchor({ attempt: () => attempt, current: () => current, onEvent: () => {} })
    anchor.observeApiUsage({ inputTokens: 180, cacheReadTokens: 10, cacheWriteTokens: 10 }, sent)
    current = { ...sent, messageTokens: 70 }
    expect(anchor.estimate()).toBe(250)
  })

  test.each([
    ["Anthropic", "anthropic:test:a", 100, 1_000, 800, 100],
    ["OpenAI", "openai:test:a", 100, 1_000, 800, 100],
    ["Google", "google:test:a", 100, 1_000, 800, 100],
    ["cached Copilot", "copilot:test:a", 50_000, 4, 228_337, 1_490],
  ] as const)("adds separately reported cache classes to canonical %s uncached input", (_provider, anchorKey, staticTokens, inputTokens, cacheReadTokens, cacheWriteTokens) => {
    const sent: OutgoingContextSnapshot = { staticTokens, messageTokens: 20, anchorKey }
    let current = sent
    const anchor = createContextTokenAnchor({ attempt: () => attempt, current: () => current, onEvent: () => {} })
    anchor.observeApiUsage({ inputTokens, cacheReadTokens, cacheWriteTokens }, sent)
    const cacheTokens = cacheReadTokens + cacheWriteTokens

    expect(anchor.estimateInputTokenClasses()).toEqual({ uncachedInputTokens: inputTokens, cacheTokens })
    expect(anchor.estimate()).toBe(inputTokens + cacheTokens)

    current = { ...sent, messageTokens: 50 }
    expect(anchor.estimateInputTokenClasses()).toEqual({ uncachedInputTokens: inputTokens + 30, cacheTokens })
    expect(anchor.estimate()).toBe(inputTokens + cacheTokens + 30)
    current = { ...sent, staticTokens: staticTokens + 40, messageTokens: 50 }
    expect(anchor.estimate()).toBe(inputTokens + cacheTokens + 70)
    current = { ...sent, messageTokens: -inputTokens - cacheTokens }
    expect(anchor.estimate()).toBe(0)
  })

  test("does not reuse a provider anchor for a different prepared candidate", () => {
    const anchor = createContextTokenAnchor({ attempt: () => attempt, current: () => ({ staticTokens: 300, messageTokens: 40, anchorKey: "openai:fallback:b" }), onEvent: () => {} })
    const sent = { staticTokens: 100, messageTokens: 20, anchorKey: "anthropic:test:a" }
    anchor.observeApiUsage({ inputTokens: 180, cacheReadTokens: 10, cacheWriteTokens: 10 }, sent)
    expect(anchor.estimate()).toBe(340)
    expect(anchor.estimateInputTokenClasses()).toEqual({ uncachedInputTokens: 340, cacheTokens: 0 })
  })
})
