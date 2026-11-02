import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { planSkillMutation, storeRootDirs } from "../../../src/orchestration/modules/learning/skill-mutation-plan.js";
import {
  activeOperationIds,
  operationsDir,
  proposalPath,
  proposalRecordIds,
  quarantineDir,
  type ProposalRecord,
} from "../../../src/orchestration/modules/learning/skill-operation-manifest.js";
import type { SkillMutationPlan, SkillStoreConfig } from "../../../src/orchestration/modules/learning/skill-store-types.js";
import { publishSkillRevision } from "../../../src/workflows/skill-schema.js";

const TMP = join(tmpdir(), `flywheel-operation-record-boundaries-${process.pid}-${Date.now()}`);
const GLOBAL_ROOT = join(TMP, "skills");
const CWD = join(TMP, "project");
const HOME = join(TMP, "home");
const CONFIG: SkillStoreConfig = {
  projectRoot: CWD,
  userDataRoot: join(HOME, ".flywheel"),
  registry: () => publishSkillRevision(1, new Map()),
};

function recordId(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

function currentPlan(name: string): SkillMutationPlan {
  const planned = planSkillMutation(CONFIG, { kind: "user" }, {
    kind: "save",
    name,
    description: `Use for ${name}.`,
    body: "Body.",
    reach: "global",
  });
  if (planned.kind !== "planned") throw new Error(`the harness could not plan a global save: ${planned.error}`);
  return planned.plan;
}

function globalRoot(): string {
  return storeRootDirs(CONFIG).user;
}

function proposalRecord(plan: SkillMutationPlan): ProposalRecord {
  const roots = storeRootDirs(CONFIG);
  return {
    version: 1,
    proposalId: plan.proposalId,
    createdAt: Date.now(),
    globalStoreDir: roots.user,
    projectStoreDir: roots.project,
    plan,
  };
}

function writeLinkedFiles(paths: readonly string[]): void {
  const first = paths[0];
  if (!first) return;
  writeFileSync(first, "{}");
  for (const path of paths.slice(1)) linkSync(first, path);
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(operationsDir(GLOBAL_ROOT), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("skill operation manifest scale boundaries", () => {
  test("unrelated entries cannot trip the record bound or hide a record", () => {
    writeLinkedFiles(Array.from({ length: 513 }, (_, index) => join(operationsDir(GLOBAL_ROOT), `junk-${index}.json`)));
    writeFileSync(join(operationsDir(GLOBAL_ROOT), `${recordId(7)}.json`), "{}");

    expect(activeOperationIds(GLOBAL_ROOT)).toEqual([recordId(7)]);
  });

  test("quarantines excess proposals instead of failing the recovery walk", () => {
    const proposalDir = dirname(proposalPath(GLOBAL_ROOT, recordId(0)));
    mkdirSync(proposalDir, { recursive: true });
    writeLinkedFiles(Array.from({ length: 513 }, (_, index) => proposalPath(GLOBAL_ROOT, recordId(index))));

    expect(proposalRecordIds(GLOBAL_ROOT)).toHaveLength(512);
    expect(existsSync(proposalPath(GLOBAL_ROOT, recordId(512)))).toBe(false);
  });

  test("continues recovery when an excess proposal cannot be quarantined", () => {
    const proposalDir = dirname(proposalPath(GLOBAL_ROOT, recordId(0)));
    mkdirSync(proposalDir, { recursive: true });
    writeLinkedFiles(Array.from({ length: 513 }, (_, index) => proposalPath(GLOBAL_ROOT, recordId(index))));
    const quarantine = dirname(quarantineDir(GLOBAL_ROOT, "record.json"));
    mkdirSync(dirname(quarantine), { recursive: true });
    writeFileSync(quarantine, "blocked");

    expect(proposalRecordIds(GLOBAL_ROOT)).toHaveLength(512);
    expect(existsSync(proposalPath(GLOBAL_ROOT, recordId(512)))).toBe(true);
  });

  test("bounds historical proposal discovery when the area is full", () => {
    const plan = currentPlan("global-notes");
    const proposalDir = dirname(proposalPath(globalRoot(), plan.proposalId));
    mkdirSync(proposalDir, { recursive: true });
    for (let index = 0; index < 512; index += 1) {
      const occupied = currentPlan(`occupied-${index}`);
      writeFileSync(proposalPath(globalRoot(), occupied.proposalId), JSON.stringify(proposalRecord(occupied)));
    }

    expect(proposalRecordIds(globalRoot())).toHaveLength(512);
    expect(existsSync(proposalPath(globalRoot(), plan.proposalId))).toBe(false);
  });
});
