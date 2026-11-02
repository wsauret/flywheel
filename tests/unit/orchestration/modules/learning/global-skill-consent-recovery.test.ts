/** The confirmed global mutation protocol across crashes, in one process.
 *
 *  Every operation here is prepared by the production path, confirmed by a
 *  recorded decision, and claimed by the durable guarded append. A recovery
 *  test then reconciles the manifest the crash left, the way the next process
 *  to read the shared global store does: consent is the authority, so the
 *  reader is given the claims of the session that confirmed the work. The
 *  race between two real processes is in the integration tier. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { isRecord } from "../../../../../src/infra/record.js";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";

import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../../src/infra/event-store-types.js";
import { reconcileGlobalSkillOperations } from "../../../../../src/orchestration/modules/learning/global-skill-mutation.js";
import { createSessionFactWriter } from "../../../../../src/orchestration/session/session-fact-writer.js";
import { openPendingAudit, reconcilePendingAudits } from "../../../../../src/orchestration/modules/learning/learning-journal.js";
import {
  manifestPath,
  operationsDir,
  quarantineDir,
  readOperationManifest,
  rollbackDir,
  stagingDir,
  writeOperationManifest,
  type OperationManifest,
  type OperationState,
} from "../../../../../src/orchestration/modules/learning/skill-operation-manifest.js";
import { skillOperationTransitionedFact } from "../../../../../src/workflows/skill-facts.js";
import type { SkillMutation } from "../../../../../src/orchestration/modules/learning/skill-store-types.js";
import { SKILL_FILE, SKILL_LIMITS } from "../../../../../src/workflows/skill-schema.js";
import { createGlobalSkillHarness, readGlobalMutationProposal, type GlobalSkillHarness } from "../../../../helpers/global-skill-operations.js";

// A manifest names its directories canonically, and recovery compares them
// canonically, so the fixture root is symlink-resolved (on macOS the temporary
// directory is a link under /private) before any path is derived from it.
const TMP = join(realpathSync(tmpdir()), `flywheel-global-consent-process-${randomUUID()}`);
const CWD = join(TMP, "project");
const HOME = join(TMP, "home");
// The directory authorities of this fixture's project and account state (ARCH-DIRECTORIES-001).
const DIRS = { projectRoot: CWD, accountHome: HOME, userDataRoot: join(HOME, ".flywheel") };
const DB = join(TMP, "flywheel.sqlite");
const SESSION = "sess-process";
const NAME = "global-notes";
const INTERACTION = "ask-1";

const MUTATION: SkillMutation = {
  kind: "save",
  name: NAME,
  description: "Use for global notes, revised.",
  body: "Revised body.",
};

/** A second confirmed mutation of the same package, planned against the same
 *  pre-state, so publishing both would union two states nobody approved. */
const RIVAL: SkillMutation = { ...MUTATION, body: "Rival body." };

let harness: GlobalSkillHarness;

function globalRoot(): string {
  return harness.globalRoot;
}

function packageDir(): string {
  return join(globalRoot(), NAME);
}

function installedBody(): string {
  return readFileSync(join(packageDir(), SKILL_FILE), "utf8");
}

function installGlobalSkill(body: string): void {
  mkdirSync(packageDir(), { recursive: true });
  writeFileSync(join(packageDir(), SKILL_FILE), `---\ndescription: Use for global notes.\nmanaged: flywheel\n---\n${body}\n`);
}

/** Copy the confirmed package the manifest carries into one directory, the way
 *  a staged or already published operation holds it. */
function writePackageInto(dir: string, manifest: OperationManifest): void {
  for (const file of manifest.plan.outcome.package.files) {
    const target = join(dir, file.path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
}

function confirmedSkillFile(manifest: OperationManifest): string {
  const file = manifest.plan.outcome.package.files.find((candidate) => candidate.path === SKILL_FILE);
  if (!file) throw new Error("the confirmed package carries no SKILL.md");
  return file.content;
}

/** Hide the live package where a swap hides it, inside its own store. The
 *  hidden copy is the package the mutation replaces, so a rollback restores
 *  exactly the bytes that were installed. */
function hideLivePackage(operationId: string): void {
  const hidden = rollbackDir(globalRoot(), operationId);
  mkdirSync(dirname(hidden), { recursive: true });
  renameSync(packageDir(), hidden);
}

/** The entries of the shared audit outbox, which every writer of this store
 *  replays in journal order. */
function auditOutbox(): readonly string[] {
  const dir = join(operationsDir(globalRoot()), "audit");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function flushAuditOutbox(): Promise<number> {
  return reconcilePendingAudits({
    storeDir: globalRoot(),
    workspace: harness.config.projectRoot,
    writer: harness.writer,
    reader: asAsyncEventReadSurface(harness.store),
  });
}

/** Journal the evidence of one transition the way the protocol journals it:
 *  durable before the manifest write that commits it. */
function journalTransition(manifest: OperationManifest, state: OperationState, transition: number): void {
  openPendingAudit({
    storeDir: globalRoot(),
    workspace: harness.projectRoot,
    fact: skillOperationTransitionedFact({
      operationId: manifest.operationId,
      proposalId: manifest.plan.proposalId,
      name: NAME,
      reach: "global",
      state,
    }),
    intended: { kind: "operation", operationId: manifest.operationId, transition },
  });
}

function quarantined(): readonly string[] {
  // Any label resolves the store's one quarantine area.
  const dir = dirname(quarantineDir(globalRoot(), "probe"));
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Prepare, confirm, and claim one mutation, then leave it in the state a
 *  crash mid-protocol would have left. */
async function interrupted(mutation: SkillMutation, state: "claimed" | "staged" | "hidden" | "published", interactionId = INTERACTION): Promise<OperationManifest> {
  const proposalId = harness.prepare(mutation);
  await harness.approve(proposalId, interactionId);
  await harness.claim(harness.operationId(proposalId, interactionId), interactionId);
  return harness.interrupt(proposalId, interactionId, state);
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(CWD, { recursive: true });
  mkdirSync(HOME, { recursive: true });
  harness = createGlobalSkillHarness({ directories: DIRS, dbPath: DB, sessionId: SESSION });
  installGlobalSkill("Alpha.");
});

afterEach(() => {
  harness.close();
  rmSync(TMP, { recursive: true, force: true });
});

describe("recovery finishes the operation a crash interrupted", () => {
  it.each(["claimed", "staged", "hidden", "published"] as const)("recovers a version 2 %s operation without a consent claim", (state) => {
    const proposalId = harness.prepare(MUTATION);
    const legacy = harness.interrupt(proposalId, "tool-call", state);
    const manifest: OperationManifest = { ...legacy, version: 2 };
    writeOperationManifest(globalRoot(), manifest);
    if (state === "staged" || state === "hidden") writePackageInto(stagingDir(globalRoot(), manifest.operationId), manifest);
    if (state === "hidden" || state === "published") hideLivePackage(manifest.operationId);
    if (state === "published") writePackageInto(packageDir(), manifest);
    reconcileGlobalSkillOperations(globalRoot());
    expect(installedBody()).toContain("Revised body.");
    expect(harness.manifest(manifest.operationId).state).toBe("completed");
    expect(harness.consumedClaimCount()).toBe(0);
    expect(existsSync(stagingDir(globalRoot(), manifest.operationId))).toBe(false);
    expect(existsSync(rollbackDir(globalRoot(), manifest.operationId))).toBe(false);
  });

  it("stages and publishes a claimed operation", async () => {
    const manifest = await interrupted(MUTATION, "claimed");

    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());

    expect(installedBody()).toContain("Revised body.");
    expect(harness.manifest(manifest.operationId).state).toBe("completed");
    expect(existsSync(stagingDir(globalRoot(), manifest.operationId))).toBe(false);
    expect(existsSync(rollbackDir(globalRoot(), manifest.operationId))).toBe(false);
    expect(harness.consumedClaimCount()).toBe(1);
  });

  it("publishes a staged operation and repeats without republishing it", async () => {
    const manifest = await interrupted(MUTATION, "staged");
    writePackageInto(stagingDir(globalRoot(), manifest.operationId), manifest);

    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());
    const published = statSync(packageDir()).ino;
    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());

    expect(installedBody()).toContain("Revised body.");
    // The repeat reads terminal evidence: the published directory is the very
    // same one, never a second rename into place.
    expect(statSync(packageDir()).ino).toBe(published);
    expect(existsSync(stagingDir(globalRoot(), manifest.operationId))).toBe(false);
  });

  it("publishes the staged copy of a hidden operation and clears the hidden one", async () => {
    const manifest = await interrupted(MUTATION, "hidden");
    writePackageInto(stagingDir(globalRoot(), manifest.operationId), manifest);
    hideLivePackage(manifest.operationId);

    // A hidden operation exposes no package to the registry at all.
    expect(existsSync(packageDir())).toBe(false);

    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());

    expect(installedBody()).toContain("Revised body.");
    expect(existsSync(rollbackDir(globalRoot(), manifest.operationId))).toBe(false);
    expect(harness.manifest(manifest.operationId).state).toBe("completed");
  });

  it("cleans up after a published operation without touching the package", async () => {
    const manifest = await interrupted(MUTATION, "published");
    hideLivePackage(manifest.operationId);
    writePackageInto(packageDir(), manifest);
    const published = statSync(packageDir()).ino;

    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());

    expect(installedBody()).toContain("Revised body.");
    expect(statSync(packageDir()).ino).toBe(published);
    expect(existsSync(rollbackDir(globalRoot(), manifest.operationId))).toBe(false);
    expect(existsSync(stagingDir(globalRoot(), manifest.operationId))).toBe(false);
    expect(harness.manifest(manifest.operationId).state).toBe("completed");
  });

  it("restores the hidden package when the staged copy is gone", async () => {
    const manifest = await interrupted(MUTATION, "hidden");
    hideLivePackage(manifest.operationId);

    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());

    expect(installedBody()).toContain("Alpha.");
    expect(existsSync(rollbackDir(globalRoot(), manifest.operationId))).toBe(false);
    const terminal = harness.manifest(manifest.operationId);
    expect(terminal.state).toBe("refused");
    expect(terminal.outcomeDetail).toContain("staged copy");
  });
});

describe("a confirmed operation is applied exactly once", () => {
  it("replays terminal evidence instead of publishing or auditing again", async () => {
    const proposalId = harness.prepare(MUTATION);
    await harness.approve(proposalId, INTERACTION);

    const first = await harness.commit(MUTATION, INTERACTION);
    const published = statSync(packageDir()).ino;
    const audited = [...harness.auditedTransitions()];
    const replay = await harness.commit(MUTATION, INTERACTION);

    expect(first).toMatchObject({ kind: "written" });
    expect(replay).toMatchObject({ kind: "written", replayed: true });
    // Filesystem stages are audited once. The consumed claim itself is the
    // durable evidence for authorization; `claimed` only records that claim.
    expect(audited).toEqual(["staged", "hidden", "published", "completed"]);
    expect(harness.auditedTransitions()).toEqual(audited);
    expect(statSync(packageDir()).ino).toBe(published);
    expect(harness.consumedClaimCount()).toBe(1);
    expect(harness.manifest(harness.operationId(proposalId, INTERACTION)).state).toBe("completed");
  });

  // Terminal evidence belongs to the confirmation that produced it. A second
  // confirmation of identical bytes is a different question, so it is a
  // different operation and applies its own mutation instead of reading the
  // first one's outcome.
  it("applies a second confirmation of identical bytes instead of replaying the first", async () => {
    const proposalId = harness.prepare(MUTATION);
    await harness.approve(proposalId, "ask-first");
    await harness.approve(proposalId, "ask-second");
    expect(await harness.commit(MUTATION, "ask-first")).toMatchObject({ kind: "written" });
    // The user puts the package back by hand, so the same change is proposed
    // again and resolves to the same content-bound proposal identity.
    installGlobalSkill("Alpha.");
    expect(harness.prepare(MUTATION)).toBe(proposalId);

    const second = await harness.commit(MUTATION, "ask-second");

    expect(second).toMatchObject({ kind: "written" });
    expect(second.kind === "written" ? second.replayed : undefined).toBeUndefined();
    expect(installedBody()).toContain("Revised body.");
    expect(harness.consumedClaimCount()).toBe(2);
    const operations = ["ask-first", "ask-second"].map((interactionId) => harness.operationId(proposalId, interactionId));
    expect(new Set(operations).size).toBe(2);
    for (const operationId of operations) expect(harness.manifest(operationId).state).toBe("completed");
  });

  it("denies the claim when the session stopped recording, and changes nothing", async () => {
    const proposalId = harness.prepare(MUTATION);
    await harness.approve(proposalId, INTERACTION);
    // A disposed writer resolves null from the guarded append: it wrote
    // nothing, so nothing authorizes the mutation.
    const stopped = createSessionFactWriter({ sessionId: SESSION, writer: asAsyncEventWriter(harness.store) });
    stopped.dispose();

    const result = await harness.commit(MUTATION, INTERACTION, stopped);

    expect(result).toMatchObject({ kind: "refused" });
    expect(result.kind === "refused" ? result.error : "").toContain("stopped recording");
    expect(installedBody()).toContain("Alpha.");
    expect(harness.consumedClaimCount()).toBe(0);
    // Nothing was consumed, so the operation that question opened is gone and
    // the proposal it applies still stands for a later confirmation.
    expect(readOperationManifest(globalRoot(), harness.operationId(proposalId, INTERACTION))).toMatchObject({ kind: "absent" });
    expect(readGlobalMutationProposal(globalRoot(), proposalId)).toMatchObject({ summary: expect.any(String) });
  });

  it("refuses the second of two confirmed mutations of one package", async () => {
    const first = await interrupted(MUTATION, "claimed", "ask-first");
    const second = await interrupted(RIVAL, "claimed", "ask-second");

    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());

    const states = [first, second].map((manifest) => harness.manifest(manifest.operationId).state);
    expect([...states].sort()).toEqual(["completed", "refused"]);
    const winner = [first, second][states.indexOf("completed")];
    const loser = [first, second][states.indexOf("refused")];
    if (!winner || !loser) throw new Error("expected one winner and one loser");
    // The published bytes are exactly one confirmed package, never the union.
    expect(installedBody()).toBe(confirmedSkillFile(winner));
    expect(harness.manifest(loser.operationId).outcomeDetail).toContain("changed after it was confirmed");
    expect(harness.consumedClaimCount()).toBe(2);
  });
});

describe("audit evidence of a transition settles against the operation", () => {
  // The entry is durable before the manifest write it describes, so an operation
  // that has not committed the transition yet may be one write away from it.
  // Dropping the entry there would erase the evidence of a change that is about
  // to happen, and a later entry must not overtake it either.
  it("leaves an entry the operation has not committed yet, and records it once it has", async () => {
    const manifest = await interrupted(MUTATION, "claimed");
    writePackageInto(stagingDir(globalRoot(), manifest.operationId), manifest);
    journalTransition(manifest, "staged", manifest.transition + 1);

    expect(await flushAuditOutbox()).toBe(0);
    expect(auditOutbox()).toHaveLength(1);
    expect(harness.auditedTransitions()).toEqual([]);

    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());

    expect(await flushAuditOutbox()).toBeGreaterThan(0);
    expect(auditOutbox()).toEqual([]);
    // The operation committed the transition, so the entry is recorded once: the
    // operation's own entry for the same state carries the same identity.
    expect(harness.auditedTransitions()).toEqual(["staged", "hidden", "published", "completed"]);
  });

  // Only a terminal operation proves a transition will never commit. Progress is
  // one total order, so a refusal does not pretend the states it never reached
  // were reached.
  it("drops an entry the operation ended without committing", async () => {
    const manifest = await interrupted(MUTATION, "hidden");
    hideLivePackage(manifest.operationId);
    journalTransition(manifest, "completed", manifest.transition + 5);

    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());

    expect(harness.manifest(manifest.operationId).state).toBe("refused");
    expect(await flushAuditOutbox()).toBe(1);
    expect(auditOutbox()).toEqual([]);
    expect(harness.auditedTransitions()).toEqual(["refused"]);
  });
});

describe("a manifest that no longer proves its own claims authorizes nothing", () => {
  it("quarantines a tampered manifest and leaves the package installed", async () => {
    const manifest = await interrupted(MUTATION, "claimed");
    const path = manifestPath(globalRoot(), manifest.operationId);
    const tampered = readFileSync(path, "utf8").replace("Revised body.", "Injected body.");
    expect(tampered).not.toBe(readFileSync(path, "utf8"));
    writeFileSync(path, tampered);

    const read = readOperationManifest(globalRoot(), manifest.operationId);
    expect(read).toMatchObject({ kind: "unusable" });
    expect(read.kind === "unusable" ? read.reason : "").toContain("do not hash to the package identity");

    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());

    expect(installedBody()).toContain("Alpha.");
    expect(existsSync(join(operationsDir(globalRoot()), `${manifest.operationId}.json`))).toBe(false);
    expect(quarantined()).toHaveLength(1);
  });

  it("quarantines a manifest whose plan carries a package over the byte bound", async () => {
    const manifest = await interrupted(MUTATION, "claimed");
    const path = manifestPath(globalRoot(), manifest.operationId);
    // A manifest is bytes another process wrote: the package it carries is
    // admitted by the same total a load and a write apply, before any of it is
    // put on the filesystem.
    writeFileSync(path, readFileSync(path, "utf8").replace("Revised body.", "x".repeat(SKILL_LIMITS.packageBytes + 1)));

    const read = readOperationManifest(globalRoot(), manifest.operationId);
    expect(read).toMatchObject({ kind: "unusable" });
    expect(read.kind === "unusable" ? read.reason : "").toContain(`over the ${SKILL_LIMITS.packageBytes}-byte admission limit`);

    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());

    expect(installedBody()).toContain("Alpha.");
    expect(quarantined()).toHaveLength(1);
  });

  it("refuses a manifest whose path became a symbolic link", async () => {
    const manifest = await interrupted(MUTATION, "claimed");
    const path = manifestPath(globalRoot(), manifest.operationId);
    const elsewhere = join(TMP, "planted-manifest.json");
    renameSync(path, elsewhere);
    symlinkSync(elsewhere, path);

    const read = readOperationManifest(globalRoot(), manifest.operationId);

    expect(read).toMatchObject({ kind: "unusable" });
    expect(read.kind === "unusable" ? read.reason : "").toContain("symbolic link");
    expect(installedBody()).toContain("Alpha.");
  });
});

describe("a manifest missing its required mutation artifact", () => {
  function dropPlanDiff(path: string): void {
    const record: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(record) || !isRecord(record.plan)) throw new Error("the manifest holds no plan");
    expect(record.plan.diff).toBeDefined();
    delete record.plan.diff;
    writeFileSync(path, JSON.stringify(record));
  }

  it("quarantines an interrupted operation without publishing it", async () => {
    const manifest = await interrupted(MUTATION, "claimed");
    const path = manifestPath(globalRoot(), manifest.operationId);
    dropPlanDiff(path);

    const read = readOperationManifest(globalRoot(), manifest.operationId);
    expect(read).toMatchObject({ kind: "unusable" });
    expect(read.kind === "unusable" ? read.reason : "").toContain('["plan"]["diff"]');

    reconcileGlobalSkillOperations(globalRoot(), await harness.claims());

    expect(installedBody()).toContain("Alpha.");
    expect(existsSync(path)).toBe(false);
    expect(quarantined()).toHaveLength(1);
  });

  it("refuses terminal replay without inventing an artifact", async () => {
    const proposalId = harness.prepare(MUTATION);
    await harness.approve(proposalId, INTERACTION);
    const first = await harness.commit(MUTATION, INTERACTION);
    expect(first.kind === "written" ? first.diff : undefined).toBeDefined();
    const published = statSync(packageDir()).ino;
    const audited = [...harness.auditedTransitions()];
    const operationId = harness.operationId(proposalId, INTERACTION);
    dropPlanDiff(manifestPath(globalRoot(), operationId, "terminal"));

    const replay = await harness.commit(MUTATION, INTERACTION);

    expect(replay).toMatchObject({ kind: "refused" });
    expect(replay.kind === "refused" ? replay.error : "").toContain('["plan"]["diff"]');
    expect(installedBody()).toContain("Revised body.");
    expect(statSync(packageDir()).ino).toBe(published);
    expect(harness.auditedTransitions()).toEqual(audited);
    expect(harness.consumedClaimCount()).toBe(1);
  });
});
