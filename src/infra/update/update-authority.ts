/**
 * The account-global update authority.
 *
 * One protocol-versioned SQLite file under `userDataRoot` holds two facts
 * every Flywheel process for the account shares: when an update check last
 * succeeded, and which claimant currently owns the right to do update work.
 * The account service's coordinator and its update Worker, the manual update
 * command, and the installer all coordinate through it, because installation
 * and update policy are account-global while processes are not (ARCH-DISTRIBUTION-020).
 *
 * A claimant asks for the work and gets one of three answers. The stored
 * check is still fresh, so nobody needs to look. Another claimant holds a
 * live lease, so this one stops immediately and never waits. Or this
 * claimant wins the lease and receives a fence.
 *
 * The fence, not the lease clock, is the authority. A winner renews its
 * bounded lease while its work makes progress; a winner that crashes cannot
 * renew, so the lease expires and the next claimant wins the next fence.
 * Every publication - a check result, and an activation - lands only while
 * the row still holds the fence it states, so a claimant that was superseded
 * while it was downloading can publish nothing. That is what orders two valid
 * update candidates, which an atomic rename alone cannot do.
 *
 * Activation is one transaction that verifies the fence, performs the
 * caller's `current` rename, and then commits the check timestamp. The
 * filesystem therefore becomes true before the database claims it did. A
 * crash in between leaves the new build active and the check stale, and the
 * next claimant repairs exactly that with `commitCheck` alone: it reads the
 * physical build, sees the work already done, and commits only the timestamp.
 *
 * The file is private by construction and contained by descriptor. The
 * account data root is opened from the account home and never through a link
 * at its own name, the `update` directory below it is created and held open
 * for the life of this handle, and the database and both SQLite sidecars are
 * admitted through that held directory as owner-only regular files, so a link
 * planted at one of those names is refused rather than followed. SQLite is
 * handed a path, which no caller of a path-taking library can avoid, so the
 * held directory is proved to still be the directory that path names
 * immediately before the database is opened and again once the sidecars exist.
 *
 * Construction fails loudly - a foreign protocol, a file another writer owns,
 * or unreadable state all mean this binary cannot coordinate, and an
 * uncoordinated updater is worse than none. Confirmed corruption latches:
 * nothing here rebuilds, renames, or deletes the file, because other
 * processes may hold it and an authority that replaces itself under them is
 * two authorities.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { Database, SQLiteError } from "bun:sqlite";
import { Schema } from "effect";
import { errorMessage } from "../error-message.js";
import { ContainedDirectory } from "../descriptor-directory.js";
import { applySqliteBusyTimeout, applySqliteDurabilityPragmas } from "../sqlite-durability.js";

/** Bumped when the stored shape changes. The file name carries this version
 *  (`updateAuthorityDbFile`), so binaries speaking different protocols
 *  coordinate on different files and a bump strands nobody. The metadata
 *  check is the backstop for a file at this path that states another version
 *  anyway. */
export const UPDATE_PROTOCOL_VERSION = 1;

/** Ordinary authority operations wait briefly for an honest overlap. WAL setup
 *  has a separate bounded retry because Bun can surface its cold-open lock
 *  before SQLite's busy handler settles that initialization race. */
const BUSY_TIMEOUT_MS = 250;
const OPEN_MAX_ATTEMPTS = 8;
const OPEN_RETRY_BASE_MS = 20;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const StateSchema = Schema.Struct({
  protocol_version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  /** Identifies this authority instance. Stored and validated because the
   *  protocol names it; no decision reads it, so nothing projects it. */
  incarnation: Schema.NonEmptyString,
  /** When a check last succeeded, in epoch milliseconds. Zero means never. */
  checked_at: NonNegativeInt,
  /** Advances on every won lease. */
  fence: NonNegativeInt,
  /** When the current lease ends. Zero once no claimant holds one. */
  lease_expires_at: NonNegativeInt,
}).check(Schema.makeFilter((row: { readonly fence: number; readonly lease_expires_at: number }) => row.lease_expires_at === 0 || row.fence > 0 || "a leased authority states no fence"));
const decodeState = Schema.decodeUnknownSync(StateSchema);

interface UpdateClaimRequest {
  readonly nowMs: number;
  /** How long a successful check stays good. */
  readonly freshForMs: number;
  /** How long the winner holds the lease before it must renew. */
  readonly leaseMs: number;
}

type UpdateClaim =
  /** A check inside the freshness window already answered the question. */
  | { readonly kind: "fresh"; readonly checkedAtMs: number }
  /** Another claimant owns the work until `leaseExpiresAtMs`. */
  | { readonly kind: "busy"; readonly leaseExpiresAtMs: number }
  /** This claimant owns the work and publishes under `fence`. */
  | { readonly kind: "won"; readonly fence: number; readonly leaseExpiresAtMs: number };

/** What one renewal found. Only `superseded` means another claimant owns the
 *  work: a claimant that concluded its own lease, for example through an
 *  activation another handle committed under its fence, has nothing left to
 *  renew and nothing to abandon. */
export type UpdateLeaseRenewal = "held" | "concluded" | "superseded";

export interface UpdateAuthority {
  /** Asks for the update work. Never waits for another claimant. */
  claim(request: UpdateClaimRequest): UpdateClaim;
  /** Extends a lease this claimant still holds. A lease a commit under this
   *  fence already concluded, or that this fence's handle handed back, is
   *  `concluded`: the work it was won for is done, and nobody took it over. A
   *  fence another claimant advanced is `superseded`. */
  renew(request: { readonly fence: number; readonly nowMs: number; readonly leaseMs: number }): UpdateLeaseRenewal;
  /** Records one successful check under the fence and concludes the lease.
   *  This is also the stale-success repair: a claimant that finds the build
   *  already active commits the timestamp alone. False when superseded. */
  commitCheck(request: { readonly fence: number; readonly checkedAtMs: number }): boolean;
  /** Activates under the fence: verifies it, runs `activate`, then commits
   *  the check in one transaction, so the database never claims an
   *  activation the filesystem has not made true. A throwing `activate`
   *  commits nothing and propagates. False when superseded, in which case
   *  `activate` never runs. */
  commitActivation(request: { readonly fence: number; readonly checkedAtMs: number; readonly activate: () => void }): boolean;
  /** Closes this process's handle. Idempotent. A lease this handle still
   *  holds is handed back first. */
  dispose(): void;
}

/** The stored state cannot mean anything. The file is left exactly as it is
 *  and this handle fails closed. */
class UpdateAuthorityCorruptError extends Schema.TaggedError<UpdateAuthorityCorruptError>()("UpdateAuthorityCorrupt", {
  message: Schema.String,
  reason: Schema.String,
}) {}

/** The file belongs to a binary this one cannot coordinate with. */
class UpdateAuthorityProtocolError extends Schema.TaggedError<UpdateAuthorityProtocolError>()("UpdateAuthorityProtocol", {
  message: Schema.String,
  expected: Schema.Number,
  found: Schema.Number,
}) {}

/** Contention, permissions, or I/O. Nothing about the file is suspect and the
 *  caller may ask again later; an update check that cannot coordinate simply
 *  does not happen. */
class UpdateAuthorityTransientError extends Schema.TaggedError<UpdateAuthorityTransientError>()("UpdateAuthorityTransient", {
  message: Schema.String,
  at: Schema.String,
  reason: Schema.String,
}) {}

const CREATE_TABLE = `
  create table update_authority (
    id integer primary key check (id = 0),
    protocol_version integer not null check (protocol_version > 0),
    incarnation text not null check (length(incarnation) > 0),
    checked_at integer not null check (checked_at >= 0),
    fence integer not null check (fence >= 0),
    lease_expires_at integer not null check (lease_expires_at >= 0),
    check (lease_expires_at = 0 or fence > 0)
  )
`;

const SELECT_STATE = `select protocol_version, incarnation, checked_at, fence, lease_expires_at from update_authority where id = 0`;
const AUTHORITY_COLUMNS = [
  { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
  { name: "protocol_version", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "incarnation", type: "TEXT", notnull: 1, pk: 0 },
  { name: "checked_at", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "fence", type: "INTEGER", notnull: 1, pk: 0 },
  { name: "lease_expires_at", type: "INTEGER", notnull: 1, pk: 0 },
] as const;
const WIN_LEASE = `update update_authority set fence = fence + 1, lease_expires_at = $leaseExpiresAt where id = 0`;
const SET_LEASE = `update update_authority set lease_expires_at = $leaseExpiresAt where id = 0`;
const RELEASE_LEASE = `update update_authority set lease_expires_at = 0 where id = 0 and fence = $fence`;
const COMMIT_CHECK = `update update_authority set checked_at = $checkedAt, lease_expires_at = 0 where id = 0 and fence = $fence and lease_expires_at != 0`;

export interface UpdateAuthorityOptions {
  /** The authority file, located by `updateAuthorityDbFile`: the account data
   *  root, the `update` directory below it, and the protocol-versioned file
   *  name. The two directories above the name are the boundary this handle
   *  admits and holds, so no other path belongs here. */
  readonly dbFile: string;
}

export function createUpdateAuthority({ dbFile }: UpdateAuthorityOptions): UpdateAuthority {
  const { db, updateDirectory } = open(dbFile);
  /** Replaces the handle once a failure is confirmed fatal, so every later
   *  operation reports the same reason instead of reading state nobody can
   *  trust. */
  let fatal: Error | undefined;
  let disposed = false;
  /** The fence of the lease this handle holds, if any. Disposal hands it
   *  back, so the next claimant never waits out a lease no process uses. */
  let heldFence: number | undefined;

  function handle(): Database {
    if (disposed) throw new UpdateAuthorityTransientError({ message: "The update authority handle is disposed", at: "using a disposed update authority", reason: "disposed" });
    // oxlint-disable-next-line eslint/no-throw-literal -- boundary: `fatal` holds the typed corruption or protocol failure that replaced the handle; every call reports the same one.
    if (fatal) throw fatal;
    return db;
  }

  /** Classifies a failure and, when it is fatal, puts it in place of the
   *  handle. */
  function fail(error: unknown, at: string): Error {
    const classified = classify(error, at);
    if (classified instanceof UpdateAuthorityTransientError) return classified;
    fatal ??= classified;
    return classified;
  }

  function readState(opened: Database): typeof StateSchema.Type {
    const row = opened.query<unknown, []>(SELECT_STATE).get();
    if (!row) throw new UpdateAuthorityCorruptError({ message: "The update authority has no state row", reason: "missing singleton state row" });
    try {
      return decodeState(row);
    } catch (error) {
      throw new UpdateAuthorityCorruptError({ message: `Malformed update authority state: ${errorMessage(error)}`, reason: errorMessage(error) });
    }
  }

  /** Runs one write under the fence. A superseded claimant changes nothing,
   *  and `effect` runs only after the fence is verified inside the same
   *  transaction, so it cannot outlive the right to perform it. */
  function commitUnderFence(fence: number, checkedAtMs: number, effect: (() => void) | undefined, at: string): boolean {
    const opened = handle();
    let committed: boolean;
    try {
      committed = opened.transaction((): boolean => {
        const row = readState(opened);
        if (row.fence !== fence || row.lease_expires_at === 0) return false;
        effect?.();
        const result = opened.query(COMMIT_CHECK).run({ $checkedAt: checkedAtMs, $fence: fence });
        return result.changes === 1;
      }).immediate();
    } catch (error) {
      throw fail(error, at);
    }
    // A landed commit concludes the lease with it; a superseded one never
    // held it.
    if (heldFence === fence) heldFence = undefined;
    return committed;
  }

  return {
    claim(request) {
      const opened = handle();
      try {
        const claim = opened.transaction((): UpdateClaim => {
          const row = readState(opened);
          // A check stamped ahead of this clock is not evidence of anything,
          // so it is stale rather than fresh until the clocks agree again.
          if (row.checked_at > 0 && row.checked_at <= request.nowMs && request.nowMs - row.checked_at < request.freshForMs) {
            return { kind: "fresh", checkedAtMs: row.checked_at };
          }
          if (row.lease_expires_at > request.nowMs) return { kind: "busy", leaseExpiresAtMs: row.lease_expires_at };
          const leaseExpiresAtMs = request.nowMs + request.leaseMs;
          opened.query(WIN_LEASE).run({ $leaseExpiresAt: leaseExpiresAtMs });
          return { kind: "won", fence: row.fence + 1, leaseExpiresAtMs };
        }).immediate();
        if (claim.kind === "won") heldFence = claim.fence;
        return claim;
      } catch (error) {
        throw fail(error, "claiming the update lease");
      }
    },

    renew(request) {
      const opened = handle();
      try {
        return opened.transaction((): UpdateLeaseRenewal => {
          const row = readState(opened);
          if (row.fence !== request.fence) return "superseded";
          if (row.lease_expires_at === 0) return "concluded";
          // An expired lease nobody else has taken is still this claimant's
          // to extend: the fence, not the clock, decides who may publish.
          opened.query(SET_LEASE).run({ $leaseExpiresAt: request.nowMs + request.leaseMs });
          return "held";
        }).immediate();
      } catch (error) {
        throw fail(error, "renewing the update lease");
      }
    },

    commitCheck({ fence, checkedAtMs }) {
      return commitUnderFence(fence, checkedAtMs, undefined, "committing an update check");
    },

    commitActivation({ fence, checkedAtMs, activate }) {
      return commitUnderFence(fence, checkedAtMs, activate, "committing an update activation");
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      try {
        if (heldFence !== undefined && !fatal) db.query(RELEASE_LEASE).run({ $fence: heldFence });
      } catch {
        // A release a contended file refused costs the next claimant the rest
        // of the lease term, which bounds it anyway. Leaving is not a failure.
      }
      heldFence = undefined;
      db.close();
      updateDirectory.close();
    },
  };
}

/** Takes the file for this process. Every name SQLite is about to follow is
 *  admitted through the held `update` directory first, because SQLite follows
 *  the names it is handed and a link at the database or either sidecar would
 *  redirect the account's update state out of the account. The database is
 *  created here rather than by SQLite, so from this point the name is a
 *  regular file this account owns and nothing else can take it. */
function open(dbFile: string) {
  const authorityDir = path.dirname(dbFile);
  const dbName = path.basename(dbFile);
  let updateDirectory: ContainedDirectory;
  try {
    updateDirectory = openUpdateDirectory(authorityDir);
  } catch (error) {
    throw classify(error, "opening the update authority directory");
  }
  for (let attempt = 0; attempt < OPEN_MAX_ATTEMPTS; attempt += 1) {
    let opened: Database | undefined;
    try {
      // A zero-length file is an empty SQLite database, and a peer that created
      // it first created the same owner-only file, so losing that race is not a
      // failure.
      if (!updateDirectory.admitPrivateFile(dbName)) updateDirectory.createExclusive(dbName, "");
      admitSidecars(updateDirectory, dbName);
      updateDirectory.requireSamePathAs(authorityDir);

      opened = new Database(dbFile, { create: true });
      // Even the first schema read can overlap a peer's initialization write.
      // Install the wait policy before any statement touches the database.
      applySqliteBusyTimeout(opened, BUSY_TIMEOUT_MS);
      const stated = statedProtocolVersion(opened);
      requireCompatibleProtocol(stated);
      applySqliteDurabilityPragmas(opened, BUSY_TIMEOUT_MS);
      if (stated === undefined) initialize(opened);
      updateDirectory.requireSamePathAs(authorityDir);
      return { db: opened, updateDirectory };
    } catch (error) {
      opened?.close();
      if (!isRetryableOpenFailure(error) || attempt === OPEN_MAX_ATTEMPTS - 1) {
        updateDirectory.close();
        throw classify(error, "opening the update authority");
      }
      const delayMs = OPEN_RETRY_BASE_MS * 2 ** Math.min(attempt, 3);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  updateDirectory.close();
  throw new UpdateAuthorityTransientError({ message: "The update authority could not be opened", at: "opening the update authority", reason: "open retry exhausted" });
}

function isRetryableOpenFailure(error: unknown): boolean {
  if (!(error instanceof SQLiteError)) return false;
  if (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED" || error.message === "database is locked") return true;
  // Two Windows processes can see SQLITE_IOERR while the winner creates and
  // transitions the same empty database into WAL mode. The file remains a
  // valid peer-owned authority, so a bounded reopen is the same contention
  // response used for BUSY. A persistent I/O fault still escapes after the
  // existing attempt bound as a transient authority failure.
  return process.platform === "win32" && (error.code?.startsWith("SQLITE_IOERR") === true || error.message === "disk I/O error");
}

/** The `update` directory, held open below the account data root.
 *
 *  The account data root is the boundary this authority sits inside, and
 *  Flywheel owns it, so it is opened as one component of the account home
 *  that may not be a link: a link planted at that name before an account's
 *  first use would move every update file out of the account. The account
 *  home above it belongs to the user and may legitimately be a link.
 *
 *  Only the `update` directory is held and only it is tightened, so this
 *  module claims no mode over the account root, and a later replacement of
 *  either directory's name moves nothing this handle can touch. */
function openUpdateDirectory(authorityDir: string): ContainedDirectory {
  const userDataRoot = path.dirname(authorityDir);
  const accountData = ContainedDirectory.open(path.dirname(userDataRoot), [path.basename(userDataRoot)]);
  try {
    return accountData.openChild(path.basename(authorityDir), { privateDirectories: true });
  } finally {
    accountData.close();
  }
}

/** The write-ahead log and the shared-memory file SQLite keeps beside the
 *  database. Each is admitted as an owner-only regular file of the held
 *  directory, and absence is nothing to admit: the sidecars exist only while
 *  a WAL database is open. They are admitted only before the open, as
 *  `admitPrivateDatabaseFiles` states: sidecars that SQLite creates get the
 *  database's mode, and an admission after the open can release the locks of
 *  the new connection. */
function admitSidecars(directory: ContainedDirectory, dbName: string): void {
  directory.admitPrivateFile(`${dbName}-wal`);
  directory.admitPrivateFile(`${dbName}-shm`);
}

/** The protocol an existing file states, or undefined when it holds nothing
 *  at all, which is the one case this binary may create. A file that holds
 *  objects but no authority table belongs to another writer, so this binary
 *  fails closed rather than add its schema beside them. Reading
 *  `sqlite_master` writes nothing, so a file this binary must not touch is
 *  inspected without being touched. */
function statedProtocolVersion(opened: Database): number | undefined {
  const objects = opened.query<{ name: string }, []>(`select name from sqlite_master`).all();
  if (objects.some((object) => object.name === "update_authority")) {
    validateExistingSchema(opened, objects);
    const stated = opened.query<{ protocol_version: number }, []>(`select protocol_version from update_authority where id = 0`).get();
    if (!stated || !Number.isSafeInteger(stated.protocol_version)) {
      throw new UpdateAuthorityCorruptError({ message: "The update authority states no protocol version", reason: "missing or malformed protocol version" });
    }
    return stated.protocol_version;
  }
  if (objects.length === 0) return undefined;
  throw new UpdateAuthorityProtocolError({
    message: `The update authority file holds another writer's objects (${objects.map((object) => object.name).sort().join(", ")}) and no authority table. Updates are not coordinated until the processes agree.`,
    expected: UPDATE_PROTOCOL_VERSION,
    found: 0,
  });
}

function requireCompatibleProtocol(stated: number | undefined): void {
  if (stated === undefined || stated === UPDATE_PROTOCOL_VERSION) return;
  throw new UpdateAuthorityProtocolError({
    message: `The update authority speaks protocol ${stated}; this binary speaks ${UPDATE_PROTOCOL_VERSION}. Updates are not coordinated until the processes agree.`,
    expected: UPDATE_PROTOCOL_VERSION,
    found: stated,
  });
}

function validateExistingSchema(opened: Database, objects: readonly { readonly name: string }[]): void {
  if (objects.length !== 1) {
    throw new UpdateAuthorityCorruptError({ message: "The update authority schema has unexpected objects", reason: `unexpected objects: ${objects.map((object) => object.name).sort().join(", ")}` });
  }
  const columns = opened.query<{ name: string; type: string; notnull: number; pk: number }, []>(`pragma table_info(update_authority)`).all()
    .map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }));
  if (JSON.stringify(columns) !== JSON.stringify(AUTHORITY_COLUMNS)) {
    throw new UpdateAuthorityCorruptError({ message: "The update authority schema is not the protocol schema", reason: "column contract mismatch" });
  }
  const singleton = opened.query<{ count: number; minimum: number | null; maximum: number | null }, []>(`select count(*) as count, min(id) as minimum, max(id) as maximum from update_authority`).get();
  if (!singleton || singleton.count !== 1 || singleton.minimum !== 0 || singleton.maximum !== 0) {
    throw new UpdateAuthorityCorruptError({ message: "The update authority does not have exactly one state row", reason: "singleton row mismatch" });
  }
}

/** Creates the table and singleton row only when the snapshot remains empty
 *  after this process acquires the initialization write lock. A peer can
 *  publish between the read-only preflight and this transaction, so the
 *  locked inspection is the authority and refuses foreign or incompatible
 *  state before this process writes anything. */
function initialize(opened: Database): void {
  opened.transaction((): void => {
    const stated = statedProtocolVersion(opened);
    requireCompatibleProtocol(stated);
    if (stated !== undefined) return;
    opened.exec(CREATE_TABLE);
    opened.query(`insert into update_authority (id, protocol_version, incarnation, checked_at, fence, lease_expires_at) values (0, $version, $incarnation, 0, 0, 0)`)
      .run({ $version: UPDATE_PROTOCOL_VERSION, $incarnation: randomUUID() });
  }).immediate();
}

function classify(error: unknown, at: string): Error {
  if (error instanceof UpdateAuthorityCorruptError || error instanceof UpdateAuthorityProtocolError || error instanceof UpdateAuthorityTransientError) return error;
  if (error instanceof SQLiteError && (error.code?.startsWith("SQLITE_CORRUPT") || error.code === "SQLITE_NOTADB")) {
    return new UpdateAuthorityCorruptError({ message: `The update authority is corrupt (${at}): ${errorMessage(error)}`, reason: errorMessage(error) });
  }
  return new UpdateAuthorityTransientError({ message: `The update authority is unreachable (${at}): ${errorMessage(error)}`, at, reason: errorMessage(error) });
}
