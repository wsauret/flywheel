import { describe, it, expect } from "bun:test"
import { formatStdinInput } from "../src/orchestration/engines/providers/claude/subprocess/stdin-format.js"
import type { UserEventToolResult } from "../src/infra/ndjson-event-types.js"

describe("formatStdinInput", () => {
  it("string input produces user message NDJSON", () => {
    const result = formatStdinInput("hello world")
    const parsed = JSON.parse(result.trim())
    expect(parsed).toEqual({
      type: "user",
      message: { role: "user", content: "hello world" },
    })
  })

  it("string output ends with newline", () => {
    const result = formatStdinInput("test")
    expect(result.endsWith("\n")).toBe(true)
  })

  it("UserEventToolResult input produces tool_result NDJSON", () => {
    const toolResult: UserEventToolResult = {
      type: "tool_result",
      tool_use_id: "toolu_abc123",
      content: "The answer is 42",
    }
    const result = formatStdinInput(toolResult)
    const parsed = JSON.parse(result.trim())
    expect(parsed).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_abc123", content: "The answer is 42" }],
      },
    })
  })

  it("UserEventToolResult with is_error flag", () => {
    const toolResult: UserEventToolResult = {
      type: "tool_result",
      tool_use_id: "toolu_xyz",
      content: "User cancelled",
      is_error: true,
    }
    const result = formatStdinInput(toolResult)
    const parsed = JSON.parse(result.trim())
    expect(parsed.message.content[0].is_error).toBe(true)
    expect(parsed.message.content[0].content).toBe("User cancelled")
  })

  it("UserEventToolResult output ends with newline", () => {
    const toolResult: UserEventToolResult = {
      type: "tool_result",
      tool_use_id: "toolu_test",
      content: "result",
    }
    const result = formatStdinInput(toolResult)
    expect(result.endsWith("\n")).toBe(true)
  })
})
