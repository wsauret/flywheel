/** What names one confirmed operation, what the recovery walk of a shared
 *  global skill store is allowed to enumerate, and which persisted records
 *  still decode. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { planSkillMutation, storeRootDirs } from "../../../../../src/orchestration/modules/learning/skill-mutation-plan.js";
import {
  activeOperationIds,
  advanceOperationManifest,
  manifestPath,
  operationIdentity,
  operationsDir,
  proposalPath,
  proposalRecordIds,
  readOperationManifest,
  readProposalRecord,
  readProposalRecordsForReconciliation,
  writeOperationManifest,
  type ManifestArea,
  type OperationManifest,
  type ProposalRecord,
} from "../../../../../src/orchestration/modules/learning/skill-operation-manifest.js";
import type { SkillMutationPlan, SkillStoreConfig } from "../../../../../src/orchestration/modules/learning/skill-store-types.js";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";
import { publishSkillRevision } from "../../../../../src/workflows/skill-schema.js";

interface UnknownObject {
  [key: string]: unknown;
}
const TMP = fileTemporaryDirectory("flywheel-operation-records-");
const GLOBAL_ROOT = join(TMP, "skills");
const PROPOSAL = "a".repeat(64);

function recordId(seed: number): string {
  return seed.toString(16).padStart(64, "0");
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(operationsDir(GLOBAL_ROOT), { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("an operation is named by the confirmation that authorized it", () => {
  it("separates the operation identity from the content-bound proposal identity", () => {
    const first = operationIdentity({ sessionId: "sess-1", interactionId: "ask-1" }, PROPOSAL);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(operationIdentity({ sessionId: "sess-1", interactionId: "ask-1" }, PROPOSAL)).toBe(first);
    // One question of one session applying one proposal is one operation.
    // Everything else is another operation, whichever field differs.
    expect(operationIdentity({ sessionId: "sess-1", interactionId: "ask-2" }, PROPOSAL)).not.toBe(first);
    expect(operationIdentity({ sessionId: "sess-2", interactionId: "ask-1" }, PROPOSAL)).not.toBe(first);
    expect(operationIdentity({ sessionId: "sess-1", interactionId: "ask-1" }, "b".repeat(64))).not.toBe(first);
    expect(first).not.toBe(PROPOSAL);
  });

  it("cannot be forged by moving a boundary between the fields", () => {
    expect(operationIdentity({ sessionId: "sess", interactionId: "1ask" }, PROPOSAL))
      .not.toBe(operationIdentity({ sessionId: "sess1", interactionId: "ask" }, PROPOSAL));
  });
});

describe("the recovery walk enumerates records, not directory entries", () => {
  it("returns the record ids of the area, ascending, and nothing else", () => {
    const ids = [recordId(3), recordId(1), recordId(2)];
    for (const id of ids) writeFileSync(join(operationsDir(GLOBAL_ROOT), `${id}.json`), "{}");
    // The area holds the working directories of the protocol beside its records,
    // and anything else the user or another tool left there.
    for (const dir of ["terminal", "proposals", "staging", "rollback", "quarantine", "audit"]) {
      mkdirSync(join(operationsDir(GLOBAL_ROOT), dir), { recursive: true });
    }
    writeFileSync(join(operationsDir(GLOBAL_ROOT), "notes.txt"), "hand-written");
    writeFileSync(join(operationsDir(GLOBAL_ROOT), "not-an-identity.json"), "{}");

    expect(activeOperationIds(GLOBAL_ROOT)).toEqual([...ids].sort());
    expect(proposalRecordIds(GLOBAL_ROOT)).toEqual([]);
  });

  it("reports absent and non-directory areas as having no records", () => {
    rmSync(TMP, { recursive: true, force: true });

    expect(activeOperationIds(GLOBAL_ROOT)).toEqual([]);
    expect(proposalRecordIds(GLOBAL_ROOT)).toEqual([]);
    expect(readOperationManifest(GLOBAL_ROOT, recordId(0))).toEqual({ kind: "absent" });
    expect(readProposalRecord(GLOBAL_ROOT, recordId(0))).toEqual({ kind: "absent" });

    mkdirSync(GLOBAL_ROOT, { recursive: true });
    writeFileSync(operationsDir(GLOBAL_ROOT), "not a directory");

    expect(activeOperationIds(GLOBAL_ROOT)).toEqual([]);
    expect(proposalRecordIds(GLOBAL_ROOT)).toEqual([]);
    expect(readOperationManifest(GLOBAL_ROOT, recordId(0))).toEqual({ kind: "absent" });
    expect(readProposalRecord(GLOBAL_ROOT, recordId(0))).toEqual({ kind: "absent" });
  });

  it("bounds proposal recovery by aggregate bytes before record parsing", () => {
    const proposalDir = dirname(proposalPath(GLOBAL_ROOT, recordId(0)));
    mkdirSync(proposalDir, { recursive: true });
    for (let index = 0; index < 17; index += 1) {
      const path = proposalPath(GLOBAL_ROOT, recordId(index));
      writeFileSync(path, "");
      truncateSync(path, 4 * 1024 * 1024);
    }

    expect(readProposalRecordsForReconciliation(GLOBAL_ROOT)).toEqual([]);
    expect(existsSync(proposalPath(GLOBAL_ROOT, recordId(16)))).toBe(false);
  });
});

describe("persisted record verification and recovery", () => {
  const CWD = join(TMP, "project");
  const HOME = join(TMP, "home");
  const CONFIG: SkillStoreConfig = { projectRoot: CWD, userDataRoot: join(HOME, ".flywheel"), registry: () => publishSkillRevision(1, new Map()) };
  const ORIGIN = { sessionId: "sess-legacy", interactionId: "ask-legacy" };

  function currentPlan(name: string = "global-notes"): SkillMutationPlan {
    const planned = planSkillMutation(CONFIG, { kind: "user" }, {
      kind: "save",
      name,
      description: `Use for ${name}.`,
      body: "Body of the legacy package.",
      reach: "global",
    });
    if (planned.kind !== "planned") throw new Error(`the harness could not plan a global save: ${planned.error}`);
    return planned.plan;
  }

  /** Earlier records without a diff cannot authorize work: the current planner
   * always carries it, and strict decoding refuses the missing claim. */
  function legacyPlan(plan: SkillMutationPlan): UnknownObject {
    const legacy: UnknownObject = { ...plan };
    delete legacy.diff;
    return legacy;
  }

  function globalRoot(): string {
    return storeRootDirs(CONFIG).user;
  }

  function writeRecord(path: string, record: UnknownObject): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(record));
  }

  function proposalRecord(plan: SkillMutationPlan): ProposalRecord {
    const roots = storeRootDirs(CONFIG);
    return { version: 1, proposalId: plan.proposalId, createdAt: Date.now(), globalStoreDir: roots.user, projectStoreDir: roots.project, plan };
  }

  it("leaves external records untouched when the proposal area is linked", () => {
    const proposal = proposalRecord(currentPlan("linked-area"));
    const root = globalRoot();
    const path = proposalPath(root, proposal.proposalId);
    writeRecord(path, proposal);
    expect(readProposalRecordsForReconciliation(root)).toHaveLength(1);
    const content = readFileSync(path);
    const outside = join(TMP, "outside-proposals");
    renameSync(dirname(path), outside);
    symlinkSync(outside, dirname(path), process.platform === "win32" ? "junction" : "dir");

    expect(readProposalRecordsForReconciliation(root)).toEqual([]);
    expect(readFileSync(join(outside, `${proposal.proposalId}.json`))).toEqual(content);
  });

  it("leaves a refused record in place when the quarantine destination is linked", () => {
    const proposal = proposalRecord(currentPlan("linked-quarantine"));
    const root = globalRoot();
    const path = proposalPath(root, proposal.proposalId);
    writeRecord(path, { ...proposal, version: 0 });
    const content = readFileSync(path);
    const outside = join(TMP, "outside-quarantine");
    mkdirSync(outside);
    symlinkSync(outside, join(operationsDir(root), "quarantine"), process.platform === "win32" ? "junction" : "dir");

    expect(readProposalRecordsForReconciliation(root)).toEqual([]);
    expect(readFileSync(path)).toEqual(content);
    expect(readdirSync(outside)).toEqual([]);
  });

  function manifestRecord(plan: SkillMutationPlan, state: OperationManifest["state"], origin: typeof ORIGIN): OperationManifest {
    const roots = storeRootDirs(CONFIG);
    const now = Date.now();
    return {
      version: 1,
      state,
      operationId: operationIdentity(origin, plan.proposalId),
      transition: 2,
      createdAt: now,
      updatedAt: now,
      globalStoreDir: roots.user,
      projectStoreDir: roots.project,
      origin,
      plan,
    };
  }

  it("owns legal operation transitions and their durable sequence", () => {
    const claiming = { ...manifestRecord(currentPlan(), "claiming", ORIGIN), transition: 1 };

    const claimed = advanceOperationManifest(claiming, "claimed");

    expect(claimed).toMatchObject({ state: "claimed", transition: 2 });
    expect(() => advanceOperationManifest(claiming, "staged")).toThrow("Illegal skill operation transition");
  });

  it("accepts only state and transition pairs reachable from the legal graph", () => {
    const plan = currentPlan();
    const readPair = (state: OperationManifest["state"], transition: number, label: string) => {
      const origin = { ...ORIGIN, interactionId: `${label}-${state}-${transition}` };
      const manifest = { ...manifestRecord(plan, state, origin), transition };
      writeOperationManifest(globalRoot(), manifest);
      return readOperationManifest(globalRoot(), manifest.operationId);
    };
    const valid: ReadonlyArray<readonly [OperationManifest["state"], number]> = [
      ["claiming", 1], ["claimed", 2], ["staged", 3], ["hidden", 4],
      ["published", 3], ["published", 5], ["completed", 4], ["completed", 6],
      ["refused", 3], ["refused", 5],
    ];
    const invalid: ReadonlyArray<readonly [OperationManifest["state"], number]> = [
      ["claimed", 3], ["published", 4], ["completed", 5], ["refused", 4], ["claimed", 100],
    ];

    for (const [state, transition] of valid) expect(readPair(state, transition, "valid").kind).toBe("ok");
    for (const [state, transition] of invalid) expect(readPair(state, transition, "invalid").kind).toBe("unusable");
    expect(readPair("claimed", Number.MAX_SAFE_INTEGER + 1, "unsafe").kind).toBe("unusable");
  });

  /** One legacy manifest of one confirmation. Each state gets its own question,
   *  because one confirmation is one operation and its manifest lives in one
   *  area. */
  function writeLegacyManifest(plan: SkillMutationPlan, state: OperationManifest["state"], area: ManifestArea): string {
    const record = manifestRecord(plan, state, { ...ORIGIN, interactionId: `ask-${state}` });
    writeRecord(manifestPath(globalRoot(), record.operationId, area), { ...record, plan: legacyPlan(plan) });
    return record.operationId;
  }

  it("is refused as a proposal instead of decoding without its artifact", () => {
    const plan = currentPlan();
    writeRecord(proposalPath(globalRoot(), plan.proposalId), { ...proposalRecord(plan), plan: legacyPlan(plan) });

    const read = readProposalRecord(globalRoot(), plan.proposalId);

    expect(read.kind).toBe("unusable");
    expect(read.kind === "unusable" ? read.reason : "").toContain("decode");
  });

  it("still decodes a proposal that carries the retired catalog-truncation warning", () => {
    const plan = currentPlan("long-description");
    const legacy = { ...plan, warning: "The description is 240 chars; the catalog truncates it at 200." };
    writeRecord(proposalPath(globalRoot(), plan.proposalId), { ...proposalRecord(plan), plan: legacy });

    expect(readProposalRecord(globalRoot(), plan.proposalId).kind).toBe("ok");
  });

  it("refuses to read a historical proposal exceeding the record bound", () => {
    const plan = currentPlan();
    const proposal = proposalRecord({ ...plan, message: "x".repeat(4 * 1024 * 1024) });

    writeRecord(proposalPath(globalRoot(), proposal.proposalId), proposal);
    const result = readProposalRecord(globalRoot(), proposal.proposalId);

    expect(result.kind).toBe("unusable");
    expect(existsSync(proposalPath(globalRoot(), proposal.proposalId))).toBe(true);
  });

  it("is refused as an operation manifest, in either area", () => {
    const plan = currentPlan();
    const staged = writeLegacyManifest(plan, "staged", "active");
    const completed = writeLegacyManifest(plan, "completed", "terminal");

    for (const operationId of [staged, completed]) {
      const read = readOperationManifest(globalRoot(), operationId);
      expect(read.kind).toBe("unusable");
      expect(read.kind === "unusable" ? read.reason : "").toContain("decode");
    }
  });

});
