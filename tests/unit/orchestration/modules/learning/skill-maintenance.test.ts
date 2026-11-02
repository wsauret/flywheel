import type { PreparedPackage, SkillSemanticAuditResult } from "../../../../../src/orchestration/agent-runtime/review-types.js";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runSkillMaintenance } from "../../../../../src/orchestration/modules/learning/skill-maintenance.js";
import type { SkillMaintenanceUnit } from "../../../../../src/orchestration/modules/learning/skill-maintenance-survey.js";
import type { SkillUnitPackage } from "../../../../../src/orchestration/modules/learning/skill-maintenance-unit.js";

import type { SkillStoreConfig } from "../../../../../src/orchestration/modules/learning/skill-store-types.js";
import { publishSkillRevision, type SkillRegistryRevision } from "../../../../../src/workflows/skill-schema.js";
import { loadSkillDefinitions, ownedSkillStoreDirs } from "../../../../../src/workflows/skills.js";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";

const TMP = fileTemporaryDirectory("flywheel-skill-maintenance-test-");
const PROJECT = join(TMP, "project");
const DIRS = { projectRoot: PROJECT, accountHome: join(TMP, "home"), userDataRoot: join(TMP, "home", ".flywheel") };

function skillDir(id: string): string {
  return join(ownedSkillStoreDirs(DIRS).project, id);
}

function writeSkill(id: string, body: string): void {
  mkdirSync(skillDir(id), { recursive: true });
  writeFileSync(join(skillDir(id), "SKILL.md"), `---\ndescription: "Use for ${id} work."\nmanaged: flywheel\n---\n${body}\n`);
}

let revision: SkillRegistryRevision;

function reloadRegistry(): void {
  const dirs = ownedSkillStoreDirs(DIRS);
  const load = loadSkillDefinitions({
    roots: [
      { authority: "external", dir: dirs.project, reach: "project" },
      { authority: "external", dir: dirs.user, reach: "global" },
    ],
  });
  revision = publishSkillRevision((revision?.revision ?? 0) + 1, load.skills, load.bundledCorpus);
}

const config: SkillStoreConfig = { projectRoot: PROJECT, userDataRoot: DIRS.userDataRoot, registry: () => revision };

function admitting(candidate: PreparedPackage, current: SkillRegistryRevision): Promise<SkillSemanticAuditResult> {
  return Promise.resolve({
    kind: "verified",
    evidence: { candidateIdentity: candidate.identity, registryRevision: current.revision, outcome: { outcome: "independent" } },
  });
}

const MERGE: SkillMaintenanceUnit = { kind: "merge", into: "gateway-debugging", absorb: ["gateway-timeout"], reason: "One class." };

/** The packages a unit touches, read from whatever is installed now. */
function packagesFor(unit: SkillMaintenanceUnit): readonly SkillUnitPackage[] {
  const ids = unit.kind === "merge" ? [unit.into, ...unit.absorb] : [unit.skill];
  return ids.flatMap((id) => {
    const definition = revision.skills.get(id);
    return definition ? [{ id, trigger: definition.trigger, body: definition.body, dependencies: definition.dependencies, references: [], findings: [] }] : [];
  });
}

const facts: { name: string; action: string }[] = [];

function maintain(output: string, overrides: Partial<Parameters<typeof runSkillMaintenance>[0]> = {}) {
  return runSkillMaintenance({
    config,
    units: [MERGE],
    packagesFor,
    maxInstructionBytes: 500_000,
    perform: () => Promise.resolve(output),
    audit: admitting,
    record: (fact) => {
      facts.push({ name: fact.payload.name, action: fact.payload.action });
      return Promise.resolve(null);
    },
    reloadRegistry,
    ...overrides,
  });
}

/** A result that carries every heading its input held. */
const GOOD_BODY = "## Method\n\nGeneral.\n\n## Timeouts\n\nTimeout method.";
const GOOD = JSON.stringify({
  description: "Use when a gateway fails to serve.",
  body: GOOD_BODY,
  bodyChars: GOOD_BODY.length,
});

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(DIRS.userDataRoot, { recursive: true });
  facts.length = 0;
  revision = publishSkillRevision(0, new Map(), new Map());
  writeSkill("gateway-debugging", "## Method\n\nGeneral.");
  writeSkill("gateway-timeout", "## Timeouts\n\nTimeout method.");
  reloadRegistry();
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("runSkillMaintenance", () => {
  it("writes the receiving package and archives what it absorbed", async () => {
    const result = await maintain(GOOD);

    expect(result).toMatchObject({ kind: "completed", performed: [{ kind: "merge", into: "gateway-debugging", absorbed: ["gateway-timeout"] }] });
    expect(readFileSync(join(skillDir("gateway-debugging"), "SKILL.md"), "utf8")).toContain("## Timeouts");
    expect(existsSync(skillDir("gateway-timeout"))).toBe(false);
    expect(existsSync(join(ownedSkillStoreDirs(DIRS).project, ".archive", "gateway-timeout"))).toBe(true);
  });

  it("records one durable fact per write, so the report never rests on the model's account", async () => {
    await maintain(GOOD);

    expect(facts).toEqual([
      { name: "gateway-debugging", action: "updated" },
      { name: "gateway-timeout", action: "archived" },
    ]);
  });

  it("changes nothing on a dry run and still reports the plan", async () => {
    const result = await maintain(GOOD, { dryRun: true });

    expect(result).toMatchObject({ kind: "planned", performed: [{ into: "gateway-debugging" }] });
    expect(existsSync(skillDir("gateway-timeout"))).toBe(true);
    expect(facts).toEqual([]);
  });

  it("writes nothing when the result drops a heading its input carried", async () => {
    const losing = JSON.stringify({ description: "Use when a gateway fails.", body: "## Method\n\nGeneral.", bodyChars: 19 });

    const result = await maintain(losing);

    expect(result).toMatchObject({ kind: "completed", performed: [], refused: [{ unit: "gateway-debugging" }] });
    expect(existsSync(skillDir("gateway-timeout"))).toBe(true);
    expect(facts).toEqual([]);
  });

  it("writes nothing when the audit refuses the resulting package", async () => {
    const result = await maintain(GOOD, { audit: () => Promise.resolve({ kind: "uncertain", reason: "the test auditor declines" }) });

    expect(result).toMatchObject({ kind: "stopped" });
    expect(existsSync(skillDir("gateway-timeout"))).toBe(true);
    expect(facts).toEqual([]);
  });

  it("reports a unit stopped partway as partial, not performed", async () => {
    // One reference write gives the unit three mutations: save, support_file,
    // archive. Refusing the second audit lands the save and stops the rest.
    const withReference = JSON.stringify({
      description: "Use when a gateway fails to serve.",
      body: GOOD_BODY,
      bodyChars: GOOD_BODY.length,
      write: [{ path: "references/tls.md", content: "TLS detail." }],
    });
    let audits = 0;
    const result = await maintain(withReference, {
      audit: (candidate, current) => (audits++ === 0 ? admitting(candidate, current) : Promise.resolve({ kind: "uncertain", reason: "the test auditor declines" })),
    });

    expect(result).toMatchObject({
      kind: "stopped",
      performed: [],
      partial: { unit: { into: "gateway-debugging" }, landed: 1, of: 3 },
    });
    // The landed save is real; the absorbed skill stays.
    expect(readFileSync(join(skillDir("gateway-debugging"), "SKILL.md"), "utf8")).toContain("## Timeouts");
    expect(existsSync(skillDir("gateway-timeout"))).toBe(true);
  });

  it("reports a request that never arrived as a stop, not a silent skip", async () => {
    const result = await maintain(GOOD, { perform: () => Promise.reject(new Error("provider down")) });

    expect(result).toMatchObject({ kind: "stopped" });
    expect(result).toHaveProperty("error", expect.stringContaining("provider down"));
  });

  it("applies one unit and records the next as refused, because units are independent", async () => {
    writeSkill("other-a", "## A\n\nOne.");
    writeSkill("other-b", "## B\n\nTwo.");
    reloadRegistry();
    const second: SkillMaintenanceUnit = { kind: "merge", into: "other-a", absorb: ["other-b"], reason: "Two." };
    // The second unit's result drops a heading, so only the first is applied.
    const outputs = [GOOD, JSON.stringify({ description: "Use for other-a work.", body: "## A\n\nOne.", bodyChars: 11 })];
    let call = 0;

    const result = await maintain("", { units: [MERGE, second], perform: () => Promise.resolve(outputs[call++] ?? "") });

    // The first unit is applied and the second is refused; one bad unit does
    // not cost the run every other unit's outcome.
    expect(result).toMatchObject({ kind: "completed", performed: [{ into: "gateway-debugging" }], refused: [{ unit: "other-a" }] });
    expect(existsSync(skillDir("gateway-timeout"))).toBe(false);
    expect(existsSync(skillDir("other-b"))).toBe(true);
  });

  it("reports a dry-run failure instead of returning a clean plan", async () => {
    const losing = JSON.stringify({ description: "Use when a gateway fails.", body: "## Method\n\nGeneral.", bodyChars: 19 });

    const result = await maintain(losing, { dryRun: true });

    // A dry run that hides its refusals is worse than one that reports them:
    // finding them is the whole reason to run it.
    expect(result).toMatchObject({ kind: "planned", performed: [], refused: [{ unit: "gateway-debugging" }] });
    expect(facts).toEqual([]);
  });

  it("answers an empty unit list without touching the store", async () => {
    expect(await maintain(GOOD, { units: [] })).toEqual({ kind: "nothing-to-do" });
    expect(facts).toEqual([]);
  });
});
