import { describe, expect, it } from "bun:test";
import { slotLabel, roleSlot } from "../../../../src/orchestration/config/role-selection.js";
import { parseBriefRoleId, briefPersonaRoleId, briefFixedRoleId } from "../../../../src/protocol/brief-role-id.js";

// ---------------------------------------------------------------------------
// Brief seats of the agents of a workflow
// ---------------------------------------------------------------------------

describe("brief seats", () => {
  it("parses brief and record selectors without changing local names", () => {
    expect(parseBriefRoleId("brief.implement")).toEqual({ briefId: "implement" });
    expect(parseBriefRoleId("brief.fly.spec-create")).toEqual({ briefId: "fly.spec-create" });
    expect(parseBriefRoleId("brief.workflow.review_a")).toEqual({ briefId: "workflow.review_a" });
    for (const fixed of ["both", "model", "effort"] as const) {
      expect(parseBriefRoleId(briefFixedRoleId("workflow.review_a", "review_a", fixed)))
        .toEqual({ briefId: "workflow.review_a", definitionId: "review_a", fixed });
    }
  });

  it("parses a persona seat into the brief and the persona role", () => {
    expect(parseBriefRoleId("brief.implement.persona.reviewer")).toEqual({ briefId: "implement", personaRole: "reviewer" });
    expect(parseBriefRoleId("brief.fly.spec-create.persona.reviewer")).toEqual({ briefId: "fly.spec-create", personaRole: "reviewer" });
    expect(parseBriefRoleId(briefPersonaRoleId("workflow.review_a", "reviewer"))).toEqual({ briefId: "workflow.review_a", personaRole: "reviewer" });
  });

  it("is no brief selector when the selector names no brief id or no qualified persona role", () => {
    for (const roleId of ["chat", "brief.", "brief.Implement", "brief.imp lement", "brief..implement", "brief.implement.persona.", "brief.implement.persona.Reviewer", "step.implement", "step.implement.agent.reviewer"]) {
      expect(parseBriefRoleId(roleId)).toBeUndefined();
    }
  });

});

// ---------------------------------------------------------------------------
// Persona seats under a brief
// ---------------------------------------------------------------------------

describe("persona seats under a brief", () => {
  it("slotLabel for a persona seat returns a human-readable label", () => {
    const slot = roleSlot("brief.plan-review.persona.reviewer");
    const label = slotLabel(slot);
    expect(label).toContain("Plan Review");
    expect(label).toContain("Reviewer");
  });

});
