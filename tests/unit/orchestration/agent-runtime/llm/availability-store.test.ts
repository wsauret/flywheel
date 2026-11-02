import { describe, expect, test } from "bun:test";
import { POSIX_FAILURE_STAGING } from "../../../../helpers/posix-failure-staging.js";
import { availabilityFixtures } from "./_provider-availability-harness.js";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { accessProviderCandidateKey } from "../../../../../src/infra/llm/access-provider.js";
import { availabilityAuthorityDbFile } from "../../../../../src/infra/paths.js";
import {
  type AvailabilityAuthority,
  AvailabilityCorruptError,
  type AvailabilityKey,
  type AvailabilityObservation,
  AvailabilityProtocolError,
  AvailabilityTransientError,
  AVAILABILITY_PROTOCOL_VERSION,
} from "../../../../../src/infra/llm/availability-store.js";

const CANDIDATE = accessProviderCandidateKey({ kind: "subscription", providerId: "openai_api", instanceId: "account-a", spendMode: "prepaid" });
const OTHER_CANDIDATE = accessProviderCandidateKey({ kind: "subscription", providerId: "openai_api", instanceId: "account-b", spendMode: "automatic" });
const COPILOT_CANDIDATE = accessProviderCandidateKey({ kind: "subscription", providerId: "github_copilot", instanceId: "account-a", spendMode: "included" });
const SINGLETON_CANDIDATE = accessProviderCandidateKey({ kind: "singleton", providerId: "openai_api", spendMode: "direct_api" });

/** Every key these tests write. The authority reads by key, so a test that
 * wants everything the file holds names it. */
const ALL_KEYS: readonly AvailabilityKey[] = [
  { scope: "account", profileId: "default", provider: "openai_api", candidateKey: CANDIDATE, window: "account" },
  { scope: "account", profileId: "default", provider: "openai_api", candidateKey: OTHER_CANDIDATE, window: "account" },
  { scope: "account", profileId: "default", provider: "github_copilot", candidateKey: COPILOT_CANDIDATE, window: "account" },
  { scope: "provider", provider: "openai_api", window: "service" },
];

/** An authority plus the whole-file read these tests assert against. */
function authorityFor(dbFile: string) {
  const authority = createAvailabilityAuthority({ dbFile });
  return { ...authority, snapshot: () => authority.snapshotFor(ALL_KEYS) };
}

const { temporaryDirectory, tempDbFile, createAuthority: createAvailabilityAuthority } = availabilityFixtures();

function exhausted(overrides: Partial<AvailabilityObservation> = {}): AvailabilityObservation {
  return {
    scope: "account",
    profileId: "default",
    provider: "openai_api",
    candidateKey: CANDIDATE,
    window: "account",
    state: "exhausted",
    observedAtMs: 1_000,
    resetsAtMs: 3_600_000,
    source: "terminal-quota-error",
    readGeneration: 0,
    ...overrides,
  };
}

/** Files beside the database that are not the database or its WAL siblings.
 *  A quarantine or rebuild would leave one; a failure must not. */
function quarantineFiles(dbFile: string): string[] {
  const base = path.basename(dbFile);
  return fs.readdirSync(path.dirname(dbFile)).filter((name) => !name.startsWith(base)).sort();
}

/** Writes past the CHECK constraints, as only a broken writer could. The
 *  reader must still refuse to answer from what it finds. */
function force(dbFile: string, table: string, columns: string, where = ""): void {
  using raw = new Database(dbFile);
  raw.exec("PRAGMA ignore_check_constraints = ON");
  raw.query(`update ${table} set ${columns} ${where}`).run();
  raw.close();
}

/** Everything the file states about its own schema, including the journal mode
 *  that a WAL setup would have rewritten. */
function schemaOf(dbFile: string) {
  using raw = new Database(dbFile);
  const schemaSnapshot = {
    objects: raw.query<{ sql: string | null }, []>(`select sql from sqlite_master order by name`).all(),
    journal: raw.query<{ journal_mode: string }, []>(`pragma journal_mode`).get(),
  };
  raw.close();
  return schemaSnapshot;
}

describe("availability authority rows", () => {
  test("an absent file reads as an empty authority and the first commit creates it", () => {
    const dbFile = tempDbFile();
    const authority = authorityFor(dbFile);

    const empty = authority.snapshot();
    expect(empty.rows).toEqual([]);
    expect(empty.revision).toBe(0);

    expect(authority.commit(exhausted())).toEqual({
      kind: "committed",
      row: {
        scope: "account",
        profileId: "default",
        provider: "openai_api",
        candidateKey: CANDIDATE,
        window: "account",
        state: "exhausted",
        generation: 1,
        observedAtMs: 1_000,
        resetsAtMs: 3_600_000,
        source: "terminal-quota-error",
        fence: 0,
        leaseExpiresAtMs: 0,
      },
    });

    const reopened = authorityFor(dbFile).snapshot();
    expect(reopened.incarnation).toBe(empty.incarnation);
    expect(reopened.revision).toBe(1);
    expect(reopened.rows).toEqual(authority.snapshot().rows);
  });

  test("two credential subjects on one provider never suppress or restore each other", () => {
    const authority = authorityFor(tempDbFile());

    authority.commit(exhausted());
    authority.commit(exhausted({ candidateKey: OTHER_CANDIDATE, state: "live", resetsAtMs: undefined }));

    expect(authority.snapshot().rows.map((row) => [row.scope === "account" ? row.candidateKey : undefined, row.state])).toEqual([
      [CANDIDATE, "exhausted"],
      [OTHER_CANDIDATE, "live"],
    ]);
  });

  test("a scoped snapshot reads the keys it was given and no other account's rows", () => {
    const dbFile = tempDbFile();
    const authority = authorityFor(dbFile);
    authority.commit(exhausted());
    authority.commit(exhausted({ candidateKey: OTHER_CANDIDATE, resetsAtMs: 7_200_000 }));
    // The other account's row is broken past the CHECK constraints: reading it
    // at all fails closed, so a scope that answers without it proves both the
    // query and the decode are bounded to the keys asked for.
    force(dbFile, "availability_state", "generation = 1.5", `where candidate_key = '${OTHER_CANDIDATE}'`);
    const reader = createAvailabilityAuthority({ dbFile });

    const scoped = reader.snapshotFor([{ scope: "account", profileId: "default", provider: "openai_api", candidateKey: CANDIDATE, window: "account" }]);

    expect(scoped.rows.map((row) => [row.scope === "account" ? row.candidateKey : undefined, row.generation])).toEqual([[CANDIDATE, 1]]);
    expect(() => reader.snapshotFor(ALL_KEYS)).toThrow(AvailabilityCorruptError);
  });

  test("the same subject seen by two owners shares suppression and recovery", () => {
    const dbFile = tempDbFile();
    const first = authorityFor(dbFile);
    const second = authorityFor(dbFile);

    first.commit(exhausted());
    expect(second.snapshot().rows[0]).toMatchObject({ state: "exhausted", generation: 1 });

    second.commit(exhausted({ state: "live", resetsAtMs: undefined, readGeneration: 1 }));
    expect(first.snapshot().rows[0]).toMatchObject({ state: "live", generation: 2 });
  });

  test("many observations stay bounded to one row per provider, subject, and window", () => {
    const authority = authorityFor(tempDbFile());

    for (let generation = 0; generation < 5; generation++) {
      authority.commit(exhausted({ resetsAtMs: 3_600_000 + generation, readGeneration: generation }));
    }

    const snapshot = authority.snapshot();
    expect(snapshot.rows).toHaveLength(1);
    expect(snapshot.rows[0]).toMatchObject({ generation: 5, resetsAtMs: 3_600_004 });
  });

  test("an observation that restates the row writes nothing and holds the revision still", () => {
    const authority = authorityFor(tempDbFile());
    authority.commit(exhausted());

    const repeat = authority.commit(exhausted({ observedAtMs: 9_999, source: "another-funnel", readGeneration: 0 }));

    expect(repeat).toMatchObject({ kind: "unchanged", row: { generation: 1, observedAtMs: 1_000 } });
    expect(authority.snapshot().revision).toBe(1);
  });
});

describe("availability authority causality", () => {
  test("a live commit decided before a newer exhaustion is rejected with the row that won", () => {
    const dbFile = tempDbFile();
    const requestA = authorityFor(dbFile);
    const requestB = authorityFor(dbFile);

    // A reads the empty authority, B commits exhaustion, then A returns live.
    const readGeneration = requestA.snapshot().rows.length;
    requestB.commit(exhausted());
    const stale = requestA.commit(exhausted({ state: "live", resetsAtMs: undefined, readGeneration }));

    expect(stale).toEqual({ kind: "rejected", current: expect.objectContaining({ state: "exhausted", generation: 1 }) });
    expect(requestB.snapshot().rows[0]).toMatchObject({ state: "exhausted" });
  });

  test("a delayed exhaustion cannot revert the newer live row", () => {
    const authority = authorityFor(tempDbFile());
    authority.commit(exhausted());
    authority.commit(exhausted({ state: "live", resetsAtMs: undefined, readGeneration: 1 }));

    const delayed = authority.commit(exhausted({ observedAtMs: 500, readGeneration: 1 }));

    expect(delayed.kind).toBe("rejected");
    expect(authority.snapshot().rows[0]).toMatchObject({ state: "live", generation: 2 });
  });

  test("equal observation times do not make write arrival the authority", () => {
    const authority = authorityFor(tempDbFile());
    authority.commit(exhausted());

    const first = authority.commit(exhausted({ resetsAtMs: 7_200_000, observedAtMs: 2_000, readGeneration: 1 }));
    const second = authority.commit(exhausted({ resetsAtMs: 9_000_000, observedAtMs: 2_000, readGeneration: 1 }));

    expect(first.kind).toBe("committed");
    expect(second.kind).toBe("rejected");
    expect(authority.snapshot().rows[0]).toMatchObject({ resetsAtMs: 7_200_000 });
  });
});

describe("availability authority probe leases", () => {
  const KEY = { scope: "account", profileId: "default", provider: "github_copilot", candidateKey: COPILOT_CANDIDATE, window: "account" } as const;
  const claim = (nowMs: number) => ({ ...KEY, nowMs, leaseMs: 30_000 });

  test("a claim returns the revision observed in its transaction", () => {
    const dbFile = tempDbFile();
    const first = authorityFor(dbFile);
    const second = authorityFor(dbFile);
    first.commit(exhausted({ ...KEY }));

    const won = first.claimProbe(claim(1_000));
    const lost = second.claimProbe(claim(1_100));

    expect(won).toEqual({ kind: "won", revision: 1, row: expect.objectContaining({ state: "exhausted", generation: 1, fence: 1, leaseExpiresAtMs: 31_000 }) });
    expect(lost).toEqual({ kind: "lost", revision: 1, row: expect.objectContaining({ fence: 1, leaseExpiresAtMs: 31_000 }) });
  });

  test("the winner can renew its fence while a retrying probe is still active", () => {
    const dbFile = tempDbFile();
    const first = authorityFor(dbFile);
    const second = authorityFor(dbFile);
    const won = first.claimProbe(claim(1_000));

    expect(first.renewProbe({ ...KEY, fence: won.row.fence, nowMs: 20_000, leaseMs: 30_000 })).toBe(true);
    expect(first.renewProbe({ ...KEY, fence: won.row.fence + 1, nowMs: 20_000, leaseMs: 30_000 })).toBe(false);
    expect(second.claimProbe(claim(31_001))).toEqual({
      kind: "lost",
      revision: 0,
      row: expect.objectContaining({ fence: won.row.fence, leaseExpiresAtMs: 50_000 }),
    });
  });

  test("a claim states no observation: neither the generation nor the revision moves", () => {
    const authority = authorityFor(tempDbFile());
    authority.commit(exhausted({ ...KEY }));

    const won = authority.claimProbe(claim(1_000));

    expect(won.row).toMatchObject({ state: "exhausted", generation: 1, fence: 1 });
    expect(authority.revision()).toBe(1);
  });

  test("the winner publishes under its fence and the result lands", () => {
    const authority = authorityFor(tempDbFile());
    authority.commit(exhausted({ ...KEY, resetsAtMs: undefined, nextProbeAtMs: 2_000 }));
    const won = authority.claimProbe(claim(3_000));

    const published = authority.commit(exhausted({
      ...KEY,
      state: "live",
      resetsAtMs: undefined,
      readGeneration: won.row.generation,
      fence: won.row.fence,
      source: "copilot-quota-poll",
    }));

    expect(published).toMatchObject({ kind: "committed", row: { state: "live", generation: 2, leaseExpiresAtMs: 0 } });
  });

  test("an expired lease admits one new winner, and the old fence can no longer publish", () => {
    const dbFile = tempDbFile();
    const stalled = authorityFor(dbFile);
    const next = authorityFor(dbFile);
    const stalledClaim = stalled.claimProbe(claim(1_000));

    const nextClaim = next.claimProbe(claim(31_001));
    expect(nextClaim.kind).toBe("won");
    expect(nextClaim.row.fence).toBe(stalledClaim.row.fence + 1);

    const late = stalled.commit(exhausted({ ...KEY, state: "live", resetsAtMs: undefined, fence: stalledClaim.row.fence }));
    expect(late.kind).toBe("rejected");
    expect(next.snapshot().rows[0]).toMatchObject({ state: "probe_due", generation: 0 });
  });

  test("a terminal observation clears the lease, so the next probe claims without waiting it out", () => {
    const authority = authorityFor(tempDbFile());
    const first = authority.claimProbe(claim(1_000));

    authority.commit(exhausted({ ...KEY, readGeneration: first.row.generation }));

    expect(authority.claimProbe(claim(1_100))).toMatchObject({ kind: "won", row: { state: "exhausted", fence: 2 } });
  });

  test("a fenced result that restates the row still hands its lease back", () => {
    const authority = authorityFor(tempDbFile());
    authority.commit(exhausted({ ...KEY, state: "live", resetsAtMs: undefined }));
    const won = authority.claimProbe(claim(1_000));

    const restated = authority.commit(exhausted({
      ...KEY,
      state: "live",
      resetsAtMs: undefined,
      readGeneration: won.row.generation,
      fence: won.row.fence,
      source: "copilot-quota-poll",
    }));

    // The probe concluded, so nothing waits its lease out, and a result that
    // states no news is still no news: neither the generation nor the revision
    // moves.
    expect(restated).toMatchObject({ kind: "unchanged", row: { state: "live", generation: 1, leaseExpiresAtMs: 0 } });
    expect(authority.claimProbe(claim(1_100))).toMatchObject({ kind: "won", row: { fence: 2 } });
    expect(authority.revision()).toBe(1);
  });

});

describe("availability authority failure boundary", () => {
  const outsideCatalogKey: AvailabilityKey = { scope: "account", profileId: "default", provider: "removed_provider", candidateKey: CANDIDATE, window: "account" };
  const catalogOperations: readonly (readonly [string, (authority: AvailabilityAuthority) => void])[] = [
    ["snapshot", (authority) => authority.snapshotFor([outsideCatalogKey])],
    ["commit", (authority) => authority.commit({ ...outsideCatalogKey, state: "live", observedAtMs: 1_000, source: "test", readGeneration: 0 })],
    ["claim", (authority) => authority.claimProbe({ ...outsideCatalogKey, nowMs: 1_000, leaseMs: 30_000 })],
    ["renew", (authority) => authority.renewProbe({ ...outsideCatalogKey, fence: 1, nowMs: 1_000, leaseMs: 30_000 })],
    ["release", (authority) => authority.releaseProbe({ ...outsideCatalogKey, fence: 1 })],
  ];

  test.each(catalogOperations)("%s rejects a provider outside the installed catalog", (_operation, invoke) => {
    const authority = createAvailabilityAuthority({ dbFile: tempDbFile(), providerIds: ["openai_api"] });

    expect(() => invoke(authority)).toThrow(AvailabilityCorruptError);
  });

  test("a malformed current-schema row fails closed and leaves the file exactly as it is", () => {
    const dbFile = tempDbFile();
    authorityFor(dbFile).commit(exhausted());
    using raw = new Database(dbFile);
    raw.query(`update availability_state set resets_at = 'soon'`).run();
    raw.close();

    const authority = authorityFor(dbFile);
    expect(() => authority.snapshot()).toThrow(AvailabilityCorruptError);
    // Fail closed: the authority does not answer from a database it cannot read.
    expect(() => authority.commit(exhausted())).toThrow(AvailabilityCorruptError);

    expect(quarantineFiles(dbFile)).toEqual([]);
    using survivor = new Database(dbFile);
    expect(survivor.query<{ resets_at: unknown }, []>(`select resets_at from availability_state`).get()).toEqual({ resets_at: "soon" });
    survivor.close();
  });

  test.each([
    ["a live row that states a reset", "state = 'live', resets_at = 3600000"],
    ["an exhausted row that states no end", "resets_at = null, next_probe_at = null"],
    ["a fractional generation", "generation = 1.5"],
    ["a negative observation time", "observed_at = -1"],
    ["a lease that names no fence", "lease_expires_at = 3600000, fence = 0"],
  ])("%s is corruption, not a row to serve requests from", (_label, columns) => {
    const dbFile = tempDbFile();
    authorityFor(dbFile).commit(exhausted());
    force(dbFile, "availability_state", columns);

    const authority = authorityFor(dbFile);
    expect(() => authority.snapshot()).toThrow(AvailabilityCorruptError);
    expect(() => authority.commit(exhausted())).toThrow(AvailabilityCorruptError);
    expect(quarantineFiles(dbFile)).toEqual([]);
  });

  test.each([
    ["states no incarnation", "incarnation = ''"],
    ["states a fractional revision", "revision = 2.5"],
  ])("metadata that %s is corruption", (_label, columns) => {
    const dbFile = tempDbFile();
    authorityFor(dbFile).commit(exhausted());
    force(dbFile, "availability_authority", columns);

    expect(() => authorityFor(dbFile).snapshot()).toThrow(AvailabilityCorruptError);
  });

  test("the file itself refuses a semantically broken row, whichever process writes it", () => {
    const dbFile = tempDbFile();
    authorityFor(dbFile).commit(exhausted());

    using raw = new Database(dbFile);
    // The suppression's reset would outlive the state that gives it meaning.
    expect(() => raw.query(`update availability_state set state = 'live'`).run()).toThrow();
    raw.close();

    expect(authorityFor(dbFile).snapshot().rows[0]?.state).toBe("exhausted");
  });

  test("a file that is not a database fails closed without quarantine", () => {
    const dbFile = tempDbFile();
    fs.writeFileSync(dbFile, "this is not a sqlite database");

    const authority = authorityFor(dbFile);
    expect(() => authority.snapshot()).toThrow(AvailabilityCorruptError);

    expect(fs.readFileSync(dbFile, "utf8")).toBe("this is not a sqlite database");
    expect(fs.readdirSync(path.dirname(dbFile))).toEqual(["availability-authority.sqlite"]);
  });

  test("a foreign protocol file fails closed with its schema, its rows, and its directory untouched", () => {
    const dbFile = tempDbFile();
    using foreign = new Database(dbFile, { create: true });
    foreign.exec(`create table availability_authority (id integer primary key check (id = 0), protocol_version integer not null, incarnation text not null, revision integer not null)`);
    foreign.query(`insert into availability_authority values (0, 99, 'future', 7)`).run();
    foreign.close();
    const schema = schemaOf(dbFile);
    const entries = fs.readdirSync(path.dirname(dbFile)).sort();

    const authority = authorityFor(dbFile);
    expect(() => authority.snapshot()).toThrow(AvailabilityProtocolError);
    expect(() => authority.commit(exhausted())).toThrow(AvailabilityProtocolError);

    // The protocol is read before any pragma or schema statement, so this
    // binary adds neither its own tables nor the WAL siblings and journal mode
    // its durability pragmas would have written.
    expect(schemaOf(dbFile)).toEqual(schema);
    expect(fs.readdirSync(path.dirname(dbFile)).sort()).toEqual(entries);
    expect(quarantineFiles(dbFile)).toEqual([]);
    using survivor = new Database(dbFile);
    expect(survivor.query<{ protocol_version: number; revision: number }, []>(`select protocol_version, revision from availability_authority`).get())
      .toEqual({ protocol_version: 99, revision: 7 });
    survivor.close();
  });

  test("a file another writer owns fails closed with its schema, its journal mode, and its directory untouched", () => {
    const dbFile = tempDbFile();
    using foreign = new Database(dbFile, { create: true });
    foreign.exec(`create table sessions (id integer primary key, note text not null)`);
    foreign.query(`insert into sessions values (1, 'another writer')`).run();
    foreign.close();
    const schema = schemaOf(dbFile);
    const entries = fs.readdirSync(path.dirname(dbFile)).sort();

    const authority = authorityFor(dbFile);
    expect(() => authority.snapshot()).toThrow(AvailabilityProtocolError);
    expect(() => authority.commit(exhausted())).toThrow(AvailabilityProtocolError);

    // A file that states no authority metadata but holds objects is not this
    // binary's to create in: neither its tables nor the journal mode and WAL
    // siblings its durability pragmas would have written reach the file.
    expect(schemaOf(dbFile)).toEqual(schema);
    expect(fs.readdirSync(path.dirname(dbFile)).sort()).toEqual(entries);
    expect(quarantineFiles(dbFile)).toEqual([]);
  });

  test("a file that holds nothing at all is the one this binary may create in", () => {
    const dbFile = tempDbFile();
    new Database(dbFile, { create: true }).close();

    expect(authorityFor(dbFile).commit(exhausted()).kind).toBe("committed");
  });

  test("a locked database is transient: nothing is quarantined and the next commit lands", () => {
    const dbFile = tempDbFile();
    const authority = authorityFor(dbFile);
    authority.commit(exhausted());

    using blocker = new Database(dbFile);
    blocker.exec("PRAGMA busy_timeout = 0");
    blocker.exec("begin exclusive");
    expect(() => authority.commit(exhausted({ resetsAtMs: 7_200_000, readGeneration: 1 }))).toThrow(AvailabilityTransientError);
    expect(quarantineFiles(dbFile)).toEqual([]);
    blocker.exec("rollback");
    blocker.close();

    expect(authority.commit(exhausted({ resetsAtMs: 7_200_000, readGeneration: 1 })).kind).toBe("committed");
  });

  test("a contended authority waits out one bounded budget, then refuses: selection never stalls unbounded", () => {
    const dbFile = tempDbFile();
    const authority = authorityFor(dbFile);
    authority.commit(exhausted());
    using blocker = new Database(dbFile);
    blocker.exec("PRAGMA busy_timeout = 0");
    blocker.exec("begin exclusive");

    const startedAtMs = performance.now();
    expect(() => authority.commit(exhausted({ resetsAtMs: 7_200_000, readGeneration: 1 }))).toThrow(AvailabilityTransientError);
    const elapsedMs = performance.now() - startedAtMs;

    // The bounded wait absorbs a concurrent microsecond commit; a file held
    // past the budget is wedged, and costs the request only that budget.
    expect(elapsedMs).toBeGreaterThanOrEqual(90);
    expect(elapsedMs).toBeLessThan(1_000);
    // The reads selection spends stay answerable while another process writes,
    // which is what WAL is for.
    expect(authority.revision()).toBe(1);
    expect(authority.snapshot().rows).toHaveLength(1);

    blocker.exec("rollback");
    blocker.close();
  });

  test.skipIf(!POSIX_FAILURE_STAGING)("a transient acquisition failure is retried: the next operation acquires and lands", () => {
    const dir = temporaryDirectory("flywheel-availability-reacquire-");
    const dbFile = path.join(dir, "nested", "availability-authority.sqlite");
    fs.chmodSync(dir, 0o500);
    const authority: AvailabilityAuthority = createAvailabilityAuthority({ dbFile });
    expect(() => authority.revision()).toThrow(AvailabilityTransientError);

    // The blip clears. A lost startup race costs the operations it refused,
    // never the process's lifetime.
    fs.chmodSync(dir, 0o700);
    expect(authority.commit(exhausted()).kind).toBe("committed");
    expect(authority.revision()).toBe(1);
  });
});

describe("availability authority disposal", () => {
  const KEY = { scope: "account", profileId: "default", provider: "github_copilot", candidateKey: COPILOT_CANDIDATE, window: "account" } as const;
  const claim = (nowMs: number) => ({ ...KEY, nowMs, leaseMs: 30_000 });

  test("dispose closes the handle once and the rows it wrote outlive it", async () => {
    const dbFile = tempDbFile();
    const authority = authorityFor(dbFile);
    authority.commit(exhausted());

    await authority.dispose();
    await authority.dispose();

    // Stopped, not broken: this process states nothing more, and the account
    // keeps everything it already stated.
    expect(() => authority.snapshot()).toThrow(AvailabilityTransientError);
    expect(quarantineFiles(dbFile)).toEqual([]);
    expect(authorityFor(dbFile).snapshot().rows[0]).toMatchObject({ state: "exhausted", generation: 1 });
  });

  test("releasing an owned lease admits the next claimant without waiting it out", () => {
    const dbFile = tempDbFile();
    const leaving = authorityFor(dbFile);
    const next = authorityFor(dbFile);
    const won = leaving.claimProbe(claim(1_000));

    leaving.releaseProbe({ ...KEY, fence: won.row.fence });

    expect(next.claimProbe(claim(1_100))).toMatchObject({ kind: "won", row: { fence: 2 } });
    // A release states no observation, so no other owner's projection is void.
    expect(next.revision()).toBe(0);
  });

  test("a release stating a superseded fence releases nothing", () => {
    const dbFile = tempDbFile();
    const stalled = authorityFor(dbFile);
    const next = authorityFor(dbFile);
    const stalledClaim = stalled.claimProbe(claim(1_000));
    next.claimProbe(claim(31_001));

    stalled.releaseProbe({ ...KEY, fence: stalledClaim.row.fence });

    expect(next.claimProbe(claim(31_100))).toMatchObject({ kind: "lost" });
  });

  test("dispose hands back the lease this handle still holds", async () => {
    const dbFile = tempDbFile();
    const leaving = authorityFor(dbFile);
    const next = authorityFor(dbFile);
    leaving.claimProbe(claim(1_000));

    await leaving.dispose();

    // The probe left with the process, so the next claimant takes the row at
    // once rather than wait out a lease no process holds.
    expect(next.claimProbe(claim(1_100))).toMatchObject({ kind: "won", row: { fence: 2 } });
  });

  test("dispose leaves the lease a newer claimant took over exactly where it is", async () => {
    const dbFile = tempDbFile();
    const stalled = authorityFor(dbFile);
    const next = authorityFor(dbFile);
    stalled.claimProbe(claim(1_000));
    next.claimProbe(claim(31_001));

    await stalled.dispose();

    // The leaving handle's fence was superseded, so its departure releases
    // nothing: the live claimant keeps the row for its full term.
    expect(next.claimProbe(claim(31_100))).toMatchObject({ kind: "lost" });
  });
});

describe("availability protocol partition", () => {
  test("v8 creates a profile-qualified partition without reading or changing v7 bytes", () => {
    const root = temporaryDirectory("flywheel-availability-partition-");
    const v7 = availabilityAuthorityDbFile(root, 7);
    const v8 = availabilityAuthorityDbFile(root, AVAILABILITY_PROTOCOL_VERSION);
    fs.writeFileSync(v7, "untouched-v7");

    createAvailabilityAuthority({ dbFile: v8 }).commit(exhausted());

    expect(AVAILABILITY_PROTOCOL_VERSION).toBe(8);
    expect(fs.readFileSync(v7, "utf8")).toBe("untouched-v7");
    expect(authorityFor(v8).snapshot().rows[0]).toMatchObject({ profileId: "default", candidateKey: CANDIDATE });
  });
});

describe("availability row scope", () => {
  test("account rows are keyed by candidate while service rows are provider-only", () => {
    const dbFile = tempDbFile();
    const authority = createAvailabilityAuthority({ dbFile });
    authority.commit(exhausted());
    authority.commit(exhausted({ candidateKey: OTHER_CANDIDATE, resetsAtMs: 7_200_000 }));
    authority.commit({
      scope: "provider",
      provider: "openai_api",
      window: "service",
      state: "exhausted",
      observedAtMs: 1_000,
      nextProbeAtMs: 2_000,
      source: "provider-outage",
      readGeneration: 0,
    });

    const rows = authority.snapshotFor(ALL_KEYS).rows;
    expect(rows.filter((row) => row.scope === "account")).toHaveLength(2);
    expect(rows.filter((row) => row.scope === "provider")).toHaveLength(1);
    const bytes = fs.readFileSync(dbFile, "latin1");
    expect(bytes).not.toContain("secret");
  });
});

describe("profile-qualified account rows", () => {
  test("identical subscription and singleton candidates in two profiles do not share state or leases", () => {
    const authority = createAvailabilityAuthority({ dbFile: tempDbFile() });
    for (const candidateKey of [CANDIDATE, SINGLETON_CANDIDATE]) {
      const key = { scope: "account", provider: "openai_api", candidateKey, window: "account" } as const;
      authority.commit({ ...key, profileId: "profile-a", state: "exhausted", observedAtMs: 1, nextProbeAtMs: 2, source: "test", readGeneration: 0 });
      authority.commit({ ...key, profileId: "profile-b", state: "live", observedAtMs: 1, source: "test", readGeneration: 0 });
      const lease = authority.claimProbe({ ...key, profileId: "profile-a", nowMs: 3, leaseMs: 250 });
      const otherLease = authority.claimProbe({ ...key, profileId: "profile-b", nowMs: 3, leaseMs: 250 });

      expect(authority.snapshotFor([{ ...key, profileId: "profile-a" }, { ...key, profileId: "profile-b" }]).rows)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ profileId: "profile-a", state: "exhausted" }),
          expect.objectContaining({ profileId: "profile-b", state: "live" }),
        ]));
      expect(lease.kind).toBe("won");
      expect(otherLease.kind).toBe("won");
    }
  });
});