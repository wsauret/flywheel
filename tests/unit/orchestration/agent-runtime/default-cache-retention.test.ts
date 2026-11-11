import { describe, expect, test } from "bun:test"
import { defaultCacheRetention } from "../../../../src/orchestration/agent-runtime/request-kernel.js"
import { resolveCacheRetention } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import type { AgentPurpose } from "../../../../src/orchestration/agent-runtime/types.js"

const prompt = { kind: "literal", systemPrompt: "Do it." } as const

// Every purpose kind, with the lifetime that its requests ask for without a provider policy (ARCH-PROVIDERS-078).
const PURPOSES: ReadonlyArray<readonly [AgentPurpose, "5m" | "1h"]> = [
  [{ kind: "interactive-chat" }, "1h"],
  [{ kind: "unattended-chat" }, "1h"],
  [{ kind: "headless-task", prompt }, "1h"],
  [{ kind: "workflow-agent", workflowAttemptId: "attempt", briefScope: { briefId: "brief" } }, "5m"],
  [{ kind: "workflow-follow-up" }, "5m"],
  [{ kind: "subagent", renderAs: "subagent", parentToolUseId: "tool" }, "5m"],
  [{ kind: "chat-learning-review", review: { reviewRunId: "review" } }, "5m"],
  [{ kind: "learning-review-audit", prompt }, "5m"],
  [{ kind: "session-title", prompt }, "5m"],
  [{ kind: "chat-side-call" }, "5m"],
  [{ kind: "subagent-failure-summary", prompt }, "5m"],
  [{ kind: "chat-routing-benchmark" }, "5m"],
  [{ kind: "persona-benchmark" }, "5m"],
]

describe("the prompt-cache lifetime that a session's purpose asks for", () => {
  test.each(PURPOSES)("%o asks for %s", (purpose, lifetime) => {
    expect(defaultCacheRetention(purpose)).toBe(lifetime)
  })

  test.each(PURPOSES)("a provider policy replaces the lifetime of %o, and an uncached request stays uncached", (purpose, lifetime) => {
    const cacheRetention = defaultCacheRetention(purpose)
    expect(resolveCacheRetention("anthropic_api", { cacheRetention })).toBe(lifetime)
    for (const policy of ["5m", "1h"] as const) {
      expect(resolveCacheRetention("anthropic_api", { cacheRetention, cacheRetentionPolicies: { anthropic_api: policy } })).toBe(policy)
      expect(resolveCacheRetention("anthropic_api", { cacheRetention: "none", cacheRetentionPolicies: { anthropic_api: policy } })).toBe("none")
    }
  })
})
