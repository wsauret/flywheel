import { describe, expect, it } from "bun:test";
import { resolveSubagentRole } from "../../../../src/orchestration/config/role-selection.js";
import { validateRoleIds, isKnownRoleId } from "../../../../src/orchestration/config/roles.js"

// ---------------------------------------------------------------------------
// Known role discovery with custom persona roles (T4)
// ---------------------------------------------------------------------------

describe("known role discovery", () => {
  it("accepts a custom persona role as a known role", () => {
    expect(isKnownRoleId("reviewer")).toBe(true);
    expect(isKnownRoleId("implementer")).toBe(true);
  });

  it("still prunes unknown non-persona roles", () => {
    const unknowns = validateRoleIds(["reviewer", "bogus-nonexistent-role"]);
    expect(unknowns).not.toContain("reviewer");
    expect(unknowns).toContain("bogus-nonexistent-role");
  });

  it("accepts a step-agent slot using a discovered persona role", () => {
    expect(isKnownRoleId("brief.implement.persona.reviewer")).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// Subagent role resolution (Phase 2)
// ---------------------------------------------------------------------------

describe("resolveSubagentRole", () => {
  it("ignores runtime and binding aliases", () => {
    const roles = new Map([
      ["reviewer", { roleId: "reviewer", model: "claude-haiku-4-5", effort: "low" }],
      ["brief.plan-review.persona.reviewer", { roleId: "brief.plan-review.persona.reviewer", model: "claude-sonnet-4-6", effort: "medium" }],
      ["brief.rt-plan-review.persona.reviewer", { roleId: "brief.rt-plan-review.persona.reviewer", model: "claude-opus-4-6", effort: "high" }],
    ]);
    const result = resolveSubagentRole("reviewer", { briefId: "fly.plan-review" }, roles);
    expect(result?.model).toBe("claude-haiku-4-5");
  });

  it("returns undefined when no role exists at any level", () => {
    const roles = new Map();
    const result = resolveSubagentRole("reviewer", { briefId: "fly.plan-review" }, roles);
    expect(result).toBeUndefined();
  });

});

