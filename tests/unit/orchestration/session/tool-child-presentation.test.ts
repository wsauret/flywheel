import { describe, expect, it } from "bun:test"
import { projectHistoricalContainerChild, projectHistoricalExecuteChild } from "../../../../src/orchestration/session/tool-child-presentation.js"
import type { ToolExecutionEntry } from "../../../../src/orchestration/session/tool-execution-types.js"

const call: ToolExecutionEntry = {
  toolUseId: "toolu_child", toolName: "read", status: "completed", resultOutcome: "ok", executionMode: "foreground", traceKind: "tool",
  childHasOwnViewport: false, calledAt: 1_000, completedAt: 2_400, input: { path: "a.ts" },
}

describe("historical child rows", () => {
  // A reopened card states when each child returned, as the live row of the same call does.
  it("state when a call returned from its result, and nothing while it runs", () => {
    expect(projectHistoricalContainerChild(call, "/workspace", undefined)).toMatchObject({ timestamp: 1_000, settledAt: 2_400 })
    expect(projectHistoricalExecuteChild(call, "/workspace", undefined, "a")).toMatchObject({ timestamp: 1_000, settledAt: 2_400 })
    const running: ToolExecutionEntry = { ...call, status: "called", resultOutcome: undefined, completedAt: undefined }
    expect(projectHistoricalContainerChild(running, "/workspace", undefined)).not.toHaveProperty("settledAt")
  })
})
