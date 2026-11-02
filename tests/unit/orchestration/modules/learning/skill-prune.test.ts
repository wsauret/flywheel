import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asAsyncEventReadSurface, type StoredFact } from "../../../../../src/infra/event-store-types.js";
import { applySkillLifecycleTransitions } from "../../../../../src/orchestration/modules/learning/skill-prune.js";
import { skillActivitySource } from "../../../../../src/orchestration/modules/learning/skill-load-stats.js";
import { publishSkillRevision } from "../../../../../src/workflows/skill-schema.js";
import type { SkillWrittenFact } from "../../../../../src/workflows/skill-facts.js";
import { loadSkillDefinitions, ownedSkillStoreDirs } from "../../../../../src/workflows/skills.js";
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";

const TMP = fileTemporaryDirectory("flywheel-skill-prune-test-");
const CWD = join(TMP, "project");
const HOME = join(TMP, "home");
// The directory authorities the pruner selects the two owned stores from.
const DIRS = { projectRoot: CWD, accountHome: HOME, userDataRoot: join(HOME, ".flywheel") };
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

function writeSkill(name: string, managed: "flywheel" | "user", ageDays: number): void {
  const dir = join(ownedSkillStoreDirs(DIRS).project, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, `---\ndescription: "Use for ${name} work."\nmanaged: ${managed}\n---\n# ${name}\nBody.\n`);
  const mtime = new Date(NOW - ageDays * DAY);
  utimesSync(file, mtime, mtime);
}

function loadEvent(skillId: string, timestamp: number, position = 1): StoredFact {
  return {
    position,
    id: `e-${position}`,
    aggregateId: "session:s",
    seq: position,
    type: "tool.input.completed",
    version: 1,
    timestamp,
    actor: "agent",
    sessionId: "s",
    payload: { toolUseId: "u", toolName: "skill", input: { action: "load", skill_id: skillId } },
  };
}

function reader(events: StoredFact[]) {
  return asAsyncEventReadSurface(inMemoryEventReader(events));
}

function registry() {
  const dirs = ownedSkillStoreDirs(DIRS);
  const load = loadSkillDefinitions({
    roots: [
      { authority: "external", dir: dirs.project, reach: "project" },
      { authority: "external", dir: dirs.user, reach: "global" },
    ],
  });
  return publishSkillRevision(1, load.skills);
}

async function prune(
  events: StoredFact[],
  overrides: { dryRun?: boolean; archiveAfterDays?: number } = {},
) {
  return applySkillLifecycleTransitions({
    ...await skillActivitySource(reader(events)),
    registry,
    directories: DIRS,
    now: NOW,
    record: async () => loadEvent("recorded", NOW),
    ...(overrides.dryRun !== undefined ? { dryRun: overrides.dryRun } : {}),
    ...(overrides.archiveAfterDays !== undefined ? { archiveAfterDays: overrides.archiveAfterDays } : {}),
  });
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
  mkdirSync(HOME, { recursive: true });
});

describe("applySkillLifecycleTransitions", () => {
  it("archives an inactive skill but does not report it when attribution remains unsettled", async () => {
    writeSkill("ancient", "flywheel", 120);
    const facts: SkillWrittenFact[] = [];
    const report = await applySkillLifecycleTransitions({
      ...await skillActivitySource(reader([loadEvent("ancient", NOW - 100 * DAY)])),
      registry,
      directories: DIRS,
      now: NOW,
      record: (fact) => {
        facts.push(fact);
        return Promise.resolve(null);
      },
    });

    expect(report.archived).toEqual([]);
    expect(existsSync(join(ownedSkillStoreDirs(DIRS).project, "ancient"))).toBe(false);
    expect(existsSync(join(ownedSkillStoreDirs(DIRS).project, ".archive", "ancient"))).toBe(true);
    expect(facts[0]?.payload.origin).toEqual({ kind: "pruner" });
    expect(facts[0]?.payload.action).toBe("archived");
  });

  it("recent activity keeps an old package live, and mid-window activity is a stale label only", async () => {
    writeSkill("busy", "flywheel", 200);
    writeSkill("cooling", "flywheel", 200);
    const report = await prune([
      loadEvent("busy", NOW - 2 * DAY),
      loadEvent("cooling", NOW - 45 * DAY, 2),
    ]);

    expect(report.archived).toEqual([]);
    expect(report.stale).toEqual(["cooling"]);
    expect(existsSync(join(ownedSkillStoreDirs(DIRS).project, "cooling"))).toBe(true);
  });

  it("rechecks activity under the archive lock before moving a package", async () => {
    writeSkill("just-loaded", "flywheel", 120);
    const report = await applySkillLifecycleTransitions({
      activity: new Map([["just-loaded", NOW - 100 * DAY]]),
      latestActivity: () => NOW,
      registry,
      directories: DIRS,
      now: NOW,
    });

    expect(report.archived).toEqual([]);
    expect(existsSync(join(ownedSkillStoreDirs(DIRS).project, "just-loaded"))).toBe(true);
  });

  it("never archives pinned (managed: user) packages", async () => {
    writeSkill("pinned", "user", 400);
    const report = await prune([]);

    expect(report.archived).toEqual([]);
    // Pinned packages are not candidates at all.
    expect(report.checked).toBe(0);
  });

  it("never archives a package installed as a link, even when its source sits in an owned store", async () => {
    // A dot directory is never listed, so only the link installs the source.
    writeSkill(join(".sources", "linked-old"), "flywheel", 400);
    const store = ownedSkillStoreDirs(DIRS).project;
    symlinkSync(join(store, ".sources", "linked-old"), join(store, "linked-old"));
    const report = await prune([]);

    expect(report.checked).toBe(0);
    expect(report.archived).toEqual([]);
    expect(lstatSync(join(store, "linked-old")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(store, ".sources", "linked-old", "SKILL.md"))).toBe(true);
  });

  it("leaves a never-used skill alone until it outlives the stale window (grace floor)", async () => {
    writeSkill("young-unused", "flywheel", 10);
    writeSkill("old-unused", "flywheel", 120);
    const report = await prune([]);

    expect(report.archived).toEqual(["old-unused"]);
    expect(existsSync(join(ownedSkillStoreDirs(DIRS).project, "young-unused"))).toBe(true);
  });

  it("an archive window of zero turns the lifecycle pass off entirely", async () => {
    writeSkill("ancient", "flywheel", 120);
    const report = await prune([], { archiveAfterDays: 0 });

    expect(report).toEqual({ checked: 0, archived: [], stale: [] });
    expect(existsSync(join(ownedSkillStoreDirs(DIRS).project, "ancient"))).toBe(true);
  });

  it("dry run reports the plan without moving anything", async () => {
    writeSkill("ancient", "flywheel", 120);
    const report = await prune([], { dryRun: true });

    expect(report.archived).toEqual(["ancient"]);
    expect(existsSync(join(ownedSkillStoreDirs(DIRS).project, "ancient"))).toBe(true);
  });

  it("ignores the pruner's own lifecycle facts when anchoring activity", async () => {
    writeSkill("boomerang", "flywheel", 120);
    // A prior prune archived it recently; the user then restored it. The
    // pruner-origin fact must not read as fresh activity, or a restored
    // package earns a new window measured from the prune itself.
    const prunerFact: StoredFact = {
      position: 2,
      id: "w",
      aggregateId: "session:skill-pruner",
      seq: 1,
      type: "skill.written",
      // Telemetry decodes Flywheel-owned facts strictly, so the fixture carries
      // the current fact version and its reach vocabulary.
      version: 2,
      timestamp: NOW - 1 * DAY,
      actor: "flywheel",
      sessionId: "skill-pruner",
      payload: {
        name: "boomerang",
        action: "archived",
        reach: "project",
        origin: { kind: "pruner" },
        identity: { kind: "recorded", writeId: "w", proposalId: "p", packageIdentity: { sha256: "p", bytes: 1 } },
        contentHash: "h",
        description: "d",
      },
    };
    const report = await prune([prunerFact], { dryRun: true });
    expect(report.archived).toEqual(["boomerang"]);
  });
});
