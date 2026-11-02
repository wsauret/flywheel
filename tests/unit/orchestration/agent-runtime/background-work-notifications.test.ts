import { describe, expect, it } from "bun:test"

import {
  childSessionBackgroundResult,
  formatStandaloneNotification,
  formatSubagentNotificationBatch,
} from "../../../../src/orchestration/agent-runtime/background-work-notifications.js"

describe("subagent completion notifications", () => {
  it("prints a partial status verbatim and tells the parent what it means", () => {
    const text = formatSubagentNotificationBatch([{
      meta: { type: "subagent", description: "audit the parser", toolUseId: "tu-1" },
      result: { status: "partial", content: "{\"summary\":\"half\"}", usage: { totalTokens: 10, toolUses: 2, durationMs: 5 } },
    }], 0)
    expect(text).toContain("<status>partial</status>")
    expect(text).toContain("stopped at its turn budget")
  })

  it("leaves the guidance out of a batch with no partial result", () => {
    const text = formatSubagentNotificationBatch([{
      meta: { type: "subagent", description: "audit the parser" },
      result: { status: "completed", content: "done" },
    }], 0)
    expect(text).toContain("<status>completed</status>")
    expect(text).not.toContain("turn budget")
  })

  it("carries a durable partial run through to the parent unchanged", () => {
    const result = childSessionBackgroundResult({
      status: "partial", agentType: "general", description: "audit", result: "half", totalTokens: 1, toolUses: 1, durationMs: 1,
    })
    expect(result.status).toBe("partial")
    expect(result.content).toBe("half")
  })

  // A notification reaches a root chat and a child alike. It says "ask the
  // person" and names no module tool; the identity section tells a child to
  // message its parent wherever an instruction says to ask the person.
  it("tells the reader to ask the person for a needed decision and names no question tool", () => {
    const batch = formatSubagentNotificationBatch([{ meta: { type: "subagent", description: "audit" }, result: { status: "completed", content: "done" } }], 0)
    const standalone = formatStandaloneNotification({ meta: { type: "background_command", description: "build" }, result: { status: "completed", content: "done" } })
    for (const text of [batch, standalone]) {
      expect(text).toContain("needs a decision from the person, ask the person")
      expect(text).not.toContain("ask_user")
    }
  })
})
