import { describe, expect, test } from "bun:test"

import { agentGroupActiveParts, agentGroupModelLabel } from "../../../../src/protocol/client/agent-group-summary.js"

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

describe("agentGroupActiveParts", () => {
  const now = 1_000_000
  const running = { label: "Explorer", description: "Read files", containerKind: "subagent" as const, totalToolCount: 0, status: "active" as const, timestamp: now - 3_600_000, duration: 7000 }

  test("a running card whose child's clock is stopped states the settled active time, never the time since launch", () => {
    expect(agentGroupActiveParts(running, now)).toEqual(["Read files", "7s"])
  })

  test("a running card adds the open episode to the settled active time", () => {
    expect(agentGroupActiveParts({ ...running, activeStartedAt: now - 3000 }, now)).toEqual(["Read files", "10s"])
  })
})
