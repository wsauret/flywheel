import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";
import { asAsyncEventReadSurface, type EventStoreAppend, type LocalSqliteEventStore } from "../../../../../src/infra/event-store-types.js";
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js";
import {
  createSkillCorpusCleanupState,
  SKILL_CORPUS_CLEANUP_AGGREGATE_ID,
  SKILL_CORPUS_CLEANUP_COOLDOWN_MS,
  SKILL_CORPUS_CLEANUP_LEASE_MS,
} from "../../../../../src/orchestration/modules/learning/skill-corpus-cleanup-state.js";
import { skillPackageManifestIdentity } from "../../../../../src/workflows/skill-schema.js";

const TMP = fileTemporaryDirectory("flywheel-skill-corpus-cleanup-state-test-");
const MANIFEST = [
  { id: "alpha", packageIdentity: { sha256: "1".repeat(64), bytes: 10 } },
  { id: "beta", packageIdentity: { sha256: "2".repeat(64), bytes: 20 } },
] as const;
const NEXT_MANIFEST = [
  { id: "alpha", packageIdentity: { sha256: "3".repeat(64), bytes: 11 } },
  { id: "gamma", packageIdentity: { sha256: "4".repeat(64), bytes: 29 } },
] as const;
const CORPUS = skillPackageManifestIdentity(MANIFEST);
const NEXT_CORPUS = skillPackageManifestIdentity(NEXT_MANIFEST);
let store: LocalSqliteEventStore;
let now = 1_000;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  store = createSqliteEventStore(join(TMP, "events.sqlite"));
  now = 1_000;
});

afterEach(() => {
  store.close();
  rmSync(TMP, { recursive: true, force: true });
});

function owner(ownerId: string) {
  return createSkillCorpusCleanupState({ reader: asAsyncEventReadSurface(store), writer: store, ownerId, now: () => now });
}

async function complete(corpus = CORPUS, manifest = MANIFEST) {
  const state = owner("first");
  const claim = await state.claim(corpus, manifest);
  if (claim.kind !== "claimed") throw new Error("claim failed");
  expect(await state.complete(corpus, manifest, claim.token)).toBe(true);
}

function append(type: string, payload: EventStoreAppend["payload"], timestamp = now, version = 4): void {
  store.append({ aggregateId: SKILL_CORPUS_CLEANUP_AGGREGATE_ID, type, version, actor: "flywheel", payload, timestamp, sessionId: "test" });
}

function aggregateFactCount(): number {
  return store.read({ aggregateId: SKILL_CORPUS_CLEANUP_AGGREGATE_ID }).length;
}

describe("skill core corpus cleanup authority", () => {
  it("derives missing, equal, added, changed, removed, and force work", async () => {
    const first = owner("first");
    const missing = await first.claim(CORPUS, MANIFEST);
    expect(missing).toMatchObject({ kind: "claimed", changedPackageIds: ["alpha", "beta"] });
    if (missing.kind !== "claimed") return;
    expect(await first.complete(CORPUS, MANIFEST, missing.token)).toBe(true);
    expect((await owner("equal").claim(CORPUS, MANIFEST)).kind).toBe("already-complete");

    const changed = await owner("changed").claim(NEXT_CORPUS, NEXT_MANIFEST);
    expect(changed).toMatchObject({ kind: "claimed", changedPackageIds: ["alpha", "gamma"], removedPackageIds: ["beta"] });
    if (changed.kind !== "claimed") return;
    expect(await owner("changed").complete(NEXT_CORPUS, NEXT_MANIFEST, changed.token)).toBe(true);

    const removedOnlyManifest = [NEXT_MANIFEST[0]];
    const removedOnlyCorpus = skillPackageManifestIdentity(removedOnlyManifest);
    const removedOnly = await owner("removed").claim(removedOnlyCorpus, removedOnlyManifest);
    expect(removedOnly).toMatchObject({ kind: "claimed", changedPackageIds: [], removedPackageIds: ["gamma"] });
    if (removedOnly.kind !== "claimed") return;
    expect(await owner("removed").complete(removedOnlyCorpus, removedOnlyManifest, removedOnly.token)).toBe(true);

    const forced = await owner("forced").claim(removedOnlyCorpus, removedOnlyManifest, true);
    expect(forced).toMatchObject({ kind: "claimed", changedPackageIds: ["alpha"], removedPackageIds: [] });
  });

  it("fences concurrent owners and recovers an expired claim", async () => {
    const claim = await owner("first").claim(CORPUS, MANIFEST);
    expect(claim.kind).toBe("claimed");
    expect((await owner("second").claim(CORPUS, MANIFEST)).kind).toBe("leased");
    now += SKILL_CORPUS_CLEANUP_LEASE_MS + 1;
    expect((await owner("second").claim(CORPUS, MANIFEST)).kind).toBe("claimed");
  });

  it("writes no fact per lease transition, only per completion", async () => {
    // The regression this shape exists to prevent: leases renewed on a ~100s
    // timer once accumulated one durable row per renewal, forever, on an
    // aggregate no deletion reaches.
    const before = aggregateFactCount();
    const first = owner("first");
    const claim = await first.claim(CORPUS, MANIFEST);
    if (claim.kind !== "claimed") throw new Error("claim failed");
    for (let renewal = 0; renewal < 50; renewal += 1) {
      now += 1;
      expect(await first.renew(CORPUS, claim.token)).toBe(true);
    }
    expect(aggregateFactCount()).toBe(before);
    expect(await first.complete(CORPUS, MANIFEST, claim.token)).toBe(true);
    expect(aggregateFactCount()).toBe(before + 1);
    // Settled leases leave no live cell behind.
    expect(store.readInFlight("skill-core-cleanup-v2", "skill.cleanup.lease")).toHaveLength(0);
  });

  it("preserves renewable owner fencing and exact claim continuity", async () => {
    const first = owner("first");
    const claim = await first.claim(CORPUS, MANIFEST);
    if (claim.kind !== "claimed") throw new Error("claim failed");
    now += 1;
    expect(await owner("impostor").renew(CORPUS, claim.token)).toBe(false);
    expect(await first.renew(NEXT_CORPUS, claim.token)).toBe(false);
    expect(await first.renew(CORPUS, claim.token)).toBe(true);
    now += 1;
    expect(await first.complete(NEXT_CORPUS, NEXT_MANIFEST, claim.token)).toBe(false);
  });

  it("settles a raced lease transition for exactly one owner", async () => {
    const first = owner("first");
    const claim = await first.claim(CORPUS, MANIFEST);
    if (claim.kind !== "claimed") throw new Error("claim failed");
    now += SKILL_CORPUS_CLEANUP_LEASE_MS + 1;
    // The lease expired; a second owner takes it over between the first
    // owner's read and write. The compare-and-swap settles the race.
    const takeover = await owner("second").claim(CORPUS, MANIFEST);
    expect(takeover.kind).toBe("claimed");
    expect(await first.renew(CORPUS, claim.token)).toBe(false);
    expect(await first.complete(CORPUS, MANIFEST, claim.token)).toBe(false);
  });

  it("refuses completion with a manifest that differs from the active claim", async () => {
    const state = owner("first");
    const claim = await state.claim(CORPUS, MANIFEST);
    if (claim.kind !== "claimed") throw new Error("claim failed");
    expect(await state.complete(CORPUS, NEXT_MANIFEST, claim.token)).toBe(false);
    expect((await state.projection()).lease?.coreManifest).toEqual(MANIFEST);
  });

  it("defers only an active exact claim and keeps completion", async () => {
    await complete();
    const changed = await owner("changed").claim(NEXT_CORPUS, NEXT_MANIFEST);
    if (changed.kind !== "claimed") throw new Error("claim failed");
    now += 1;
    expect(await owner("impostor").defer(NEXT_CORPUS, changed.token, "not mine")).toBe(false);
    expect(await owner("changed").defer(NEXT_CORPUS, changed.token, "provider unavailable")).toBe(true);
    expect((await owner("blocked").claim(NEXT_CORPUS, NEXT_MANIFEST)).kind).toBe("deferred");
    expect((await owner("reader").projection()).completedManifest).toEqual(MANIFEST);
    now += SKILL_CORPUS_CLEANUP_COOLDOWN_MS + 1;
    expect((await owner("retry").claim(NEXT_CORPUS, NEXT_MANIFEST)).kind).toBe("claimed");
  });

  it("settles an interrupted claim without a cooldown", async () => {
    const interrupted = owner("interrupted");
    const claim = await interrupted.claim(CORPUS, MANIFEST);
    if (claim.kind !== "claimed") throw new Error("claim failed");

    expect(await interrupted.cancel(CORPUS, claim.token, "runtime shutdown")).toBe(true);
    expect((await owner("retry").claim(CORPUS, MANIFEST)).kind).toBe("claimed");
  });

  it("samples cancellation time once before validating the lease", async () => {
    const initial = owner("owner");
    const claim = await initial.claim(CORPUS, MANIFEST);
    if (claim.kind !== "claimed") throw new Error("claim failed");
    let reads = 0;
    const boundary = createSkillCorpusCleanupState({
      reader: asAsyncEventReadSurface(store),
      writer: store,
      ownerId: "owner",
      now: () => reads++ === 0 ? claim.expiresAt - 1 : claim.expiresAt,
    });

    expect(await boundary.cancel(CORPUS, claim.token, "runtime shutdown")).toBe(true);
    expect((await boundary.projection()).lease).toBeUndefined();
  });

  it("rejects backward-clock transitions without committing them", async () => {
    const state = owner("owner");
    const claim = await state.claim(CORPUS, MANIFEST);
    if (claim.kind !== "claimed") throw new Error("claim failed");
    now -= 1;

    expect(await state.renew(CORPUS, claim.token)).toBe(false);
    expect(await state.defer(CORPUS, claim.token, "provider unavailable")).toBe(false);
    expect(await state.cancel(CORPUS, claim.token, "runtime shutdown")).toBe(false);
    expect(await state.complete(CORPUS, MANIFEST, claim.token)).toBe(false);
    now += 1;
    expect((await state.projection()).lease?.token).toBe(claim.token);
  });

  it("lets force bypass cooldown but not an active lease", async () => {
    const failed = owner("failed");
    const claim = await failed.claim(CORPUS, MANIFEST);
    if (claim.kind !== "claimed") throw new Error("claim failed");
    expect(await failed.defer(CORPUS, claim.token, "provider unavailable")).toBe(true);
    expect((await owner("same-normal").claim(CORPUS, MANIFEST)).kind).toBe("deferred");
    expect((await owner("same-forced").claim(CORPUS, MANIFEST, true)).kind).toBe("claimed");
    expect((await owner("blocked-by-force").claim(NEXT_CORPUS, NEXT_MANIFEST, true)).kind).toBe("leased");
  });

  it("preserves a failed corpus cooldown while a changed corpus completes", async () => {
    const failed = owner("failed");
    const claim = await failed.claim(CORPUS, MANIFEST);
    if (claim.kind !== "claimed") throw new Error("claim failed");
    expect(await failed.defer(CORPUS, claim.token, "provider unavailable")).toBe(true);
    const changed = await owner("changed").claim(NEXT_CORPUS, NEXT_MANIFEST);
    if (changed.kind !== "claimed") throw new Error("changed claim failed");
    expect(await owner("changed").complete(NEXT_CORPUS, NEXT_MANIFEST, changed.token)).toBe(true);
    expect((await owner("old-normal").claim(CORPUS, MANIFEST)).kind).toBe("deferred");
    now += SKILL_CORPUS_CLEANUP_COOLDOWN_MS + 1;
    expect((await owner("old-retry").claim(CORPUS, MANIFEST)).kind).toBe("claimed");
  });

  it("takes over an undecodable lease cell atomically instead of failing", async () => {
    store.putInFlight("skill-core-cleanup-v2", "skill.cleanup.lease", "core", { corrupted: true });
    const claim = await owner("recoverer").claim(CORPUS, MANIFEST);
    expect(claim.kind).toBe("claimed");
    expect(store.readInFlight("skill-core-cleanup-v2", "skill.cleanup.lease")).toHaveLength(1);
  });

  it("does not accept historical all-bundled v1 completion", async () => {
    store.append({ aggregateId: "project:skill-cleanup", type: "skill.cleanup.completed", version: 1, actor: "flywheel", payload: { corpusIdentity: CORPUS, ownerId: "old", token: "old", completedAt: now }, timestamp: now, sessionId: "old" });
    expect(await owner("new").claim(CORPUS, MANIFEST)).toMatchObject({ kind: "claimed", changedPackageIds: ["alpha", "beta"] });
  });

  it("preserves version 2 completion in the current cleanup authority", async () => {
    const claim = { coreIdentity: CORPUS, coreManifest: MANIFEST, ownerId: "old", token: "old", claimedAt: now, expiresAt: now + SKILL_CORPUS_CLEANUP_LEASE_MS };
    append("skill.cleanup.claimed", claim, now, 2);
    now += 1;
    append("skill.cleanup.completed", { coreIdentity: CORPUS, coreManifest: MANIFEST, ownerId: "old", token: "old", completedAt: now }, now, 2);

    expect((await owner("new").claim(CORPUS, MANIFEST)).kind).toBe("already-complete");
  });

  it("does not let normal or forced work bypass a historical fact lease", async () => {
    // A binary from before the lease moved to in-flight state may still hold
    // it as facts; this binary must keep fencing on those until they expire.
    append("skill.cleanup.claimed", { coreIdentity: CORPUS, coreManifest: MANIFEST, ownerId: "old", token: "old", claimedAt: now, expiresAt: now + SKILL_CORPUS_CLEANUP_LEASE_MS }, now, 2);

    expect((await owner("normal").claim(CORPUS, MANIFEST)).kind).toBe("leased");
    expect((await owner("forced").claim(CORPUS, MANIFEST, true)).kind).toBe("leased");
    now += SKILL_CORPUS_CLEANUP_LEASE_MS + 1;
    expect((await owner("after").claim(CORPUS, MANIFEST)).kind).toBe("claimed");
  });

  it("respects a historical fact cooldown until it lapses", async () => {
    append("skill.cleanup.claimed", { coreIdentity: CORPUS, coreManifest: MANIFEST, ownerId: "old", token: "old", forced: false, claimedAt: now, expiresAt: now + SKILL_CORPUS_CLEANUP_LEASE_MS }, now, 4);
    now += 1;
    append("skill.cleanup.deferred", { coreIdentity: CORPUS, ownerId: "old", token: "old", deferredAt: now, cooldownUntil: now + SKILL_CORPUS_CLEANUP_COOLDOWN_MS, reason: "provider unavailable" }, now, 4);

    expect((await owner("blocked").claim(CORPUS, MANIFEST)).kind).toBe("deferred");
    expect((await owner("forced").claim(CORPUS, MANIFEST, true)).kind).toBe("claimed");
  });
});
