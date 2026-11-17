import { describe, expect, test } from "bun:test"

import { agentGroupModelLabel } from "../../../../src/protocol/client/agent-group-summary.js"

describe("agentGroupModelLabel", () => {
  test("keeps the recorded launch label while the child has no serving reading", () => {
    expect(agentGroupModelLabel("gpt-6-astra high", undefined)).toBe("gpt-6-astra high")
    expect(agentGroupModelLabel("old high", {
      assignments: { chat: { model: "wrong", effort: "low" } },
      serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "persona", effort: "high" } },
    })).toBe("persona high")
    expect(agentGroupModelLabel("old high", { assignments: {}, serving: { slot: { kind: "role", roleId: "chat" } } })).toBe("old high")
  })
})
