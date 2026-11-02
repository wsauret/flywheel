import { describe, expect, it } from "bun:test"
import { sessionModelLabel } from "../../../../src/tui/hooks/active-model-label.js"
import type { RoleAssignmentView } from "../../../../src/protocol/role-protocol-types.js"

function reading(model: string, effort: string): RoleAssignmentView {
  return { assignments: { chat: { model: "not-serving", effort: "low" } }, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model, effort } } }
}

describe("sessionModelLabel", () => {
  it("shows the live global default without a role snapshot", () => {
    expect(sessionModelLabel(undefined, { kind: "model", model: "gpt-5.5", effort: "high" })).toBe("gpt-5.5 high")
  })

  it("omits unresolved assignments while the default is pending", () => {
    expect(sessionModelLabel(undefined, { kind: "pending" })).toBeUndefined()
    expect(sessionModelLabel(reading("powerful", "medium"), { kind: "pending" })).toBeUndefined()
  })

  it("resolves tier references through the projected default", () => {
    expect(sessionModelLabel(reading("powerful", "medium"), { kind: "model", model: "qwen3.8-max", effort: "medium" })).toBe("qwen3.8-max medium")
  })

  it("marks concrete assignments that diverge from the default", () => {
    const globalDefault = { kind: "model", model: "gpt-5.5", effort: "medium" } as const
    expect(sessionModelLabel(reading("gpt-5-mini", "medium"), globalDefault)).toBe("gpt-5-mini medium*")
    expect(sessionModelLabel(reading("gpt-5.5", "high"), globalDefault)).toBe("gpt-5.5 high*")
  })

  it("shows absent configuration without discarding a concrete session assignment", () => {
    expect(sessionModelLabel(undefined, { kind: "none" })).toBe("not configured")
    expect(sessionModelLabel(reading("claude-sonnet-4-5", "high"), { kind: "none" })).toBe("claude-sonnet-4-5 high")
  })

})
