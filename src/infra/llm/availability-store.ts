/**
 * Durable, account-scoped availability authority.
 *
 * One SQLite database holds what every Flywheel process knows about provider
 * availability. Account quota and terminal-auth rows use the canonical candidate
 * key, so subscription instances remain isolated and singleton providers retain
 * one account scope. Service-outage rows use provider identity alone, so one
 * outage suppresses every current and future account for that provider. These
 * rows are the authority, not a cache: a suppression one process commits is the
 * suppression the next process reads. Neither scope stores credentials, account
 * claims, or request content. Copilot spend is deliberately absent because it is
 * a process-local accumulator, not durable account state.
 *
 * Causality is a per-row generation, never write arrival: a writer states the
 * generation its decision read, and the commit lands only while the row is
 * still at that generation. A delayed exhaustion derived from generation N
 * cannot revert the live row that generation N+1 already records, and a probe
 * that started before a newer terminal failure cannot restore capacity after
 * it. An observation that changes no semantic field commits nothing and does
 * not move the global revision.
 *
 * An out-of-band capacity check (today only the Copilot meter poll) runs under
 * a probe lease: one claim per row wins, every other claimant loses at once
 * and never waits. The claim advances the row's fence, and a publish that
 * states a fence lands only while the row still holds it, so a winner whose
 * lease expired cannot publish after the next winner claimed. A fenced result
 * hands the lease back with it, including the one that restates what the row
 * already says. Long-running generic probes renew their fenced lease; a
 * crashed owner cannot renew, so another claimant takes it after one interval.
 *
 * The file is acquired when this authority is constructed, and a transient
 * acquisition failure costs only the operations it refuses: the next
 * operation acquires again, because a process that lost a startup race must
 * not spend its whole lifetime uncoordinated. Only confirmed corruption or a
 * foreign protocol prevents another acquisition attempt. An existing file
 * states its protocol before this
 * binary applies a pragma or a schema statement to it, so a file another
 * protocol wrote keeps its journal mode, its tables, and its siblings exactly
 * as they are. Only an authority that does not exist yet is created - an
 * absent file, or one that holds no objects at all - under one immediate
 * transaction so that two processes starting together produce one
 * incarnation. A file that holds another writer's objects and no authority
 * metadata is that writer's file, so this binary fails closed on it rather
 * than add its own schema beside it. Every operation after acquisition runs
 * under one small bounded wait: a commit is a microsecond WAL transaction, so
 * the wait absorbs the correlated write burst of many processes recording the
 * same exhaustion at once, while a file held longer than the bound is wedged
 * and the operation reports a transient failure rather than stall the
 * provider request it stands in front of.
 *
 * Disposal is one process leaving, not the account forgetting: it closes this
 * handle, hands back a probe lease this process still holds so the next
 * claimant does not wait it out, and leaves every row exactly as it is.
 *
 * Failures split in two. BUSY, LOCKED, permission, open, and I/O results are
 * transient: the caller keeps its in-memory projection and the database is
 * left exactly as it is. Only a SQLite corruption result, a current-schema row
 * that fails strict decoding, or metadata that fails it is confirmed
 * corruption, and that fails closed with a typed error. Decoding is semantic,
 * not structural: a suppression that states no end, a row that suppresses
 * nothing yet states one, a lease with no fence, and a fractional or negative
 * generation, fence, or moment are all corruption. The same invariants are
 * SQLite CHECK constraints, so a writer cannot put a row into the file that a
 * reader must then reject. Nothing here renames, rebuilds, or deletes the
 * database: other processes can hold it, and an authority that replaces
 * itself under them is two authorities.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Database, SQLiteError } from "bun:sqlite";
import { Schema } from "effect";
import { errorMessage } from "../error-message.js";
import { AccessProviderIdSchema } from "./access-provider.js";
import { applySqliteDurabilityPragmas } from "../sqlite-durability.js";
import { applyWindowsPrivateDirectoryAcl } from "../windows-private-directory-acl.js";

/** Bumped when the row or metadata shape changes. The authority's file name
 *  carries this version (`availabilityAuthorityDbFile`), so binaries speaking
 *  different protocols coordinate on different files and a bump strands
 *  nobody: the old file simply stops being read. The metadata check remains
 *  the backstop for a file at this path that states another version anyway,
 *  which belongs to a writer this binary cannot coordinate with, so this
 *  binary fails closed instead of guessing at its semantics. */
export const AVAILABILITY_PROTOCOL_VERSION = 8;

/** The wait spent while acquiring the file: two processes starting together
 *  must serialize their schema creation rather than one failing to take a
 *  file the other is still creating. */
const ACQUIRE_BUSY_TIMEOUT_MS = 250;

/** Upper bound one post-acquisition operation may wait behind another
 *  process's write. Commits are microsecond WAL transactions, so this absorbs
 *  the correlated burst when many processes record the same exhaustion at
 *  once - the moment coordination matters most - instead of failing their
 *  requests. bun:sqlite blocks synchronously for the wait, which stays
 *  negligible next to the provider request each operation stands in front
 *  of; a file held longer than this is wedged and reports transiently. */
const OPERATION_BUSY_TIMEOUT_MS = 100;


/** Source recorded on a row that exists only because a probe claimed a lease
 *  on it. It states no observation, which is what `probe_due` means. */
const PROBE_LEASE_SOURCE = "probe-lease";


/** What the account may do on this provider and window right now.
 *  `probe_due` is neither: it states that no observation is trusted and one
 *  request or poll should find out. */
type AvailabilityState = "live" | "exhausted" | "probe_due";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const AvailabilityRowSchema = Schema.Struct({
  scope: Schema.Literals(["account", "provider"] as const),
  provider: AccessProviderIdSchema,
  candidateKey: Schema.optionalKey(Schema.NonEmptyString),
  profileId: Schema.optionalKey(Schema.NonEmptyString),
  window: Schema.NonEmptyString,
  state: Schema.Literals(["live", "exhausted", "probe_due"] as const),
  generation: NonNegativeInt,
  observedAtMs: NonNegativeInt,
  resetsAtMs: Schema.optionalKey(PositiveInt),
  nextProbeAtMs: Schema.optionalKey(PositiveInt),
  source: Schema.NonEmptyString,
  fence: NonNegativeInt,
  leaseExpiresAtMs: NonNegativeInt,
}).check(Schema.makeFilter(rowInvariant));
const decodeAvailabilityRow = Schema.decodeUnknownSync(AvailabilityRowSchema);

const MetadataSchema = Schema.Struct({
  protocol_version: PositiveInt,
  incarnation: Schema.NonEmptyString,
  revision: NonNegativeInt,
});
const decodeMetadata = Schema.decodeUnknownSync(MetadataSchema);

/** What a row must mean, beyond what its columns must look like. A suppression
 *  states when it ends, a row that holds the account back at all is the
 *  `exhausted` one, and a live lease names the fence that took it. */
function rowInvariant(row: {
  readonly scope: "account" | "provider";
  readonly candidateKey?: string;
  readonly profileId?: string;
  readonly state: AvailabilityState;
  readonly resetsAtMs?: number;
  readonly nextProbeAtMs?: number;
  readonly fence: number;
  readonly leaseExpiresAtMs: number;
}): true | string {
  const accountIdentityPresent = row.candidateKey !== undefined && row.profileId !== undefined;
  if ((row.scope === "account") !== accountIdentityPresent) return "account rows require candidate and profile identities and provider rows forbid them";
  const statesAnEnd = row.resetsAtMs !== undefined || row.nextProbeAtMs !== undefined;
  if (row.state === "exhausted" && !statesAnEnd) return "an exhausted row states neither a reset nor a safe recheck moment";
  if (row.state !== "exhausted" && statesAnEnd) return `a ${row.state} row suppresses nothing, so it must state no reset or safe recheck moment`;
  if (row.leaseExpiresAtMs > 0 && row.fence === 0) return "a leased row states no fence";
  return true;
}

type DecodedAvailabilityRow = typeof AvailabilityRowSchema.Type;
export type AvailabilityKey =
  | { readonly scope: "account"; readonly provider: string; readonly profileId: string; readonly candidateKey: string; readonly window: string }
  | { readonly scope: "provider"; readonly provider: string; readonly window: string };
export type AvailabilityRow = AvailabilityKey & Omit<DecodedAvailabilityRow, "scope" | "provider" | "profileId" | "candidateKey" | "window">;

export function availabilityKey(row: Pick<DecodedAvailabilityRow, "scope" | "provider" | "profileId" | "candidateKey" | "window">): AvailabilityKey {
  if (row.scope === "provider") return { scope: "provider", provider: row.provider, window: row.window };
  if (row.candidateKey === undefined || row.profileId === undefined) throw new Error("Account availability row has no candidate or profile identity");
  return { scope: "account", provider: row.provider, profileId: row.profileId, candidateKey: row.candidateKey, window: row.window };
}

export type AvailabilityObservation = AvailabilityKey & {
  readonly state: AvailabilityState;
  readonly observedAtMs: number;
  readonly resetsAtMs?: number;
  readonly nextProbeAtMs?: number;
  readonly source: string;
  readonly readGeneration: number;
  readonly fence?: number;
};

type CommitResult =
  /** The row advanced to `row`, one generation on, and the revision moved. */
  | { readonly kind: "committed"; readonly row: AvailabilityRow }
  /** The observation restated the stored semantics; nothing was written. */
  | { readonly kind: "unchanged"; readonly row: AvailabilityRow }
  /** The row moved on since the observation was decided. `current` is the row
   *  that won, which the caller adopts instead of its own conclusion. */
  | { readonly kind: "rejected"; readonly current: AvailabilityRow | undefined };

interface AvailabilitySnapshot {
  /** Identifies the authority instance. A change means the durable state was
   *  replaced, so every projection taken from the old one is void. */
  readonly incarnation: string;
  /** Moves on every committed observation; unchanged by no-op observations. */
  readonly revision: number;
  readonly rows: readonly AvailabilityRow[];
}

/** A current-schema row that fails strict decoding, or a SQLite corruption
 *  result. The database is left untouched and the authority fails closed:
 *  every later operation throws this same error. */
export class AvailabilityCorruptError extends Schema.TaggedError<AvailabilityCorruptError>()("AvailabilityCorrupt", {
  message: Schema.String,
  at: Schema.String,
  reason: Schema.String,
}) {}

/** The file was written by a binary this one cannot coordinate with. Failing
 *  closed is the only safe answer: issuing uncoordinated provider requests
 *  would spend an account the other binary believes it is metering. */
export class AvailabilityProtocolError extends Schema.TaggedError<AvailabilityProtocolError>()("AvailabilityProtocol", {
  message: Schema.String,
  expected: Schema.Number,
  found: Schema.Number,
}) {}

/** Contention, permissions, or I/O. The caller keeps its in-memory projection
 *  and retries at its next observation; nothing about the file is suspect. */
export class AvailabilityTransientError extends Schema.TaggedError<AvailabilityTransientError>()("AvailabilityTransient", {
  message: Schema.String,
  at: Schema.String,
  reason: Schema.String,
}) {}

export interface AvailabilityAuthorityOptions {
  readonly dbFile: string;
  /** Installed access-provider vocabulary. A function form reads the live
   *  catalog on every check, so a provider a config reload installed is
   *  admitted without recreating the authority. */
  readonly providerIds?: readonly string[] | (() => readonly string[]);
}

type ProbeClaim = AvailabilityKey & {
  readonly nowMs: number;
  readonly leaseMs: number;
};

type ProbeClaimResult =
  /** This claimant may run one probe and publish under `row.fence`. */
  | { readonly kind: "won"; readonly row: AvailabilityRow; readonly revision: number }
  /** Another claimant holds the row until `row.leaseExpiresAtMs`. The loser
   *  continues with what the row already states; it never waits. */
  | { readonly kind: "lost"; readonly row: AvailabilityRow; readonly revision: number };

type ProbeRelease = AvailabilityKey & { readonly fence: number };
type ProbeRenew = ProbeRelease & { readonly nowMs: number; readonly leaseMs: number };

export interface AvailabilityAuthority {
  /** The rows of these keys alone, with the incarnation and revision they were
   *  read at. One point lookup per key: an owner reads and decodes the accounts
   *  it spends from, and never another account's rows. */
  snapshotFor(keys: readonly AvailabilityKey[]): AvailabilitySnapshot;
  /** The global revision alone. One indexed scalar read, which is what the
   *  request path spends to learn whether its projection is still current. */
  revision(): number;
  /** Applies one observation under generation compare-and-set, and under fence
   *  compare-and-set when the observation states one. A commit clears any
   *  probe lease on the row: whatever the probe was checking is now stated. */
  commit(observation: AvailabilityObservation): CommitResult;
  /** Takes the probe lease on one row when no live lease holds it. */
  claimProbe(claim: ProbeClaim): ProbeClaimResult;
  /** Extends a live lease while its fenced probe is still running. */
  renewProbe(renewal: ProbeRenew): boolean;
  /** Hands one probe lease back, so the next claimant does not wait it out.
   *  It states no observation: neither the generation nor the revision moves. */
  releaseProbe(release: ProbeRelease): void;
  /** Closes this process's handle. Idempotent, and every later operation
   *  fails transiently rather than reopening: this process has stopped
   *  speaking for the account. A probe lease this handle still holds is handed
   *  back first, so the next claimant does not wait out a lease no process is
   *  using. Every row is otherwise left exactly as it is - disposal is one
   *  process leaving, not the account forgetting. */
  dispose(): Promise<void>;
}

/** Column values as SQLite hands them back: a claim about the writer, which is
 *  why every column goes through the schema decode. */
interface RawRow {
  readonly scope: string;
  readonly provider: string;
  readonly candidate_key: string | null;
  readonly profile_id: string | null;
  readonly window: string;
  readonly state: string;
  readonly generation: number;
  readonly observed_at: number;
  readonly resets_at: number | null;
  readonly next_probe_at: number | null;
  readonly source: string;
  readonly fence: number;
  readonly lease_expires_at: number;
}

interface SelectRowBindings {
  [parameter: string]: string | null;
}

/** The CHECK constraints state the same invariants the decode enforces, so a
 *  writer cannot leave a row in the file that every reader must then reject. */
const CREATE_METADATA_TABLE = `
  create table if not exists availability_authority (
    id integer primary key check (id = 0),
    protocol_version integer not null check (protocol_version > 0),
    incarnation text not null check (length(incarnation) > 0),
    revision integer not null check (revision >= 0)
  )
`;

const CREATE_STATE_TABLE = `
  create table if not exists availability_state (
    scope text not null check (scope in ('account', 'provider')),
    provider text not null check (length(provider) > 0),
    candidate_key text,
    profile_id text,
    "window" text not null check (length("window") > 0),
    state text not null check (state in ('live', 'exhausted', 'probe_due')),
    generation integer not null check (generation >= 0),
    observed_at integer not null check (observed_at >= 0),
    resets_at integer,
    next_probe_at integer,
    source text not null check (length(source) > 0),
    fence integer not null check (fence >= 0),
    lease_expires_at integer not null check (lease_expires_at >= 0),
    check ((scope = 'account') = (candidate_key is not null and length(candidate_key) > 0 and profile_id is not null and length(profile_id) > 0)),
    check ((scope = 'provider') = (candidate_key is null and profile_id is null)),
    check ((state = 'exhausted') = (resets_at is not null or next_probe_at is not null)),
    check (lease_expires_at = 0 or fence > 0)
  );
  create unique index if not exists availability_account_key on availability_state(profile_id, candidate_key, "window") where scope = 'account';
  create unique index if not exists availability_provider_key on availability_state(provider, "window") where scope = 'provider';
`;

const SELECT_ROW = `
  select scope, provider, profile_id, candidate_key, "window", state, generation, observed_at, resets_at, next_probe_at, source, fence, lease_expires_at
  from availability_state
  where scope = $scope and provider = $provider and profile_id is $profileId and candidate_key is $candidateKey and "window" = $window
`;
const SELECT_ROWS = `
  with requested(scope, provider, profile_id, candidate_key, "window") as (
    select json_extract(value, '$.scope'), json_extract(value, '$.provider'), json_extract(value, '$.profileId'), json_extract(value, '$.candidateKey'), json_extract(value, '$.window')
    from json_each($keys)
  )
  select s.scope, s.provider, s.profile_id, s.candidate_key, s."window", s.state, s.generation, s.observed_at, s.resets_at, s.next_probe_at, s.source, s.fence, s.lease_expires_at
  from availability_state s
  join requested r on s.scope = r.scope and s.provider = r.provider and s.profile_id is r.profile_id and s.candidate_key is r.candidate_key and s."window" = r."window"
`;


const UPSERT_ROW = `
  insert into availability_state (scope, provider, profile_id, candidate_key, "window", state, generation, observed_at, resets_at, next_probe_at, source, fence, lease_expires_at)
  values ($scope, $provider, $profileId, $candidateKey, $window, $state, $generation, $observedAt, $resetsAt, $nextProbeAt, $source, $fence, $leaseExpiresAt)
  on conflict do update set
    state = excluded.state,
    generation = excluded.generation,
    observed_at = excluded.observed_at,
    resets_at = excluded.resets_at,
    next_probe_at = excluded.next_probe_at,
    source = excluded.source,
    fence = excluded.fence,
    lease_expires_at = excluded.lease_expires_at
`;

const CLAIM_PROBE = `
  insert into availability_state (scope, provider, profile_id, candidate_key, "window", state, generation, observed_at, resets_at, next_probe_at, source, fence, lease_expires_at)
  values ($scope, $provider, $profileId, $candidateKey, $window, 'probe_due', 0, $nowMs, null, null, $source, 1, $leaseExpiresAt)
  on conflict do update set
    fence = fence + 1,
    lease_expires_at = excluded.lease_expires_at
`;

const RELEASE_PROBE = `update availability_state set lease_expires_at = 0 where scope = $scope and provider = $provider and profile_id is $profileId and candidate_key is $candidateKey and "window" = $window and fence = $fence`;
const RENEW_PROBE = `update availability_state set lease_expires_at = $leaseExpiresAt where scope = $scope and provider = $provider and profile_id is $profileId and candidate_key is $candidateKey and "window" = $window and fence = $fence and lease_expires_at > 0`;

function isCorruption(error: unknown): boolean {
  if (!(error instanceof SQLiteError) || error.code === undefined) return false;
  return error.code.startsWith("SQLITE_CORRUPT") || error.code === "SQLITE_NOTADB";
}

/** One row's identity, as the map of held leases keys it. */
function rowKey(key: AvailabilityKey): string {
  return `${key.scope}\u0000${key.provider}\u0000${key.scope === "account" ? `${key.profileId}\u0000${key.candidateKey}` : ""}\u0000${key.window}`;
}

export function createAvailabilityAuthority({ dbFile, providerIds }: AvailabilityAuthorityOptions): AvailabilityAuthority {
  const isInstalledProvider = providerIds === undefined
    ? () => true
    : typeof providerIds === "function"
      ? (provider: string) => providerIds().includes(provider)
      : (provider: string) => providerIds.includes(provider);
  const requireInstalledProvider = (provider: string): void => {
    if (!isInstalledProvider(provider)) {
      throw new AvailabilityCorruptError({
        message: `Unknown installed access provider id: ${provider}`,
        at: provider,
        reason: `Provider ${provider} is not in the installed catalog`,
      });
    }
  };
  /** The handle this process holds, or the failure that stands in for it. A
   *  transient failure in its place is retried: the next operation acquires
   *  again, so a lost startup race costs the operations it refused rather
   *  than the process's lifetime. Confirmed corruption and a foreign protocol
   *  latch, and the authority never recovers itself from those: rebuilding
   *  while other processes hold the file would split the account's state in
   *  two. */
  let state: Database | Error;
  /** Set by dispose. Distinct from a failure: nothing is wrong with the file,
   *  this process is gone from it. */
  let disposed = false;
  /** The probe leases this handle holds, by row, each with the fence it was
   *  taken at. A fenced commit and a release both conclude one; disposal hands
   *  back whatever is left, so the next claimant never waits out a lease no
   *  process is using. */
  const heldLeases = new Map<string, ProbeRelease>();

  /** What a raw failure means. Confirmed corruption and a foreign protocol are
   *  fatal; contention, permissions, and I/O are transient and cost the caller
   *  only the operation it asked for. */
  function classify(error: unknown, at: string): Error {
    if (error instanceof AvailabilityCorruptError || error instanceof AvailabilityProtocolError || error instanceof AvailabilityTransientError) return error;
    if (isCorruption(error)) {
      return new AvailabilityCorruptError({
        message: `The availability authority is corrupt (${at}): ${errorMessage(error)}`,
        at,
        reason: errorMessage(error),
      });
    }
    return new AvailabilityTransientError({
      message: `The availability authority is unreachable (${at}): ${errorMessage(error)}`,
      at,
      reason: errorMessage(error),
    });
  }

  /** Classifies a failure and, when it is fatal, puts it in place of the
   *  handle, so every later operation reports the same reason. */
  function fail(error: unknown, at: string): Error {
    const classified = classify(error, at);
    if (classified instanceof AvailabilityTransientError) return classified;
    if (state instanceof Database) state.close();
    state = classified;
    return classified;
  }

  function assertProtocol(found: number): void {
    if (found === AVAILABILITY_PROTOCOL_VERSION) return;
    throw new AvailabilityProtocolError({
      message: `The availability authority speaks protocol ${found}; this binary speaks ${AVAILABILITY_PROTOCOL_VERSION}. Availability is not coordinated until the processes agree.`,
      expected: AVAILABILITY_PROTOCOL_VERSION,
      found,
    });
  }

  /** The protocol an existing file states, or undefined when it holds nothing
   *  at all, which is the one case this binary may create. A file that holds
   *  objects but no authority metadata belongs to another writer: this binary
   *  fails closed on it rather than add its schema to a file it does not own.
   *  Reading `sqlite_master` writes nothing, so a file this binary must not
   *  touch is inspected without being touched. */
  function statedProtocolVersion(opened: Database): number | undefined {
    const objects = opened.query<{ name: string }, []>(`select name from sqlite_master`).all();
    if (objects.some((object) => object.name === "availability_authority")) return readMetadata(opened).protocol_version;
    if (objects.length === 0) return undefined;
    throw new AvailabilityProtocolError({
      message: `The availability authority file holds another writer's objects (${objects.map((object) => object.name).sort().join(", ")}) and no authority metadata. Availability is not coordinated until the processes agree.`,
      expected: AVAILABILITY_PROTOCOL_VERSION,
      found: 0,
    });
  }

  /** Creates the tables and the singleton metadata row of an authority that
   *  does not exist yet. One immediate transaction does both, so two processes
   *  starting together serialize and observe one incarnation. */
  function initialize(opened: Database): void {
    opened.transaction((): void => {
      opened.exec(CREATE_METADATA_TABLE);
      opened.exec(CREATE_STATE_TABLE);
      opened.query(`insert or ignore into availability_authority (id, protocol_version, incarnation, revision) values (0, $version, $incarnation, 0)`)
        .run({ $version: AVAILABILITY_PROTOCOL_VERSION, $incarnation: randomUUID() });
      // A process of another binary may have created the file first.
      assertProtocol(readMetadata(opened).protocol_version);
    }).immediate();
  }

  /** Takes the file for this process, once. It reports the failure rather than
   *  throwing it, and it never latches: nothing has been put in place of the
   *  handle yet. */
  function acquire(): Database | Error {
    let opened: Database | undefined;
    try {
      const createdDirectory = fs.mkdirSync(path.dirname(dbFile), { recursive: true });
      if (createdDirectory !== undefined && process.platform === "win32") {
        applyWindowsPrivateDirectoryAcl(path.dirname(dbFile));
      }
      const existed = fs.existsSync(dbFile);
      opened = new Database(dbFile, { create: true });
      const stated = existed ? statedProtocolVersion(opened) : undefined;
      if (stated !== undefined) assertProtocol(stated);
      // The acquisition wait must be in force before the first lock-taking
      // statement: WAL setup and schema creation both take a write lock, and a
      // handle without a busy handler fails them instantly under contention.
      applySqliteDurabilityPragmas(opened, ACQUIRE_BUSY_TIMEOUT_MS);
      if (stated === undefined) initialize(opened);
      // Every operation from here stands in front of a provider request: it
      // waits out a concurrent microsecond commit, never a wedged file.
      opened.exec(`PRAGMA busy_timeout = ${OPERATION_BUSY_TIMEOUT_MS}`);
      return opened;
    } catch (error) {
      opened?.close();
      return classify(error, "acquiring the availability authority");
    }
  }

  function handle(): Database {
    if (disposed) {
      throw new AvailabilityTransientError({
        message: "The availability authority handle is disposed",
        at: "using a disposed availability authority",
        reason: "disposed",
      });
    }
    // A transient acquisition failure is retried here, once per operation:
    // the contention or I/O blip that lost the startup race is long gone by
    // the first request, and a process that never re-acquires serves no
    // coordinated request for its whole lifetime.
    if (state instanceof AvailabilityTransientError) state = acquire();
    // oxlint-disable-next-line eslint/no-throw-literal -- boundary: `state` holds the typed corruption, protocol, or acquisition failure in place of the handle; every call reports the same one.
    if (state instanceof Error) throw state;
    return state;
  }

  function readMetadata(opened: Database): typeof MetadataSchema.Type {
    const metadata = opened.query<unknown, []>(`select protocol_version, incarnation, revision from availability_authority where id = 0`).get();
    if (!metadata) {
      throw new AvailabilityCorruptError({
        message: "The availability authority has no metadata row",
        at: "reading the authority metadata",
        reason: "missing singleton metadata row",
      });
    }
    try {
      return decodeMetadata(metadata);
    } catch (error) {
      throw new AvailabilityCorruptError({
        message: `Malformed availability authority metadata: ${errorMessage(error)}`,
        at: "reading the authority metadata",
        reason: errorMessage(error),
      });
    }
  }

  function decodeRow(raw: RawRow): AvailabilityRow {
    const candidate = {
      scope: raw.scope,
      provider: raw.provider,
      ...(raw.profile_id === null ? {} : { profileId: raw.profile_id }),
      window: raw.window,
      state: raw.state,
      generation: raw.generation,
      observedAtMs: raw.observed_at,
      source: raw.source,
      fence: raw.fence,
      leaseExpiresAtMs: raw.lease_expires_at,
      ...(raw.candidate_key === null ? {} : { candidateKey: raw.candidate_key }),
      ...(raw.resets_at === null ? {} : { resetsAtMs: raw.resets_at }),
      ...(raw.next_probe_at === null ? {} : { nextProbeAtMs: raw.next_probe_at }),
    };
    try {
      const decoded = decodeAvailabilityRow(candidate);
      if (!isInstalledProvider(decoded.provider)) throw new Error(`Unknown installed access provider id: ${decoded.provider}`);
      return { ...decoded, ...availabilityKey(decoded) };
    } catch (error) {
      const identity = `${raw.scope}/${raw.provider}/${raw.profile_id ?? "global"}/${raw.candidate_key ?? "provider"}/${raw.window}`;
      throw new AvailabilityCorruptError({
        message: `Malformed availability row for ${identity}: ${errorMessage(error)}`,
        at: identity,
        reason: errorMessage(error),
      });
    }
  }

  function keyBindings(key: AvailabilityKey): SelectRowBindings {
    return {
      $scope: key.scope,
      $provider: key.provider,
      $profileId: key.scope === "account" ? key.profileId : null,
      $candidateKey: key.scope === "account" ? key.candidateKey : null,
      $window: key.window,
    };
  }

  function currentRow(opened: Database, key: AvailabilityKey): AvailabilityRow | undefined {
    requireInstalledProvider(key.provider);
    const raw = opened.query<RawRow, [SelectRowBindings]>(SELECT_ROW).get(keyBindings(key));
    return raw ? decodeRow(raw) : undefined;
  }

  /** Forgets a lease this handle no longer holds: a commit that landed under a
   *  fence cleared the row's lease with it, and a release hands one back. A
   *  fence another claimant superseded is not this handle's to forget. */
  function forgetLease(key: AvailabilityKey, fence: number): void {
    if (heldLeases.get(rowKey(key))?.fence === fence) heldLeases.delete(rowKey(key));
  }

  /** Hands back the lease a fenced observation was made under. A result that
   *  restates what the row already says still concludes the probe, so the row
   *  keeps its semantics and its generation while the next claimant stops
   *  waiting a finished probe out. */
  function releaseFencedLease(opened: Database, current: AvailabilityRow, observation: AvailabilityObservation): AvailabilityRow {
    if (observation.fence === undefined || current.leaseExpiresAtMs === 0) return current;
    opened.query(RELEASE_PROBE).run({ ...keyBindings(availabilityKey(current)), $fence: current.fence });
    return { ...current, leaseExpiresAtMs: 0 };
  }

  state = acquire();

  return {
    snapshotFor(keys) {
      const opened = handle();
      try {
        for (const key of keys) requireInstalledProvider(key.provider);
        return opened.transaction((): AvailabilitySnapshot => {
          const metadata = readMetadata(opened);
          const encoded = JSON.stringify(keys.map((key) => ({ ...key, profileId: key.scope === "account" ? key.profileId : null, candidateKey: key.scope === "account" ? key.candidateKey : null })));
          const rows = opened.query<RawRow, [{ $keys: string }]>(SELECT_ROWS).all({ $keys: encoded }).map(decodeRow);
          return { incarnation: metadata.incarnation, revision: metadata.revision, rows };
        }).deferred();
      } catch (error) {
        throw fail(error, "reading the availability authority");
      }
    },

    revision() {
      const opened = handle();
      try {
        return readMetadata(opened).revision;
      } catch (error) {
        throw fail(error, "reading the availability revision");
      }
    },

    commit(observation) {
      const opened = handle();
      try {
        const result = opened.transaction((): CommitResult => {
          const current = currentRow(opened, observation);
          if (observation.fence !== undefined && (current?.fence ?? 0) !== observation.fence) return { kind: "rejected", current };
          if (current && restatesRow(current, observation)) return { kind: "unchanged", row: releaseFencedLease(opened, current, observation) };
          if ((current?.generation ?? 0) !== observation.readGeneration) return { kind: "rejected", current };
          const row: AvailabilityRow = {
            ...(observation.scope === "account"
              ? { scope: "account" as const, provider: observation.provider, profileId: observation.profileId, candidateKey: observation.candidateKey, window: observation.window }
              : { scope: "provider" as const, provider: observation.provider, window: observation.window }),
            state: observation.state,
            generation: observation.readGeneration + 1,
            observedAtMs: observation.observedAtMs,
            source: observation.source,
            fence: current?.fence ?? 0,
            leaseExpiresAtMs: 0,
            ...(observation.resetsAtMs === undefined ? {} : { resetsAtMs: observation.resetsAtMs }),
            ...(observation.nextProbeAtMs === undefined ? {} : { nextProbeAtMs: observation.nextProbeAtMs }),
          };
          opened.query(UPSERT_ROW).run({
            ...keyBindings(availabilityKey(row)),
            $state: row.state,
            $generation: row.generation,
            $observedAt: row.observedAtMs,
            $resetsAt: row.resetsAtMs ?? null,
            $nextProbeAt: row.nextProbeAtMs ?? null,
            $source: row.source,
            $fence: row.fence,
            $leaseExpiresAt: row.leaseExpiresAtMs,
          });
          opened.query(`update availability_authority set revision = revision + 1 where id = 0`).run();
          return { kind: "committed", row };
        }).immediate();
        // A landed commit states the probe's one result and clears the lease
        // with it. A rejected one changed nothing, so a lease this handle still
        // holds is still its own to hand back.
        if (observation.fence !== undefined && result.kind !== "rejected") forgetLease(observation, observation.fence);
        return result;
      } catch (error) {
        throw fail(error, "committing an availability observation");
      }
    },

    claimProbe(claim) {
      const opened = handle();
      try {
        const result = opened.transaction((): ProbeClaimResult => {
          const revision = readMetadata(opened).revision;
          const current = currentRow(opened, claim);
          if (current && current.leaseExpiresAtMs > claim.nowMs) return { kind: "lost", row: current, revision };
          const leaseExpiresAtMs = claim.nowMs + claim.leaseMs;
          opened.query(CLAIM_PROBE).run({
            ...keyBindings(claim),
            $nowMs: claim.nowMs,
            $source: PROBE_LEASE_SOURCE,
            $leaseExpiresAt: leaseExpiresAtMs,
          });
          // The lease is not an observation: it moves neither the generation
          // nor the revision, so no other owner's projection is invalidated by
          // a check that has not concluded anything yet.
          return {
            kind: "won",
            revision,
            row: current
              ? { ...current, fence: current.fence + 1, leaseExpiresAtMs }
              : {
                ...claim,
                state: "probe_due",
                generation: 0,
                observedAtMs: claim.nowMs,
                source: PROBE_LEASE_SOURCE,
                fence: 1,
                leaseExpiresAtMs,
              },
          };
        }).immediate();
        if (result.kind === "won") {
          heldLeases.set(rowKey(claim), { ...claim, fence: result.row.fence });
        }
        return result;
      } catch (error) {
        throw fail(error, "claiming an availability probe lease");
      }
    },

    renewProbe(renewal) {
      const opened = handle();
      try {
        return opened.transaction((): boolean => {
          const current = currentRow(opened, renewal);
          if (!current || current.fence !== renewal.fence || current.leaseExpiresAtMs === 0) return false;
          opened.query(RENEW_PROBE).run({
            ...keyBindings(renewal),
            $fence: renewal.fence,
            $leaseExpiresAt: renewal.nowMs + renewal.leaseMs,
          });
          return true;
        }).immediate();
      } catch (error) {
        throw fail(error, "renewing an availability probe lease");
      }
    },

    releaseProbe(release) {
      const opened = handle();
      try {
        requireInstalledProvider(release.provider);
        opened.query(RELEASE_PROBE).run({ ...keyBindings(release), $fence: release.fence });
        forgetLease(release, release.fence);
      } catch (error) {
        throw fail(error, "releasing an availability probe lease");
      }
    },

    async dispose() {
      if (disposed) return;
      disposed = true;
      if (!(state instanceof Database)) return;
      try {
        // A lease this handle still holds is nobody's the moment the process
        // leaves, so it is handed back under its fence: a fence another
        // claimant superseded releases nothing.
        for (const held of heldLeases.values()) {
          state.query(RELEASE_PROBE).run({ ...keyBindings(held), $fence: held.fence });
        }
      } catch {
        // A release a contended file refused costs the next claimant the rest
        // of the lease term, which bounds it anyway. Leaving is not a failure.
      }
      heldLeases.clear();
      state.close();
    },
  };
}

/** Whether the observation states what the row already states. Source and
 *  observation time are forensics, so restating them writes nothing and keeps
 *  the revision still for the many identical observations a busy account
 *  produces. */
function restatesRow(row: AvailabilityRow, observation: AvailabilityObservation): boolean {
  return row.state === observation.state
    && row.resetsAtMs === observation.resetsAtMs
    && row.nextProbeAtMs === observation.nextProbeAtMs;
}