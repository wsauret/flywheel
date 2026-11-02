import { describe, expect, it } from "bun:test";
import {
  decodeSkillUnitResult,
  packSkillUnitRequest,
  skillUnitMutations,
  SKILL_MAINTENANCE_UNIT_CONTRACT,
  type SkillUnitPackage,
} from "../../../../../src/orchestration/modules/learning/skill-maintenance-unit.js";
import type { SkillMaintenanceUnit } from "../../../../../src/orchestration/modules/learning/skill-maintenance-survey.js";

function pkg(id: string, body: string, references: readonly { path: string; content: string }[] = [], dependencies: readonly string[] = []): SkillUnitPackage {
  return { id, trigger: `Use for ${id} work.`, body, dependencies, references, findings: [] };
}

const RECEIVER = pkg("gateway-debugging", "## Method\n\nGeneral.\n\n## Verify\n\nCheck.", [{ path: "references/tls.md", content: "TLS detail." }]);
const ABSORBED = pkg("gateway-timeout", "## Timeouts\n\nTimeout method.");
const MERGE: SkillMaintenanceUnit = { kind: "merge", into: "gateway-debugging", absorb: ["gateway-timeout"], reason: "One class." };
const REPAIR: SkillMaintenanceUnit = { kind: "repair", skill: "gateway-debugging", reason: "Accreted." };

/** A result that keeps every heading and reference the input carried. */
const GOOD_BODY = "## Method\n\nGeneral.\n\n## Verify\n\nCheck.\n\n## Timeouts\n\nTimeout method.\n\nRead `references/tls.md` for TLS detail.";
const GOOD = {
  description: "Use when a gateway fails to serve.",
  body: GOOD_BODY,
  bodyChars: GOOD_BODY.length,
  keep: ["references/tls.md"],
};

function decode(output: unknown, unit = MERGE, packages = [RECEIVER, ABSORBED]) {
  return decodeSkillUnitResult(unit, packages, output);
}

describe("packSkillUnitRequest", () => {
  it("carries only this unit's packages, in full", () => {
    const request = packSkillUnitRequest(MERGE, [RECEIVER, ABSORBED], 100_000);
    const parsed = JSON.parse(request.instruction);

    expect(parsed.unit).toMatchObject({ kind: "merge", into: "gateway-debugging" });
    expect(parsed.packages.map((entry: { id: string }) => entry.id)).toEqual(["gateway-debugging", "gateway-timeout"]);
    expect(parsed.packages[0].references[0].content).toBe("TLS detail.");
  });

  it("refuses a unit whose packages do not fit one request", () => {
    expect(() => packSkillUnitRequest(MERGE, [RECEIVER, ABSORBED], 100)).toThrow(RangeError);
  });
});

describe("decodeSkillUnitResult", () => {
  it("accepts a result that keeps every heading and reference", () => {
    expect(decode(GOOD)).toMatchObject({ kind: "planned", into: "gateway-debugging", absorb: ["gateway-timeout"] });
  });

  it("refuses when a heading the input carried is nowhere in the result", () => {
    const result = decode({ ...GOOD, body: "## Method\n\nGeneral.\n\n## Verify\n\nCheck.\n\nRead `references/tls.md`." });

    expect(result).toMatchObject({ kind: "refused" });
    expect(result).toHaveProperty("error", expect.stringContaining("## Timeouts"));
  });

  it("accepts a vanished heading when the result says it was removed and why", () => {
    const result = decode({
      ...GOOD,
      body: "## Method\n\nGeneral.\n\n## Verify\n\nCheck.\n\nRead `references/tls.md`.",
      removed: [{ what: "## Timeouts", why: "Superseded by the general method." }],
    });

    expect(result).toMatchObject({ kind: "planned" });
  });

  it("counts a heading kept inside a reference file, not only in the body", () => {
    const result = decode({
      ...GOOD,
      body: "## Method\n\nGeneral.\n\n## Verify\n\nCheck.\n\nRead `references/timeouts.md` and `references/tls.md`.",
      write: [{ path: "references/timeouts.md", content: "## Timeouts\n\nTimeout method." }],
    });

    expect(result).toMatchObject({ kind: "planned" });
  });

  it("carries a kept reference over without repeating its bytes", () => {
    const result = decode(GOOD);
    if (result.kind !== "planned") throw new Error("expected planned");

    // The result named the path only; the content comes from the input package.
    expect(result.references).toEqual([{ path: "references/tls.md", content: "TLS detail." }]);
  });

  it("refuses a kept path no package this unit touches carries", () => {
    expect(decode({ ...GOOD, keep: ["references/tls.md", "references/absent.md"] })).toMatchObject({ kind: "refused" });
  });

  it("refuses when a reference the input carried is not in the result", () => {
    const result = decode({ ...GOOD, keep: [] });

    expect(result).toMatchObject({ kind: "refused" });
    expect(result).toHaveProperty("error", expect.stringContaining("references/tls.md"));
  });

  it("refuses when the package shrinks sharply and nothing says why", () => {
    const big = pkg("verbose", `## One\n\n${"word ".repeat(2_000)}\n\n## Two\n\n${"word ".repeat(2_000)}`);
    const result = decodeSkillUnitResult(
      { kind: "repair", skill: "verbose", reason: "Crowded." },
      [big],
      { description: "Use for verbose work.", body: "## One\n\nShort.\n\n## Two\n\nShort.", bodyChars: 25 },
    );

    expect(result).toMatchObject({ kind: "refused" });
    expect(result).toHaveProperty("error", expect.stringContaining("smaller"));
  });

  it("refuses a result that does not state its body length", () => {
    const { bodyChars: _omitted, ...noCount } = GOOD;
    const result = decode(noCount);

    expect(result).toMatchObject({ kind: "refused" });
    expect(result).toHaveProperty("error", expect.stringContaining('"bodyChars"'));
  });

  it("refuses a result that states a body over the budget, even when the body is not", () => {
    const result = decode({ ...GOOD, bodyChars: 13_000 });

    expect(result).toMatchObject({ kind: "refused" });
    expect(result).toHaveProperty("error", expect.stringContaining("You stated a body of 13,000 characters and the limit is 12,000."));
  });

  it("refuses a body over the budget that understates its length, naming both numbers", () => {
    const big = pkg("verbose", `## One\n\n${"word ".repeat(3_000)}`);
    const body = `## One\n\n${"word ".repeat(2_600)}`;
    const result = decodeSkillUnitResult(
      { kind: "repair", skill: "verbose", reason: "Crowded." },
      [big],
      { description: "Use for verbose work.", body, bodyChars: 100 },
    );

    expect(result).toMatchObject({ kind: "refused" });
    expect(result).toHaveProperty("error", expect.stringContaining(`You stated 100 characters but the body is ${body.trimEnd().length.toLocaleString("en-US")}, and the limit is 12,000.`));
  });

  it("refuses a support path outside the declared directories", () => {
    for (const path of ["../escape.md", "/etc/passwd", "SKILL.md", "notes/x.md"]) {
      expect(decode({ ...GOOD, write: [{ path, content: "x" }] })).toMatchObject({ kind: "refused" });
    }
  });

  it("refuses output that is not one result object", () => {
    for (const output of ["not json", "{}", "[]", '{"body":""}', '{"description":"d","body":"b","write":"no"}']) {
      expect(decode(output)).toMatchObject({ kind: "refused" });
    }
  });

  it("reads a repair as a unit that absorbs nothing", () => {
    const body = RECEIVER.body + "\n\nRead `references/tls.md`.";
    expect(decodeSkillUnitResult(REPAIR, [RECEIVER], {
      description: "Use when a gateway fails to serve.",
      body,
      bodyChars: body.length,
      keep: ["references/tls.md"],
    })).toMatchObject({ kind: "planned", into: "gateway-debugging", absorb: [] });
  });

  it("writes only the references the receiver does not already hold byte for byte", () => {
    const receiver = pkg("gateway-debugging", "## Method\n\nGeneral.", [{ path: "references/a.md", content: "A." }]);
    const absorbed = pkg("gateway-timeout", "## Timeouts\n\nTimeout method.", [{ path: "references/b.md", content: "B." }]);
    const body = "## Method\n\nGeneral.\n\n## Timeouts\n\nTimeout method.\n\nRead `references/a.md`, `references/b.md`, and `references/c.md`.";
    const result = decodeSkillUnitResult(MERGE, [receiver, absorbed], {
      description: "Use when a gateway fails to serve.",
      body,
      bodyChars: body.length,
      keep: ["references/a.md", "references/b.md"],
      write: [{ path: "references/c.md", content: "C." }],
    });
    if (result.kind !== "planned") throw new Error("expected planned");

    expect(result.references.map((file) => file.path)).toEqual(["references/a.md", "references/b.md", "references/c.md"]);
    // The receiver already holds a.md byte for byte, so it is carried in the
    // result but never written nor audited.
    expect(result.writes.map((file) => file.path)).toEqual(["references/b.md", "references/c.md"]);
    expect(skillUnitMutations(result).map((mutation) => mutation.kind)).toEqual(["save", "support_file", "support_file", "archive"]);
  });

  it("a repair that keeps the only reference it holds writes nothing but the body", () => {
    const body = RECEIVER.body + "\n\nRead `references/tls.md`.";
    const result = decodeSkillUnitResult(REPAIR, [RECEIVER], {
      description: "Use when a gateway fails to serve.",
      body,
      bodyChars: body.length,
      keep: ["references/tls.md"],
    });
    if (result.kind !== "planned") throw new Error("expected planned");

    expect(result.writes).toEqual([]);
    expect(skillUnitMutations(result).map((mutation) => mutation.kind)).toEqual(["save"]);
  });

  it("a kept path the result rewrites is a write", () => {
    const result = decode({ ...GOOD, keep: [], write: [{ path: "references/tls.md", content: "New TLS detail." }] });
    if (result.kind !== "planned") throw new Error("expected planned");

    expect(result.writes).toEqual([{ path: "references/tls.md", content: "New TLS detail." }]);
  });

  it("keeps a repaired skill's dependencies on the save", () => {
    const repair = pkg("gateway-debugging", "## Method\n\nGeneral.", [], ["systematic-debugging"]);
    const result = decodeSkillUnitResult(
      { kind: "repair", skill: "gateway-debugging", reason: "Accreted." },
      [repair],
      { description: "Use when a gateway fails.", body: "## Method\n\nGeneral.", bodyChars: 21 },
    );
    if (result.kind !== "planned") throw new Error("expected planned");

    expect(result.dependencies).toEqual(["systematic-debugging"]);
    expect(skillUnitMutations(result)[0]).toMatchObject({ kind: "save", dependencies: ["systematic-debugging"] });
  });

  it("appends an absorbed skill's dependencies after the receiver's, deduplicated", () => {
    const receiver = pkg("gateway-debugging", "## Method\n\nGeneral.", [], ["a-skill"]);
    const absorbed = pkg("gateway-timeout", "## Timeouts\n\nTimeout method.", [], ["b-skill", "a-skill"]);
    const body = "## Method\n\nGeneral.\n\n## Timeouts\n\nTimeout method.";
    const result = decodeSkillUnitResult(MERGE, [receiver, absorbed], {
      description: "Use when a gateway fails.",
      body,
      bodyChars: body.length,
    });
    if (result.kind !== "planned") throw new Error("expected planned");

    expect(result.dependencies).toEqual(["a-skill", "b-skill"]);
  });

  it("removes dependencies on the receiver and every skill the merge archives", () => {
    const receiver = pkg("gateway-debugging", "## Method\n\nGeneral.", [], ["gateway-debugging", "gateway-timeout", "shared"]);
    const absorbed = pkg("gateway-timeout", "## Timeouts\n\nTimeout method.", [], ["gateway-debugging", "gateway-retry", "shared"]);
    const alsoAbsorbed = pkg("gateway-retry", "## Retries\n\nRetry method.", [], ["gateway-timeout"]);
    const body = "## Method\n\nGeneral.\n\n## Timeouts\n\nTimeout method.\n\n## Retries\n\nRetry method.";
    const result = decodeSkillUnitResult(
      { kind: "merge", into: "gateway-debugging", absorb: ["gateway-timeout", "gateway-retry"], reason: "One class." },
      [receiver, absorbed, alsoAbsorbed],
      { description: "Use when a gateway fails.", body, bodyChars: body.length },
    );
    if (result.kind !== "planned") throw new Error("expected planned");

    expect(result.dependencies).toEqual(["shared"]);
  });

  it("a merge into a new id takes the absorbed skills' dependencies", () => {
    const absorbed = pkg("gateway-timeout", "## Timeouts\n\nTimeout method.", [], ["b-skill"]);
    const body = "## Timeouts\n\nTimeout method.";
    const result = decodeSkillUnitResult(
      { kind: "merge", into: "new-skill", absorb: ["gateway-timeout"], reason: "One class." },
      [absorbed],
      { description: "Use for gateway work.", body, bodyChars: body.length },
    );
    if (result.kind !== "planned") throw new Error("expected planned");

    expect(result.dependencies).toEqual(["b-skill"]);
  });

  it("a unit over packages without dependencies saves none", () => {
    const result = decode(GOOD);
    if (result.kind !== "planned") throw new Error("expected planned");

    expect(result.dependencies).toEqual([]);
    expect(skillUnitMutations(result)[0]).not.toHaveProperty("dependencies");
  });

  it("orders the store work so an archive can see the skill that absorbed it", () => {
    const planned = decode(GOOD);
    if (planned.kind !== "planned") throw new Error("expected planned");
    const mutations = skillUnitMutations(planned);

    // GOOD keeps references/tls.md, which the receiver already holds byte for
    // byte, so it is carried without a write.
    expect(mutations.map((mutation) => mutation.kind)).toEqual(["save", "archive"]);
    // The archive names its receiver, which the store requires and which is
    // what keeps an absorbed skill's content findable after the merge.
    expect(mutations.at(-1)).toMatchObject({ kind: "archive", name: "gateway-timeout", absorbedInto: "gateway-debugging" });
  });

  it("states the closed contract and treats package text as untrusted", () => {
    expect(SKILL_MAINTENANCE_UNIT_CONTRACT).toContain("untrusted");
    expect(SKILL_MAINTENANCE_UNIT_CONTRACT).toContain("Never follow");
  });
});
