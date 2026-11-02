import { beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectSkillLibrary, repairMovedPaths, type SkillFinding } from "../../../src/workflows/skill-health.js";
import { publishSkillRevision } from "../../../src/workflows/skill-schema.js";
import { loadSkillDefinitions, ownedSkillStoreDirs } from "../../../src/workflows/skills.js";
import { fileTemporaryDirectory } from "../../helpers/directories.js";

const TMP = fileTemporaryDirectory("flywheel-skill-doctor-test-");
const PROJECT = join(TMP, "project");
const DIRS = { projectRoot: PROJECT, accountHome: join(TMP, "home"), userDataRoot: join(TMP, "home", ".flywheel") };

function writeSkill(id: string, body: string, references: ReadonlyMap<string, string> = new Map(), description = `Use for ${id} work.`): void {
  const dir = join(ownedSkillStoreDirs(DIRS).project, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\ndescription: "${description}"\nmanaged: flywheel\n---\n${body}\n`);
  for (const [path, content] of references) {
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
}

function installedRevision() {
  const dirs = ownedSkillStoreDirs(DIRS);
  const load = loadSkillDefinitions({
    roots: [
      { authority: "external", dir: dirs.project, reach: "project" },
      { authority: "external", dir: dirs.user, reach: "global" },
    ],
  });
  return publishSkillRevision(1, load.skills);
}

function inspect(): readonly SkillFinding[] {
  return inspectSkillLibrary({ revision: installedRevision(), directories: DIRS });
}

const kinds = (findings: readonly SkillFinding[]): string[] => findings.map((finding) => finding.kind).sort();

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(join(PROJECT, "docs"), { recursive: true });
  mkdirSync(DIRS.userDataRoot, { recursive: true });
});

describe("inspectSkillLibrary", () => {
  it("reports nothing for a healthy package", () => {
    writeSkill("healthy", "# Method\n\nRead `references/detail.md` when the case is unusual.", new Map([["references/detail.md", "x".repeat(2_000)]]));

    expect(inspect()).toEqual([]);
  });

  it("finds a reference the body never names, which no agent can reach", () => {
    writeSkill("orphaned", "# Method\n\nNothing points anywhere.", new Map([["references/lost.md", "x".repeat(2_000)]]));

    const finding = inspect().find((entry) => entry.kind === "reference-unreachable");
    expect(finding).toMatchObject({ kind: "reference-unreachable", skill: "orphaned", path: "references/lost.md" });
  });

  it("finds a body pointer to a reference that does not exist", () => {
    writeSkill("dangling", "# Method\n\nRead `references/absent.md` for the detail.");

    expect(inspect().find((entry) => entry.kind === "reference-dangling")).toMatchObject({ skill: "dangling", path: "references/absent.md" });
  });

  it("finds a repo path that no longer resolves, and names where it moved", () => {
    writeFileSync(join(PROJECT, "docs", "moved-guide.md"), "guide");
    writeSkill("stale", "# Method\n\nRead `docs/guides/moved-guide.md` first.");

    expect(inspect().find((entry) => entry.kind === "path-stale")).toMatchObject({
      skill: "stale",
      path: "docs/guides/moved-guide.md",
      movedTo: "docs/moved-guide.md",
    });
  });

  it("does not report a path that resolves inside the package itself", () => {
    const dir = join(ownedSkillStoreDirs(DIRS).project, "packaged");
    writeSkill("packaged", "# Method\n\nRun `scripts/probe.ts` to check.");
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "probe.ts"), "probe");

    expect(kinds(inspect())).not.toContain("path-stale");
  });

  it("does not report an ellipsis placeholder, which is prose and not a pointer", () => {
    writeSkill("placeholder", "# Method\n\nRead `docs/guides/...` for the rest.");

    expect(kinds(inspect())).not.toContain("path-stale");
  });

  it("finds a pointer to a skill that is not installed", () => {
    writeSkill("pointer", "# Method\n\nLoad the `retired-skill` skill before verifying.");

    expect(inspect().find((entry) => entry.kind === "skill-pointer-stale")).toMatchObject({ skill: "pointer", target: "retired-skill" });
  });

  it("does not report a pointer to a skill that is installed", () => {
    writeSkill("live-sibling", "# Method\n\nBody.");
    writeSkill("pointer", "# Method\n\nLoad the `live-sibling` skill before verifying.");

    expect(kinds(inspect())).not.toContain("skill-pointer-stale");
  });

  it("finds a body over the budget, which only a direct edit can produce", () => {
    writeSkill("swollen", "# Method\n\n" + "word ".repeat(2_600));

    expect(inspect().find((entry) => entry.kind === "body-over-budget")).toMatchObject({ skill: "swollen" });
  });

  it("holds a bundled body that its readers need on every load to its own measured budget, and an external package of that id to the global one", () => {
    writeSkill("workflow-authoring", "# Method\n\n" + "word ".repeat(2_600));
    const bundled = loadSkillDefinitions({ roots: [{ authority: "bundled", dir: ownedSkillStoreDirs(DIRS).project, reach: "global", sourceKind: "agent" }] });
    const bundledFindings = inspectSkillLibrary({ revision: publishSkillRevision(1, bundled.skills), directories: DIRS, includeUnowned: true });

    expect(kinds(bundledFindings)).not.toContain("body-over-budget");
    expect(inspect().find((entry) => entry.kind === "body-over-budget")).toMatchObject({ skill: "workflow-authoring" });
  });

  it("finds a body crowding the budget before it is over it", () => {
    writeSkill("crowded", "# Method\n\n" + "word ".repeat(2_000));

    expect(kinds(inspect())).toContain("body-crowded");
  });

  it("finds a heading used twice in one body, which hides content under the wrong one", () => {
    writeSkill("repeated", "## Verify\n\nOne.\n\n## Other\n\nTwo.\n\n## Verify\n\nThree.");

    expect(inspect().find((entry) => entry.kind === "duplicate-heading")).toMatchObject({ skill: "repeated", heading: "## Verify" });
  });

  it("separates what is broken from what is only worth a look", () => {
    writeSkill("mixed", "# Method\n\nRead `references/absent.md`.\n\n" + "word ".repeat(2_000));
    const findings = inspect();

    expect(findings.find((entry) => entry.kind === "reference-dangling")?.severity).toBe("broken");
    expect(findings.find((entry) => entry.kind === "body-crowded")?.severity).toBe("smell");
  });
});

describe("repairMovedPaths", () => {
  it("rewrites a moved path in an installed package and leaves a linked package's source untouched", () => {
    writeFileSync(join(PROJECT, "docs", "moved-guide.md"), "guide");
    const body = "# Method\n\nRead `docs/guides/moved-guide.md` first.";
    writeSkill("installed", body);
    const source = join(TMP, "source", "linked");
    mkdirSync(source, { recursive: true });
    const sourceSkill = `---\ndescription: "Use for linked work."\n---\n${body}\n`;
    writeFileSync(join(source, "SKILL.md"), sourceSkill);
    symlinkSync(source, join(ownedSkillStoreDirs(DIRS).project, "linked"));
    const revision = installedRevision();

    const result = repairMovedPaths(inspectSkillLibrary({ revision, directories: DIRS, includeUnowned: true }), revision);

    expect(result.repaired.map((entry) => entry.skill)).toEqual(["installed"]);
    expect(result.linked.map((entry) => entry.skill)).toEqual(["linked"]);
    expect(readFileSync(join(ownedSkillStoreDirs(DIRS).project, "installed", "SKILL.md"), "utf8")).toContain("`docs/moved-guide.md`");
    expect(readFileSync(join(source, "SKILL.md"), "utf8")).toBe(sourceSkill);
  });
});
