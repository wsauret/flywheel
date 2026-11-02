/** How the installed account service has started on this account (ARCH-DISTRIBUTION-024).
 *
 *  The record holds three facts about service starts. The first is the last
 *  installed build proved on this account: one of its project executors
 *  reported ready here, so it is where a rollback returns and a build the
 *  collector keeps. A listen alone proves nothing, because a build whose
 *  service listens can still be unable to open any project. The second is how
 *  many starts of one build in a row began and have not listened. A start that
 *  crashes on its way to the listener can leave no evidence on its way out,
 *  so each start counts itself before it loads anything heavy, and takes the
 *  count back when it ends without failing: when it parks behind another
 *  owner or a registration handoff, when a signal stops it, or when another
 *  process holds its port. The third is
 *  the lane's failing streak: the starts that ended with a cause they could
 *  state before they listened or within their first minute after it, the
 *  latest cause and its kind, how many of those starts stopped after they
 *  listened, and the park when a start parked on it. A client that asked for
 *  a start reads it to say why the start failed, and the park's count stands
 *  for the records that the repeated failures of a parked lane do not write at
 *  full level. A start that listens takes the count away and keeps the
 *  streak. Only a start that then serves its first minute, or ends by its own
 *  exit path before that, ends the streak.
 *
 *  Each change is one read, one decision, and one atomic replacement under a
 *  short lock of its own beside the record, so two starts at once never lose
 *  each other's change. The record protects the account from a broken build and
 *  must never be the reason a working one does not start, so no operation here
 *  throws: a record that cannot be read or written is reported, and the start
 *  goes on without the protection.
 *
 *  A record of a shape this build does not know was written by a newer build.
 *  The first start of this build that meets it reports it once and replaces it
 *  with a record of its own shape, so counting goes on and the report is not
 *  repeated. Every other reader treats it as naming no build. */

import * as fs from "node:fs";
import * as path from "node:path";
import { Schema } from "effect";
import { writeFileAtomic } from "../atomic-write.js";
import { errorMessage } from "../error-message.js";
import { Log } from "../log.js";
import { acquireLockSync, releaseLock } from "../ownership-file-lock.js";
import { accountServeStartRecordPath } from "../paths.js";
import { ensurePrivateRootDirectory, PRIVATE_FILE_MODE } from "../private-path.js";
import { coalesceRepeats } from "../repeat-coalescer.js";
import { type BuildRef, BuildRefSchema } from "./build-identity.js";

const log = Log.create({ service: "service-start-record" });

/** A client reads the lane's failure at each step of its wait for a start,
 *  so a record it cannot read is recorded once, and the reads that fail the
 *  same way after it are counted until one succeeds. */
const unreadable = coalesceRepeats<string>({
  windowMs: 60_000,
  first: (_condition, error) => { log.debug("the service start record could not be read", { error }); },
  repeated: (_condition, repeats) => { log.debug("the service start record could not be read again", { count: repeats.count, windowMs: repeats.windowMs }); },
});

/** How a failed start ended, with no content. `thrown`: a thrown failure
 *  reached the entry's fatal path. `refused`: the serve command refused the
 *  start for a cause that only a person clears. `clears-itself`: the serve
 *  command refused the start for a cause that ends with no person's action. */
const StartCauseKindSchema = Schema.Literals(["thrown", "refused", "clears-itself"]);
export type StartCauseKind = typeof StartCauseKindSchema.Type;

/** The facts of the record other than the proved build, which every shape
 *  shares. */
const startFacts = {
  /** Starts of one build in a row that began and have not listened. A start
   *  in progress is one of them until it listens or takes its count back. */
  unlistened: Schema.optionalKey(Schema.Struct({
    buildId: BuildRefSchema.fields.buildId,
    starts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  })),
  /** The lane's starts that ended before they listened or within their first
   *  minute after it. A streak lasts until a start serves its first minute or
   *  ends by its own exit path before that, and one that has not parked also
   *  ends at a longer gap between a failure and the next start than it allows.
   *  A record without it names no failing streak. */
  failing: Schema.optionalKey(Schema.Struct({
    /** When the first failure of the streak happened, in epoch ms. */
    since: Schema.Number,
    /** When the latest failure happened, in epoch ms. */
    lastAt: Schema.Number,
    starts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    /** The latest failure's own words. */
    cause: Schema.String,
    causeKind: StartCauseKindSchema,
    /** The refusal the latest failure named, as the serve handshake encodes
     *  it. The client decodes it; this layer cannot know its shape. */
    refusal: Schema.optionalKey(Schema.Unknown),
    /** How many of the streak's starts stopped within their first minute
     *  after they listened. Absent while none has, so a streak that a build
     *  from before 2026-09-27 wrote counts none. */
    stopsAfterListen: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    /** The lane's park, from the streak's first park until a start serves.
     *  A later failure that does not park, such as a refusal that clears by
     *  itself, keeps it and adds to its count. */
    parked: Schema.optionalKey(Schema.Struct({
      /** When the first park happened, in epoch ms. */
      since: Schema.Number,
      /** When the latest park happened, in epoch ms. */
      lastAt: Schema.Number,
      /** The failed starts from the first park on, that park included. */
      starts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    })),
  })),
};

const StartRecordSchema = Schema.Struct({
  version: Schema.Literal(2),
  /** The last installed build one of whose project executors reported ready
   *  on this account. */
  proved: Schema.optionalKey(BuildRefSchema),
  ...startFacts,
});
type StartRecord = typeof StartRecordSchema.Type;
const decodeRecord = Schema.decodeUnknownSync(StartRecordSchema);

/** The shape a build from before 2026-09-28 writes, in which the build whose
 *  service listened was the proved build. It reads as a record that names
 *  that build as proved, and keeps its count and streak, so an update from
 *  such a build keeps its rollback target. Remove this conversion after
 *  2026-12-28, when no supported build writes it.
 *
 *  Such a build, when a rollback or a person returns the account to it,
 *  meets a record of this shape as one it does not know: it reports it and
 *  replaces it with its own shape, which drops `proved` and the failing
 *  streak, and its listen then writes itself as `listened`, which this
 *  conversion reads as proved. The loss is bounded. The build a rollback
 *  returns to was the proved one already, so the record names the same build
 *  again after its first listen; a build a person installs is read as proved
 *  from its listen, as that build itself defines proof; and the streak it
 *  drops is only the lane's recent failures, which the next failure begins
 *  again. */
const ListenedRecordSchema = Schema.Struct({
  version: Schema.Literal(1),
  listened: Schema.optionalKey(BuildRefSchema),
  ...startFacts,
});
const decodeListenedRecord = Schema.decodeUnknownSync(ListenedRecordSchema);

/** The lane's failing streak as the record keeps it. */
type ServiceStartFailure = NonNullable<StartRecord["failing"]>;

type Stored =
  | { readonly kind: "absent" }
  | { readonly kind: "known"; readonly record: StartRecord }
  | { readonly kind: "unknown"; readonly reason: string };

/** Count one start of `build`, and answer how many earlier starts of it in a
 *  row ended before they listened. Nothing is answered when this start could
 *  not be counted, and nothing is counted then. */
export function countServiceStart(userDataRoot: string, build: BuildRef): number | undefined {
  let earlier: number | undefined;
  change(userDataRoot, "this service start could not be counted", (record) => {
    earlier = record?.unlistened?.buildId === build.buildId ? record.unlistened.starts : 0;
    return { ...record, version: 2, unlistened: { buildId: build.buildId, starts: earlier + 1 } };
  });
  return earlier;
}

/** Take back the count of one start of `buildId` that ended without failing. */
export function uncountServiceStart(userDataRoot: string, buildId: string): void {
  change(userDataRoot, "a service start that did not fail could not take its count back", (record) => {
    if (record?.unlistened?.buildId !== buildId) return undefined;
    const { unlistened, ...kept } = record;
    return unlistened.starts > 1 ? { ...kept, unlistened: { buildId, starts: unlistened.starts - 1 } } : kept;
  });
}

/** Record one failed start in the lane's failing streak. `decide` reads the
 *  record as it stands under the lock and answers the streak to keep. Answers
 *  the streak that was written, or nothing when the record could not be
 *  written. */
export function recordServiceStartFailure(userDataRoot: string, decide: (record: Pick<StartRecord, "proved" | "failing"> | undefined) => ServiceStartFailure): ServiceStartFailure | undefined {
  let failing: ServiceStartFailure | undefined;
  const written = change(userDataRoot, "the failed service start could not be recorded", (record) => {
    failing = decide(record);
    return { ...record, version: 2, failing };
  });
  return written ? failing : undefined;
}

/** Record that a start listened: no start is left counted. The listen proves
 *  nothing about the build, and the lane's failing streak stays until the
 *  start serves. Answers the streak that stays, or nothing when there is none
 *  or the record could not be written. */
export function recordServiceListened(userDataRoot: string): ServiceStartFailure | undefined {
  let kept: ServiceStartFailure | undefined;
  const written = change(userDataRoot, "the service start that listened could not be recorded", (record) => {
    kept = record?.failing;
    const { unlistened: _counted, ...rest } = record ?? {};
    return { ...rest, version: 2 };
  });
  return written ? kept : undefined;
}

/** Record that `build` is proved on this account: one of its project
 *  executors reported ready here. Answers true only when this call wrote the
 *  proof: a build the record already names as proved answers false, and so
 *  does a record that could not be written, which leaves the build unproved
 *  and never keeps it from running. */
export function recordBuildProved(userDataRoot: string, build: BuildRef): boolean {
  let recorded = false;
  const written = change(userDataRoot, "the build proved on this account could not be recorded", (record) => {
    if (record?.proved?.buildId === build.buildId) return undefined;
    recorded = true;
    return { ...record, version: 2, proved: build };
  });
  return written && recorded;
}

/** Record that a start served: the lane's failing streak ends. Answers the
 *  streak that ended, or nothing when there was none or the record could not
 *  be written. */
export function recordServiceServed(userDataRoot: string): ServiceStartFailure | undefined {
  // An absent record holds no streak to end, so nothing is created for it:
  // a start can serve after its account home was removed, and its served
  // step must not bring that home back.
  if (!fs.existsSync(accountServeStartRecordPath(userDataRoot))) return undefined;
  let ended: ServiceStartFailure | undefined;
  const written = change(userDataRoot, "the service start that served could not be recorded", (record) => {
    if (record?.failing === undefined) return undefined;
    const { failing, ...kept } = record;
    ended = failing;
    return kept;
  });
  return written ? ended : undefined;
}

/** The last installed build proved on this account, or nothing when no build
 *  is known to be proved. */
export function provedBuild(userDataRoot: string): BuildRef | undefined {
  try {
    const stored = readRecord(accountServeStartRecordPath(userDataRoot));
    return stored.kind === "known" ? stored.record.proved : undefined;
  } catch (error) {
    log.debug("the service start record could not be read", { error: errorMessage(error) });
    return undefined;
  }
}

/** The latest failure of the lane's failing streak, or nothing when no
 *  start has failed since a start last listened, or the record cannot be
 *  read. */
export function lastServiceStartFailure(userDataRoot: string): Pick<ServiceStartFailure, "lastAt" | "cause" | "refusal" | "parked"> | undefined {
  let stored: Stored;
  try {
    stored = readRecord(accountServeStartRecordPath(userDataRoot));
  } catch (error) {
    unreadable.observe("unreadable", errorMessage(error));
    return undefined;
  }
  unreadable.end();
  if (stored.kind !== "known" || stored.record.failing === undefined) return undefined;
  const { lastAt, cause, refusal, parked } = stored.record.failing;
  return { lastAt, cause, refusal, parked };
}

/** Apply one change under the record's lock. A change that answers nothing
 *  leaves the record as it is. Answers false when the record could not be
 *  read or written. */
function change(userDataRoot: string, failure: string, decide: (record: StartRecord | undefined) => StartRecord | undefined): boolean {
  const recordPath = accountServeStartRecordPath(userDataRoot);
  try {
    ensurePrivateRootDirectory(path.dirname(recordPath));
    const lock = acquireLockSync(`${recordPath}.lock`);
    try {
      const stored = readRecord(recordPath);
      const changed = decide(stored.kind === "known" ? stored.record : undefined);
      if (changed === undefined) return true;
      if (stored.kind === "unknown") log.warn("the service start record has a shape this build does not know; it is replaced by a record of this build's shape", { reason: stored.reason });
      writeFileAtomic(recordPath, `${JSON.stringify(changed)}\n`, { mode: PRIVATE_FILE_MODE });
      return true;
    } finally {
      releaseLock(lock);
    }
  } catch (error) {
    log.warn(failure, { error: errorMessage(error) });
    return false;
  }
}

function readRecord(recordPath: string): Stored {
  let raw: string;
  try {
    raw = fs.readFileSync(recordPath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { kind: "absent" };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
    return { kind: "known", record: decodeRecord(parsed) };
  } catch (error) {
    try {
      const { listened, version: _version, ...facts } = decodeListenedRecord(parsed);
      return { kind: "known", record: { ...facts, version: 2, ...(listened === undefined ? {} : { proved: listened }) } };
    } catch {
      return { kind: "unknown", reason: errorMessage(error) };
    }
  }
}
