/** Recovery of an interrupted project-to-global promotion.
 *
 *  Promotion crosses two store roots that can be two filesystems, so it never
 *  renames a package between them: it copies to a hidden staging directory in
 *  the global store, hides the project package inside the project store, and
 *  publishes with a rename inside the global store.
 *
 *  Each test prepares the promotion through the production path, records the
 *  confirmation and its durable claim, leaves the operation in one interrupted
 *  state on disk, and reconciles it the way the next process to read the shared
 *  global store does. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import { reconcileGlobalSkillOperations } from "../../../../../src/orchestration/modules/learning/global-skill-mutation.js";
import {
  quarantineDir,
  rollbackDir,
  stagingDir,
  type OperationManifest,
} from "../../../../../src/orchestration/modules/learning/skill-operation-manifest.js";
import { SKILL_FILE } from "../../../../../src/workflows/skill-schema.js";
import { createGlobalSkillHarness, type GlobalSkillHarness } from "../../../../helpers/global-skill-operations.js";

// A manifest names its directories canonically, and recovery compares them
// canonically, so the fixture root is symlink-resolved (on macOS the temporary
// directory is a link under /private) before any path is derived from it.
const TMP = join(realpathSync(tmpdir()), `flywheel-global-promotion-recovery-${randomUUID()}`);
const CWD = join(TMP, "project");
const HOME = join(TMP, "home");
// The directory authorities of this fixture's project and account state (ARCH-DIRECTORIES-001).
const DIRS = { projectRoot: CWD, accountHome: HOME, userDataRoot: join(HOME, ".flywheel") };
const DB = join(TMP, "flywheel.sqlite");
const SESSION = "sess-promote-recovery";
const NAME = "deploy-runbook";
const INTERACTION = "ask-1";
const BODY = "Step one.";
const NOTE = "Reference note.\n";

let harness: GlobalSkillHarness;

function globalDir(): string {
  return join(harness.globalRoot, NAME);
}

function projectDir(): string {
  return join(harness.projectRoot, NAME);
}

/** Every package directory the registry admits for the promoted id. One entry
 *  is the invariant: no interrupted state may expose two. */
function visiblePackages(): string[] {
  const definition = harness.config.registry().skills.get(NAME);
  if (!definition) return [];
  const shadowed = definition.shadowed?.source;
  return [definition.source, ...(shadowed ? [shadowed] : [])]
    .map((source) => (source.kind === "filesystem" ? source.packageDir : source.packageKey));
}

function installProjectPackage(body = BODY): void {
  mkdirSync(join(projectDir(), "references"), { recursive: true });
  writeFileSync(join(projectDir(), SKILL_FILE), `---\ndescription: Use when running the ${NAME} procedure.\nmanaged: flywheel\n---\n${body}\n`);
  writeFileSync(join(projectDir(), "references", "note.md"), NOTE);
}

/** Copy the confirmed package the manifest carries into one directory, the way
 *  staging or an already published destination holds it. */
function writePackageInto(dir: string, manifest: OperationManifest): void {
  for (const file of manifest.plan.outcome.package.files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

/** Hide the project source inside the project store, where the swap hides it. */
function hideProjectSource(operationId: string): void {
  const hidden = rollbackDir(harness.projectRoot, operationId);
  mkdirSync(dirname(hidden), { recursive: true });
  renameSync(projectDir(), hidden);
}

/** Whatever the project store preserved rather than delete. */
function preservedInProjectStore(): readonly string[] {
  // Any label resolves the store's one quarantine area.
  const dir = dirname(quarantineDir(harness.projectRoot, "probe"));
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Prepare, confirm, and claim the promotion, then leave it in the state a
 *  crash mid-protocol would have left. */
async function interrupted(state: "claimed" | "staged" | "hidden" | "published"): Promise<OperationManifest> {
  const proposalId = harness.prepare({ kind: "promote", name: NAME });
  await harness.approve(proposalId, INTERACTION);
  await harness.claim(harness.operationId(proposalId, INTERACTION), INTERACTION);
  return harness.interrupt(proposalId, INTERACTION, state);
}

function expectPublished(): void {
  expect(readFileSync(join(globalDir(), SKILL_FILE), "utf8")).toContain(BODY);
  expect(readFileSync(join(globalDir(), "references", "note.md"), "utf8")).toBe(NOTE);
  expect(existsSync(projectDir())).toBe(false);
  expect(visiblePackages()).toEqual([globalDir()]);
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  harness = createGlobalSkillHarness({ directories: DIRS, dbPath: DB, sessionId: SESSION });
  mkdirSync(harness.globalRoot, { recursive: true });
  installProjectPackage();
});

afterEach(() => {
  harness.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("an interrupted promotion reconciles to one authoritative package", () => {
  it("finishes a claimed promotion whose source is still live", async () => {
    const manifest = await interrupted("claimed");

    reconcileGlobalSkillOperations(harness.globalRoot, await harness.claims());

    expectPublished();
    expect(existsSync(stagingDir(harness.globalRoot, manifest.operationId))).toBe(false);
    expect(existsSync(rollbackDir(harness.projectRoot, manifest.operationId))).toBe(false);
    expect(harness.manifest(manifest.operationId).state).toBe("completed");
    expect(harness.consumedClaimCount()).toBe(1);
  });

  it("publishes a staged promotion and repeats without republishing it", async () => {
    const manifest = await interrupted("staged");
    writePackageInto(stagingDir(harness.globalRoot, manifest.operationId), manifest);

    reconcileGlobalSkillOperations(harness.globalRoot, await harness.claims());
    const published = statSync(globalDir()).ino;
    reconcileGlobalSkillOperations(harness.globalRoot, await harness.claims());

    expectPublished();
    // The repeat reads terminal evidence: the published directory is the very
    // same one, never a second rename into place.
    expect(statSync(globalDir()).ino).toBe(published);
    expect(existsSync(stagingDir(harness.globalRoot, manifest.operationId))).toBe(false);
    expect(existsSync(rollbackDir(harness.projectRoot, manifest.operationId))).toBe(false);
  });

  it("publishes a hidden source from staging inside the global store", async () => {
    const manifest = await interrupted("hidden");
    writePackageInto(stagingDir(harness.globalRoot, manifest.operationId), manifest);
    hideProjectSource(manifest.operationId);

    // The hidden state keeps one complete recoverable package in each root and
    // no registry-visible package at all.
    expect(visiblePackages()).toEqual([]);

    reconcileGlobalSkillOperations(harness.globalRoot, await harness.claims());

    expectPublished();
    expect(harness.manifest(manifest.operationId).state).toBe("completed");
  });

  it("clears the rollback copy of an already published promotion", async () => {
    const manifest = await interrupted("published");
    hideProjectSource(manifest.operationId);
    writePackageInto(globalDir(), manifest);
    const published = statSync(globalDir()).ino;

    reconcileGlobalSkillOperations(harness.globalRoot, await harness.claims());

    expectPublished();
    expect(statSync(globalDir()).ino).toBe(published);
    expect(existsSync(rollbackDir(harness.projectRoot, manifest.operationId))).toBe(false);
    expect(preservedInProjectStore()).toEqual([]);
    expect(harness.manifest(manifest.operationId).state).toBe("completed");
  });
});

describe("a promotion that cannot publish keeps every byte it moved", () => {
  it("restores the hidden source when the staged copy is gone", async () => {
    const manifest = await interrupted("hidden");
    hideProjectSource(manifest.operationId);

    reconcileGlobalSkillOperations(harness.globalRoot, await harness.claims());

    expect(existsSync(globalDir())).toBe(false);
    expect(readFileSync(join(projectDir(), SKILL_FILE), "utf8")).toContain(BODY);
    expect(readFileSync(join(projectDir(), "references", "note.md"), "utf8")).toBe(NOTE);
    expect(visiblePackages()).toEqual([projectDir()]);
    expect(existsSync(rollbackDir(harness.projectRoot, manifest.operationId))).toBe(false);
    const terminal = harness.manifest(manifest.operationId);
    expect(terminal.state).toBe("refused");
    expect(terminal.outcomeDetail).toContain("staged copy");
  });

  it("preserves the hidden source when the project package was recreated", async () => {
    const manifest = await interrupted("hidden");
    hideProjectSource(manifest.operationId);
    // The user recreated the package while the promotion was in flight. Its
    // bytes may not be overwritten, and the moved bytes may not be deleted.
    installProjectPackage("Recreated step.");

    reconcileGlobalSkillOperations(harness.globalRoot, await harness.claims());

    expect(existsSync(globalDir())).toBe(false);
    expect(readFileSync(join(projectDir(), SKILL_FILE), "utf8")).toContain("Recreated step.");
    const preserved = preservedInProjectStore();
    expect(preserved).toHaveLength(1);
    const kept = join(dirname(quarantineDir(harness.projectRoot, "probe")), String(preserved[0]));
    expect(readFileSync(join(kept, SKILL_FILE), "utf8")).toContain(BODY);
    expect(readFileSync(join(kept, "references", "note.md"), "utf8")).toBe(NOTE);
    expect(existsSync(rollbackDir(harness.projectRoot, manifest.operationId))).toBe(false);
    const terminal = harness.manifest(manifest.operationId);
    expect(terminal.state).toBe("refused");
    expect(terminal.outcomeDetail).toContain(kept);
  });
});
