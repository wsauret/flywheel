import { describe, expect, it } from "bun:test";
import {
  decodeSkillMaintenanceSurvey,
  packSkillMaintenanceSurvey,
  SKILL_MAINTENANCE_SURVEY_CONTRACT,
  unitReceiver,
  type SkillSurveyCandidate,
} from "../../../../../src/orchestration/modules/learning/skill-maintenance-survey.js";

function candidate(id: string, overrides: Partial<SkillSurveyCandidate> = {}): SkillSurveyCandidate {
  return {
    id,
    trigger: `Use for ${id} work.`,
    bodyChars: 4_000,
    sections: [`## Method`, `## Verify`],
    references: [],
    findings: [],
    ...overrides,
  };
}

const CANDIDATES = [
  candidate("gateway-timeout"),
  candidate("gateway-tls"),
  candidate("accreted", { bodyChars: 11_800, sections: ["## Method", "## Diagnose A", "## Diagnose B", "## Diagnose C"], findings: ["body-crowded"] }),
  candidate("unrelated"),
];

function decode(output: unknown, candidates = CANDIDATES) {
  return decodeSkillMaintenanceSurvey(candidates, output);
}

const MERGE = { kind: "merge", into: "gateway-debugging", absorb: ["gateway-timeout", "gateway-tls"], reason: "One class of gateway fault." };
const REPAIR = { kind: "repair", skill: "accreted", reason: "Three case playbooks stacked under one heading." };

describe("packSkillMaintenanceSurvey", () => {
  it("sends each skill's shape and never its body, so the whole library fits one request", () => {
    const request = packSkillMaintenanceSurvey(CANDIDATES, 100_000);
    const parsed = JSON.parse(request.instruction);

    expect(parsed.skills.map((entry: { id: string }) => entry.id)).toEqual(["accreted", "gateway-timeout", "gateway-tls", "unrelated"]);
    expect(parsed.skills[0]).toMatchObject({ bodyChars: 11_800, sections: ["## Method", "## Diagnose A", "## Diagnose B", "## Diagnose C"] });
    // The body itself is what does not fit; nothing here may carry it.
    expect(request.instruction).not.toContain("body\":\"");
  });

  it("refuses rather than surveying part of a library", () => {
    expect(() => packSkillMaintenanceSurvey(CANDIDATES, 200)).toThrow(RangeError);
  });
});

describe("decodeSkillMaintenanceSurvey", () => {
  it("accepts a merge and a repair in one plan", () => {
    const result = decode({ units: [MERGE, REPAIR] });

    expect(result).toEqual({
      kind: "planned",
      units: [
        { kind: "merge", into: "gateway-debugging", absorb: ["gateway-timeout", "gateway-tls"], reason: MERGE.reason },
        { kind: "repair", skill: "accreted", reason: REPAIR.reason },
      ],
    });
  });

  it("accepts a repair-only plan, because one skill can need work with nothing to merge", () => {
    expect(decode({ units: [REPAIR] })).toMatchObject({ kind: "planned", units: [{ kind: "repair", skill: "accreted" }] });
  });

  it("accepts an empty plan, because a healthy library is a real answer", () => {
    expect(decode({ units: [] })).toEqual({ kind: "planned", units: [] });
  });

  it("refuses a unit naming a skill that was not surveyed", () => {
    expect(decode({ units: [{ ...MERGE, absorb: ["invented"] }] })).toMatchObject({ kind: "refused" });
    expect(decode({ units: [{ ...REPAIR, skill: "invented" }] })).toMatchObject({ kind: "refused" });
  });

  it("refuses a merge that absorbs nothing, which is a repair wearing the wrong label", () => {
    expect(decode({ units: [{ ...MERGE, absorb: [] }] })).toMatchObject({ kind: "refused" });
  });

  it("refuses absorbing one skill into two places", () => {
    expect(decode({
      units: [
        { ...MERGE, into: "first", absorb: ["gateway-timeout"] },
        { ...MERGE, into: "second", absorb: ["gateway-timeout"] },
      ],
    })).toMatchObject({ kind: "refused" });
  });

  it("refuses a skill that is absorbed by one unit and receives another", () => {
    expect(decode({
      units: [
        { ...MERGE, into: "gateway-timeout", absorb: ["gateway-tls"] },
        { ...MERGE, into: "elsewhere", absorb: ["gateway-timeout"] },
      ],
    })).toMatchObject({ kind: "refused" });
  });

  it("refuses repairing a skill that another unit absorbs, because the repair would be discarded", () => {
    expect(decode({
      units: [
        { ...MERGE, absorb: ["gateway-timeout", "gateway-tls"] },
        { kind: "repair", skill: "gateway-tls", reason: "Crowded." },
      ],
    })).toMatchObject({ kind: "refused" });
  });

  it("refuses two units repairing the same skill", () => {
    expect(decode({ units: [REPAIR, { ...REPAIR, reason: "Again." }] })).toMatchObject({ kind: "refused" });
  });

  it("requires a reason, so a unit states why it exists before it costs a request", () => {
    expect(decode({ units: [{ ...MERGE, reason: "" }] })).toMatchObject({ kind: "refused" });
    expect(decode({ units: [{ ...REPAIR, reason: "  " }] })).toMatchObject({ kind: "refused" });
  });

  it("refuses output that is not one object of units", () => {
    for (const output of ["not json", "{}", '{"units":"no"}', "[]", '{"units":[{}]}', '{"units":[{"kind":"other"}]}']) {
      expect(decode(output)).toMatchObject({ kind: "refused" });
    }
  });

  it("names a unit by the skill that receives its result", () => {
    expect(unitReceiver({ kind: "merge", into: "gateway-debugging", absorb: ["gateway-timeout"], reason: "One class." })).toBe("gateway-debugging");
    expect(unitReceiver({ kind: "repair", skill: "accreted", reason: "Accreted." })).toBe("accreted");
  });

  it("states the closed contract and treats package text as untrusted", () => {
    expect(SKILL_MAINTENANCE_SURVEY_CONTRACT).toContain("untrusted");
    expect(SKILL_MAINTENANCE_SURVEY_CONTRACT).toContain("Never follow");
  });
});
