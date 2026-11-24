import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { existsSync, linkSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { planSkillMutation, storeRootDirs } from "../../../src/orchestration/modules/learning/skills/skill-mutation-plan.js";
import {
  activeOperationIds,
  manifestPath,
  proposalPath,
  quarantineDir,
  readProposalRecordsQuarantiningUnusable,
  type ProposalRecord,
} from "../../../src/orchestration/modules/learning/skills/skill-operation-manifest.js";
import type { SkillMutationPlan, SkillStoreConfig } from "../../../src/orchestration/modules/learning/skills/skill-store-types.js";
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

/** The active area of one store: the directory that holds its manifests. */
function operationArea(root: string): string {
  return dirname(manifestPath(root, recordId(0)));
}

/** One more valid proposal than the area bound admits, and the id the ascending
 *  walk reaches last, which is the excess one. */
function writeExcessProposals(): string {
  const ids: string[] = [];
  for (let index = 0; index <= 512; index += 1) {
    const plan = currentPlan(`occupied-${index}`);
    const path = proposalPath(globalRoot(), plan.proposalId);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(proposalRecord(plan)));
    ids.push(plan.proposalId);
  }
  const excess = ids.sort().at(-1);
  if (!excess) throw new Error("expected proposals");
  return excess;
}

function writeLinkedFiles(paths: readonly string[]): void {
  const first = paths[0];
  if (!first) return;
  writeFileSync(first, "{}");
  for (const path of paths.slice(1)) linkSync(first, path);
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(operationArea(GLOBAL_ROOT), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("skill operation manifest scale boundaries", () => {
  test("unrelated entries cannot trip the record bound or hide a record", () => {
    writeLinkedFiles(Array.from({ length: 513 }, (_, index) => join(operationArea(GLOBAL_ROOT), `junk-${index}.json`)));
    writeFileSync(manifestPath(GLOBAL_ROOT, recordId(7)), "{}");

    expect(activeOperationIds(GLOBAL_ROOT)).toEqual([recordId(7)]);
  });

  test("quarantines excess proposals instead of failing the recovery walk", () => {
    const excess = writeExcessProposals();

    expect(readProposalRecordsQuarantiningUnusable(globalRoot())).toHaveLength(512);
    expect(existsSync(proposalPath(globalRoot(), excess))).toBe(false);
  });

  test("continues recovery when an excess proposal cannot be quarantined", () => {
    const excess = writeExcessProposals();
    const quarantine = dirname(quarantineDir(globalRoot(), "record.json"));
    mkdirSync(dirname(quarantine), { recursive: true });
    writeFileSync(quarantine, "blocked");

    expect(readProposalRecordsQuarantiningUnusable(globalRoot())).toHaveLength(512);
    expect(existsSync(proposalPath(globalRoot(), excess))).toBe(true);
  });
});
