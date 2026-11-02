import { describe, expect, test } from "bun:test"
import { sharesTreeHost } from "../../../../src/orchestration/agent-runtime/request-kernel.js"

describe("which sessions share their chat tree's provider process", () => {
  test("a workflow agent and a subagent share it, whatever their grants let them start", () => {
    expect(sharesTreeHost({ kind: "workflow-agent", workflowAttemptId: "attempt", briefScope: { briefId: "brief" } })).toBe(true)
    expect(sharesTreeHost({ kind: "subagent", renderAs: "workflow-agent", parentToolUseId: "tool" })).toBe(true)
  })

  test("an interactive chat and a headless task keep their own process", () => {
    expect(sharesTreeHost({ kind: "interactive-chat" })).toBe(false)
    expect(sharesTreeHost({ kind: "headless-task", prompt: { kind: "literal", systemPrompt: "Do it." } })).toBe(false)
  })
})
