import { describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";
import { runSkillCorpusCleanup } from "../../../../../src/orchestration/modules/learning/skill-corpus-cleanup.js";
import type { SkillCorpusCleanupState } from "../../../../../src/orchestration/modules/learning/skill-corpus-cleanup-state.js";
import { publishSkillRevision } from "../../../../../src/workflows/skill-schema.js";

const TMP = fileTemporaryDirectory("flywheel-skill-corpus-cleanup-owner-test-");
const revision = publishSkillRevision(1, new Map());

function state(kind: "claimed" | "already-complete" = "claimed"): SkillCorpusCleanupState {
  return {
    claim: async () => kind === "claimed" ? { kind: "claimed", token: "token", expiresAt: Date.now() + 60_000, changedPackageIds: [], removedPackageIds: [] } : { kind: "already-complete" },
    renew: async () => true,
    owns: async () => true,
    defer: async () => true,
    cancel: async () => true,
    complete: async () => true,
    projection: async () => ({ deferrals: [] }),
  };
}

function input(cleanupState: SkillCorpusCleanupState): Parameters<typeof runSkillCorpusCleanup>[0] {
  return {
    config: { projectRoot: TMP, userDataRoot: join(TMP, "home"), registry: () => revision },
    state: cleanupState,
    classify: async () => { throw new Error("provider must not be acquired"); },
    record: async () => null,
  };
}

describe("runSkillCorpusCleanup admission", () => {
  it("completes an empty manifest without provider work", async () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(TMP, ".flywheel", "skills"), { recursive: true });
    expect(await runSkillCorpusCleanup(input(state()))).toEqual({ kind: "completed", corePackages: 0, candidates: 0, archived: [] });
  });

  it("returns equal completion before provider work", async () => {
    expect(await runSkillCorpusCleanup(input(state("already-complete")))).toEqual({ kind: "already-complete" });
  });

  it("passes force through the claim authority", async () => {
    const cleanupState = state("already-complete");
    let forced = false;
    cleanupState.claim = async (_identity, _manifest, force) => { forced = force === true; return { kind: "already-complete" }; };
    await runSkillCorpusCleanup({ ...input(cleanupState), force: true });
    expect(forced).toBe(true);
  });
});
