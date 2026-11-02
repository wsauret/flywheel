import { describe, expect, it } from "bun:test";
import { isQualifiedSkillId, normalizeSkillId, requireQualifiedSkillId } from "../../../src/infra/skill-id.js";

describe("qualified skill id", () => {
  it("accepts one-segment package ids and dotted definition ids", () => {
    for (const id of ["fly.implementation-spec", "test-driven-development", "flywheel-uat", "fly.spec-create", "qa.surface-map", "vendor.ci-watch", "a.b.c"]) {
      expect(isQualifiedSkillId(id)).toBe(true);
    }
  });

  it("rejects every malformed id shape", () => {
    for (const id of ["", ".", "Planning", "plan_create", "flywheel..plan", ".flywheel", "flywheel.", "-planning", "flywheel.-plan", "plan create", "plan/create", "flywheel.plan!"]) {
      expect(isQualifiedSkillId(id)).toBe(false);
    }
  });

  it("normalizes case and surrounding whitespace out of an untrusted argument", () => {
    expect(normalizeSkillId(" Fly.Spec-Create ")).toBe("fly.spec-create");
    expect(normalizeSkillId(" Example-Skill ")).toBe("example-skill");
  });

  it("refuses an untrusted argument that is not an id", () => {
    for (const value of [undefined, null, 7, {}, "plan create", "flywheel..plan"]) {
      expect(normalizeSkillId(value)).toBeNull();
    }
  });

  it("names the subject and the id when a Flywheel-owned id is malformed", () => {
    expect(() => requireQualifiedSkillId("Plan Create", "Step id")).toThrow(/^Step id must be a dot-delimited lowercase slug \(\[a-z0-9-\]\): "Plan Create"$/);
    expect(requireQualifiedSkillId("fly.spec-create", "Step id")).toBe("fly.spec-create");
  });
});
