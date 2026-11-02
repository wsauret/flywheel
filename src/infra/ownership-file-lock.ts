/** Cross-process ownership lock over one entry of one directory.
 *
 *  The lock is a file whose contents name its owner: a fresh owner id plus the
 *  holder identity of the process that holds it (its pid, start stamp, and
 *  boot; `process-holder.ts` owns that durable format). A process that cannot
 *  read its own identity names itself by pid alone, the shape an earlier build
 *  writes, which every reader waits for while the pid runs and never takes
 *  over; it asks for its identity again at its next record. Every record this
 *  protocol writes (a lock, a reclaim claim, a shared holder) is published the
 *  same way: the whole record goes to a private owner file, which is then
 *  hard-linked into place. A reader therefore never observes a partial record,
 *  and the link either lands or reports that another owner already holds the
 *  name. The owner file is named `<lock>.owner.<id>` after the lock or gate the
 *  record belongs to, a name that no build's sweep of claims or shared holders
 *  reads.
 *
 *  A lock whose holder is proven gone is reclaimed under a claim on the owner
 *  that was observed, and the record is read again under the claim before it
 *  is removed. A claim that a gone claimant left is removed the same way, one
 *  level up, so a crash mid-reclaim never holds the lock for ever. A holder
 *  that is alive, or that the kernel or the record does not answer for, is
 *  waited for and never taken over.
 *
 *  A gate also carries shared ownership: each shared holder publishes its own
 *  record beside the gate, so an exclusive owner holding the gate can count the
 *  holders that are not proven gone before it acts.
 *
 *  Every step names one entry of a `LockDirectory`, never a path: a caller that
 *  holds its target directory open passes that descriptor-bound directory in, so
 *  the owner file, the publication, the record read, the stale-owner claim, and
 *  the unlink are all operations on the one directory it holds. A path-based
 *  caller passes the adapter below, which resolves each entry under one
 *  directory path. */

import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ContainedFileTooLargeError, ContainedPathError } from "./descriptor-directory-contract.js";
import { errnoCode, errorMessage } from "./error-message.js";
import { Log } from "./log.js";
import { decodeHolderFields, processHolders, type GoneProof, type HolderIdentity, type HolderState, type ProcessHolder } from "./process-holder.js";

const MAX_RETRIES = 8;
const BASE_DELAY_MS = 25;
const FILE_MODE = 0o600;

/** A lock record is one small JSON object; anything larger is not one. */
const MAX_RECORD_BYTES = 4 * 1024;

/** The deepest claim a reclaim publishes: a claim on the lock, a claim on that
 *  claim, and one more. A leaked claim at the last depth has no claim above it
 *  that could remove it, so a chain that long reads as held. */
const MAX_CLAIM_DEPTH = 3;

/** One pass of an attempt removes at most one stale entry, so a bounded chain
 *  of claims, the lock itself, and the publication fit in one attempt. */
const PASSES_PER_ATTEMPT = MAX_CLAIM_DEPTH + 2;

/** Earlier releases created a reclaim claim empty and wrote nothing into it, so
 *  a claim such a release leaked names no claimant to prove gone. A reclaim
 *  holds its claim for a few file operations, so an empty claim this old is a
 *  leak. Remove after 2026-12-25, when no earlier release can still run. */
const EMPTY_CLAIM_EXPIRY_MS = 10 * 60_000;

const log = Log.create({ service: "ownership-file-lock" });

/** What this protocol publishes at a lock, a reclaim claim, or a shared
 *  holder: the pid and the identity beside it, or the pid alone from a process
 *  that could not read its own identity. */
type RecordFields = { readonly pid: number; readonly owner: string } & Partial<HolderIdentity>;

/** A published record as this build reads it. */
interface LockRecord {
  readonly pid: number;
  readonly owner: string;
  readonly holder: ProcessHolder;
}

/** One read of one entry. `foreign` is an occupant that can never become a
 *  record: a directory, a link, or a file larger than any record. `unreadable`
 *  is a read the file system did not answer, which proves nothing about the
 *  holder. */
type Entry =
  | { readonly kind: "absent" }
  | { readonly kind: "record"; readonly record: LockRecord }
  | { readonly kind: "empty" }
  | { readonly kind: "malformed" }
  | { readonly kind: "foreign" }
  | { readonly kind: "unreadable"; readonly code: string };

/** Why one attempt did not publish. `held` is a holder's record whose holder
 *  runs or is not answered for, or a lock that changed hands, and it clears
 *  when that holder ends. `occupied` is an entry that names no holder this
 *  build can read: one that is empty, malformed, or unreadable, or the end of
 *  a chain of leaked claims. It is waited for like a holder, because it
 *  proves nothing about one. No acquisition removes it, except an empty or
 *  malformed lock that a caller removes on its own proof that no holder runs. A foreign
 *  occupant is permanent, so an acquisition that meets one refuses at once
 *  instead of waiting. An empty claim that an earlier release left is waited
 *  for like a holder, and names itself, because it clears itself once it is
 *  old enough. */
type Blocked =
  | { readonly kind: "held" | "occupied" | "foreign"; readonly reason: string }
  | { readonly kind: "empty-claim"; readonly claim: string; readonly reason: string };

/** Why a lock record was removed: the kernel's proof, or the caller's own
 *  proof of a holder that the kernel reads as alive or unknown. */
type ReclaimProof = GoneProof | "caller-proven";

/** What an acquisition removed from the lock's name: a holder's record and the
 *  proof it removed it on, or an entry that named no holder, which only the
 *  caller's proof that no holder runs removes. */
type Reclaim =
  | { readonly kind: "holder"; readonly pid: number; readonly proof: ReclaimProof }
  | { readonly kind: "nameless"; readonly entry: NamelessEntry };

/** An entry at a lock's name that names no holder. Every build publishes a
 *  lock whole, so neither shape is a lock in progress: each is damage. */
type NamelessEntry = "empty" | "malformed";

/** One attempt either publishes its record, naming the holder it reclaimed on
 *  the way, or names why it did not. */
type Attempt = { readonly kind: "acquired"; readonly reclaimed: Reclaim | undefined } | Blocked;

/** What one observation of an occupied name licenses: another pass at once,
 *  because an entry went away or this pass removed one, or a stop. */
type Observation = { readonly kind: "retry"; readonly reclaimed?: Reclaim } | Blocked;

/** A claim that removed its target reports the proof it removed it on. */
type Removal<Proof extends string> = { readonly kind: "removed"; readonly proof: Proof } | Observation;

/** Whether a record's holder still holds it. A caller's own proof can count a
 *  holder that the kernel reads as alive or unknown as gone. */
type Verdict = HolderState | { readonly kind: "gone"; readonly proof: "caller-proven" };

const RETRY: Observation = { kind: "retry" };
const held = (reason: string): Blocked => ({ kind: "held", reason });
const occupied = (reason: string): Blocked => ({ kind: "occupied", reason });

/** The directory the lock lives in. Every operation names one entry of it, so a
 *  held descriptor and a directory path both satisfy it and the protocol below
 *  is written once. */
export interface LockDirectory {
  /** One entry as a bounded regular file: undefined when it is absent. It
   *  throws `ContainedPathError` when the entry is not a regular file and
   *  `ContainedFileTooLargeError` when it is larger than `maxBytes`; each is
   *  one atomic observation of a foreign occupant, which acquisition reads as
   *  permanent, because this protocol links only complete bounded records.
   *  Any other throw is a read the file system did not answer. */
  readFile(name: string, maxBytes: number): Buffer | undefined;
  /** Create `name` holding `content`, or report that it already exists. */
  createExclusive(name: string, content: string): boolean;
  /** Hard-link `existing` to `name`, or report that `name` already exists. */
  linkFile(existing: string, name: string): boolean;
  /** Remove one entry. Absence is success. */
  removeFile(name: string): void;
  /** The names this directory holds. A gate reads them to find its shared
   *  holders, which are entries beside it. */
  entryNames(): readonly string[];
  /** When one regular-file entry was last written. It throws for an entry that
   *  is absent or not a regular file. */
  regularFileModifiedAt(name: string): number;
}

/** One held lock inside a directory the caller already names. */
export interface LockHold {
  readonly name: string;
  readonly owner: string;
}

export interface LockOwnership {
  readonly path: string;
  readonly owner: string;
}

/** An acquisition that cannot take the lock and names why: a holder that stays
 *  alive or unanswered through the whole ladder, an entry that names no
 *  holder this build can read, or a foreign object at the name.
 *  `clearsItself` says whether the cause ends with no person's action: a
 *  holder ends its hold, and an empty claim is removed once it is old enough,
 *  where only a person removes an entry that names no holder. `emptyClaim`
 *  names the empty reclaim claim, an earlier release's, that kept the lock
 *  through the ladder: it is removed once it is proven old enough, and no
 *  reset clears it sooner. Any other error from an acquisition is a failure
 *  of the directory itself. */
export class LockRefusal extends Error {
  constructor(message: string, readonly clearsItself: boolean, readonly emptyClaim?: string) {
    super(message);
    this.name = "LockRefusal";
  }
}

/** One attempt's answer: the lock it took and the holder it reclaimed on the
 *  way, if any, or why it did not take the lock. */
export type TriedLock =
  | (LockOwnership & { readonly kind: "acquired"; readonly reclaimed: Reclaim | undefined })
  | { readonly kind: "blocked"; readonly reason: string };

export interface TryLockOptions {
  /** The caller's own proof that a pid no longer holds anything it recorded,
   *  for a holder that the kernel reads as alive or unknown. It is asked again
   *  under the claim, after the record is read again. */
  readonly ownerProvenGone?: (pid: number) => boolean;
  /** The caller's own proof that no process holds the lock at all, such as
   *  a reset that ended every process that could. Only this proof removes an
   *  entry that names no holder, because a holder whose record was damaged
   *  in place may still run. */
  readonly noHolderRuns?: boolean;
}

// baseDelayMs is a test seam: failure-path tests walk the full retry ladder
// and would otherwise sleep ~2s at the production backoff.
export async function acquireLock(lockPath: string, baseDelayMs: number = BASE_DELAY_MS): Promise<LockOwnership> {
  const hold = await acquireLockIn(pathLockDirectory(dirname(lockPath)), basename(lockPath), baseDelayMs);
  return { path: lockPath, owner: hold.owner };
}

/** Acquire one lock inside a directory the caller holds. A held lock is retried
 *  with backoff, and a lock whose holder is proven gone is reclaimed. */
export function acquireLockIn(
  directory: LockDirectory,
  name: string,
  baseDelayMs: number = BASE_DELAY_MS,
): Promise<LockHold> {
  return acquireLockUsingIn(directory, name, baseDelayMs, (hold) => hold);
}

/** Wait without blocking for ownership, then run synchronous work and release
 *  before yielding. Throws acquisition and callback failures to the caller.
 *  `use` must not return asynchronous work: a synchronous sibling would block
 *  the event loop needed to finish that work and release the lock. */
export function withLockIn<T>(
  directory: LockDirectory,
  name: string,
  use: () => T,
  baseDelayMs: number = BASE_DELAY_MS,
): Promise<T> {
  return acquireLockUsingIn(directory, name, baseDelayMs, (hold) => {
    try {
      return use();
    } finally {
      releaseLockIn(directory, hold);
    }
  });
}

async function acquireLockUsingIn<T>(
  directory: LockDirectory,
  name: string,
  baseDelayMs: number,
  acquired: (hold: LockHold) => T,
): Promise<T> {
  const record = ownRecord();
  for (let attempt = 0; ; attempt++) {
    const result = attemptLock(directory, name, record);
    if (result.kind === "acquired") return acquired({ name, owner: record.owner });
    if (result.kind === "foreign" || attempt === MAX_RETRIES) throw refusal(name, result);
    await Bun.sleep(backoffMs(baseDelayMs, attempt));
  }
}

/** Acquire `gateName` exclusively once no shared holder remains. While the gate
 *  is held, no new holder can register, so the holders only leave. A holder
 *  that stays through the whole retry ladder refuses the acquisition the same
 *  way a held lock does, and the gate is released. */
export async function acquireDrainedGateIn(
  directory: LockDirectory,
  gateName: string,
  baseDelayMs: number = BASE_DELAY_MS,
): Promise<LockHold> {
  const hold = await acquireLockIn(directory, gateName, baseDelayMs);
  try {
    for (let attempt = 0; ; attempt++) {
      const { pids, unreadable } = sweepSharedHolders(directory, gateName);
      if (pids.length + unreadable === 0) return hold;
      if (attempt === MAX_RETRIES) {
        throw new LockRefusal(`Failed to acquire lock '${gateName}' after ${MAX_RETRIES + 1} attempts: ${pids.length + unreadable} shared holders remain (pids ${pids.join(", ") || "unreadable"})`, true);
      }
      await Bun.sleep(backoffMs(baseDelayMs, attempt));
    }
  } catch (error) {
    releaseLockIn(directory, hold);
    throw error;
  }
}

// baseDelayMs is the same test seam as on acquireLock.
export function acquireLockSync(lockPath: string, baseDelayMs: number = BASE_DELAY_MS): LockOwnership {
  const hold = acquireLockSyncIn(pathLockDirectory(dirname(lockPath)), basename(lockPath), baseDelayMs);
  return { path: lockPath, owner: hold.owner };
}

/** Acquire one lock inside a directory the caller holds, without yielding. Same
 *  ladder as `acquireLockIn`, for a caller whose whole window is synchronous. */
export function acquireLockSyncIn(
  directory: LockDirectory,
  name: string,
  baseDelayMs: number = BASE_DELAY_MS,
): LockHold {
  const record = ownRecord();
  for (let attempt = 0; ; attempt++) {
    const result = attemptLock(directory, name, record);
    if (result.kind === "acquired") return { name, owner: record.owner };
    if (result.kind === "foreign" || attempt === MAX_RETRIES) throw refusal(name, result);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs(baseDelayMs, attempt));
  }
}

/** One synchronous attempt inside a directory the caller holds. A held lock is
 * reported as unavailable without waiting, so recovery never stalls its loop. */
export function tryAcquireLockSyncIn(directory: LockDirectory, name: string): LockHold | undefined {
  const record = ownRecord();
  return attemptLock(directory, name, record).kind === "acquired" ? { name, owner: record.owner } : undefined;
}

// One attempt, no sleeping: for a caller that must not block and reads a held
// lock as "another owner is already doing this work".
export function tryAcquireLockSync(lockPath: string, options: TryLockOptions = {}): TriedLock {
  const record = ownRecord();
  const result = attemptLock(pathLockDirectory(dirname(lockPath)), basename(lockPath), record, options);
  return result.kind === "acquired" ? { kind: "acquired", path: lockPath, owner: record.owner, reclaimed: result.reclaimed } : { kind: "blocked", reason: result.reason };
}

export function releaseLock(ownership: LockOwnership): void {
  releaseLockIn(pathLockDirectory(dirname(ownership.path)), { name: basename(ownership.path), owner: ownership.owner });
}

/** Release one lock inside the directory it was acquired in. The record is
 *  re-read under the reclaim claim on its owner, so a lock another acquisition
 *  published in the meantime is left alone. A claim that a gone claimant left
 *  on this owner is cleared first. */
export function releaseLockIn(directory: LockDirectory, hold: LockHold): void {
  const claim = claimName(hold.name, hold.name, hold.owner);
  let reason = "a reclaim claim on its owner was published again after it was cleared";
  for (let pass = 0; pass < 2; pass++) {
    if (publishRecord(directory, hold.name, claim, ownRecord())) {
      try {
        const entry = readEntry(directory, hold.name);
        if (entry.kind === "record" && entry.record.owner === hold.owner) directory.removeFile(hold.name);
      } finally {
        directory.removeFile(claim);
      }
      return;
    }
    const observation = observeClaim(directory, hold.name, claim, 1);
    if (observation.kind !== "retry") {
      reason = observation.reason;
      break;
    }
  }
  log.warn("a lock release left the lock in place; it is reclaimed once this process is gone", { lock: hold.name, reason });
}

/** One process's shared ownership of a gate inside the directory that holds it.
 *  Many holders coexist; each is one entry beside the gate naming its own owner
 *  and holder identity. */
export interface SharedHold {
  readonly gateName: string;
  readonly owner: string;
}

/** Record this process as a shared holder of `gateName`. The caller must hold the
 *  gate itself, so no exclusive owner can be mid-decision while the holder
 *  appears. */
export function registerSharedHolderIn(directory: LockDirectory, gateName: string): SharedHold {
  const record = ownRecord();
  publishRecord(directory, gateName, sharedName(gateName, record.owner), record);
  return { gateName, owner: record.owner };
}

export function releaseSharedHolderIn(directory: LockDirectory, hold: SharedHold): void {
  directory.removeFile(sharedName(hold.gateName, hold.owner));
}

/** How many other processes may still hold `gateName` shared: every holder not
 *  proven gone, including one whose record cannot be read. A holder proven gone
 *  is removed rather than counted, so a crashed holder never wedges the gate.
 *  The caller must hold the gate itself, or the count is already stale when it
 *  is read. */
export function liveSharedHoldersIn(directory: LockDirectory, gateName: string): number {
  const holders = sweepSharedHolders(directory, gateName);
  return holders.pids.length + holders.unreadable;
}

/** The shared holders of one gate that are not proven gone: the pids of those
 *  whose record names one, and how many hold a record that cannot be read. */
interface SharedHolders {
  readonly pids: readonly number[];
  readonly unreadable: number;
}

/** The processes that may still hold `gateName` shared, for a caller that
 *  names who holds it. Same sweep as the count. A holder whose record cannot
 *  be read names no pid, and it still holds the gate. */
export function sharedHoldersIn(directory: LockDirectory, gateName: string): SharedHolders {
  return sweepSharedHolders(directory, gateName);
}

/** Read every shared holder of `gateName` and remove each one proven gone. */
function sweepSharedHolders(directory: LockDirectory, gateName: string): SharedHolders {
  const prefix = sharedName(gateName, "");
  const pids: number[] = [];
  let unreadable = 0;
  for (const name of directory.entryNames()) {
    if (!name.startsWith(prefix)) continue;
    const entry = readEntry(directory, name);
    if (entry.kind === "absent") continue;
    if (entry.kind === "unreadable") {
      unreadable++;
      continue;
    }
    if (entry.kind !== "record") {
      directory.removeFile(name);
      continue;
    }
    const state = processHolders.state(entry.record.holder);
    if (state.kind !== "gone") {
      pids.push(entry.record.pid);
      continue;
    }
    directory.removeFile(name);
    log.info("removed a shared holder whose process is gone", { lock: name, pid: entry.record.pid, proof: state.proof });
  }
  return { pids, unreadable };
}

function sharedName(gateName: string, owner: string): string {
  return `${gateName}.shared.${owner}`;
}

/** A fresh record for this process, with the identity it can read now. */
function ownRecord(): RecordFields {
  return { pid: process.pid, owner: randomUUID(), ...processHolders.own() };
}

/** Publish `record` at `name`, an entry that belongs to the lock or gate
 *  `lock`, or report that another owner holds it. The owner file carries the
 *  whole record before the link makes it visible, and it is removed either
 *  way: only the published link is the record. The owner file is empty for a
 *  moment after it is created, and an earlier build removes every entry under
 *  `<gate>.shared.` that it cannot read as a record, so the owner file is
 *  named after `lock`, never after `name`. */
function publishRecord(directory: LockDirectory, lock: string, name: string, record: RecordFields): boolean {
  const ownerName = `${lock}.owner.${record.owner}`;
  if (!directory.createExclusive(ownerName, JSON.stringify(record))) return false;
  try {
    return directory.linkFile(ownerName, name);
  } finally {
    directory.removeFile(ownerName);
  }
}

/** Publish `record` at `name` without waiting, removing on the way each entry
 *  whose holder is proven gone. */
function attemptLock(
  directory: LockDirectory,
  name: string,
  record: RecordFields,
  options: TryLockOptions = {},
): Attempt {
  let reclaimed: Reclaim | undefined;
  for (let pass = 0; pass < PASSES_PER_ATTEMPT; pass++) {
    if (publishRecord(directory, name, name, record)) return { kind: "acquired", reclaimed };
    const observation = observeLock(directory, name, options);
    if (observation.kind !== "retry") return observation;
    reclaimed = observation.reclaimed ?? reclaimed;
  }
  return held("the lock changed hands on every pass of one attempt");
}

function observeLock(directory: LockDirectory, name: string, { ownerProvenGone, noHolderRuns }: TryLockOptions): Observation {
  const entry = readEntry(directory, name);
  if (entry.kind === "absent") return RETRY;
  if (entry.kind === "foreign") return { kind: "foreign", reason: `Lock '${name}' is held by a foreign object that is not a lock record` };
  if ((entry.kind === "empty" || entry.kind === "malformed") && noHolderRuns === true) return removeNameless(directory, name, entry.kind);
  if (entry.kind !== "record") return occupied(`the lock record ${describeUnread(entry)}`);
  const { pid, owner } = entry.record;
  const verdict = verdictOf(entry.record, ownerProvenGone);
  if (verdict.kind !== "gone") return held(`pid ${pid} holds it and ${describeLive(verdict)}`);
  const removal = removeUnderClaim(directory, name, name, owner, stillGone(owner, ownerProvenGone), 1);
  if (removal.kind !== "removed") return removal;
  log.info("reclaimed a lock whose holder is gone", { lock: name, pid, proof: removal.proof });
  return { kind: "retry", reclaimed: { kind: "holder", pid, proof: removal.proof } };
}

/** Remove a lock entry that names no holder, on the caller's proof that no
 *  holder runs, under a claim keyed on the shape that was observed. */
function removeNameless(directory: LockDirectory, name: string, entry: NamelessEntry): Observation {
  const removal = removeUnderClaim(directory, name, name, entry, (current) => current.kind === entry ? "caller-proven" : undefined, 1);
  if (removal.kind !== "removed") return removal;
  log.warn("removed a lock that named no holder", { lock: name, entry });
  return { kind: "retry", reclaimed: { kind: "nameless", entry } };
}

/** Handle a reclaim claim that already exists at `claim`, published at `depth`:
 *  a claim whose claimant is proven gone, or an earlier release's empty claim
 *  old enough to be a leak, is removed under a claim one level up. */
function observeClaim(directory: LockDirectory, lock: string, claim: string, depth: number): Observation {
  const entry = readEntry(directory, claim);
  switch (entry.kind) {
    case "absent":
      return RETRY;
    case "record": {
      const { pid, owner } = entry.record;
      const verdict = verdictOf(entry.record);
      if (verdict.kind !== "gone") return held(`reclaim claim '${claim}' is held by pid ${pid}, which ${describeLive(verdict)}`);
      if (depth === MAX_CLAIM_DEPTH) return chainTooDeep(claim);
      const removal = removeUnderClaim(directory, lock, claim, owner, stillGone(owner), depth + 1);
      if (removal.kind !== "removed") return removal;
      log.info("removed a reclaim claim whose claimant is gone", { lock, claim, pid, proof: removal.proof });
      return RETRY;
    }
    case "empty": {
      // Remove after 2026-12-25, with EMPTY_CLAIM_EXPIRY_MS.
      if (!emptyClaimExpired(directory, claim)) {
        return { kind: "empty-claim", claim, reason: `reclaim claim '${claim}' is empty, the shape an earlier release leaves, and is removed once it is proven ${EMPTY_CLAIM_EXPIRY_MS / 60_000} minutes old` };
      }
      if (depth === MAX_CLAIM_DEPTH) return chainTooDeep(claim);
      const expired = (current: Entry): "empty-claim-expired" | undefined => current.kind === "empty" && emptyClaimExpired(directory, claim) ? "empty-claim-expired" : undefined;
      const removal = removeUnderClaim(directory, lock, claim, "empty", expired, depth + 1);
      if (removal.kind !== "removed") return removal;
      log.warn("removed an empty reclaim claim that an earlier release left", { lock, claim });
      return RETRY;
    }
    default:
      return occupied(`reclaim claim '${claim}' ${describeUnread(entry)}`);
  }
}

/** Remove `target` under a claim keyed on what the observer saw there, asking
 *  `proofOf` again of the entry read under the claim. The claim is published
 *  whole with this process's record, so a claim this process leaks names a
 *  claimant that a later reclaim can prove gone. */
function removeUnderClaim<Proof extends string>(
  directory: LockDirectory,
  lock: string,
  target: string,
  key: string,
  proofOf: (entry: Entry) => Proof | undefined,
  depth: number,
): Removal<Proof> {
  const claim = claimName(lock, target, key);
  if (!publishRecord(directory, lock, claim, ownRecord())) return observeClaim(directory, lock, claim, depth);
  try {
    const proof = proofOf(readEntry(directory, target));
    if (proof === undefined) return RETRY;
    directory.removeFile(target);
    return { kind: "removed", proof };
  } finally {
    directory.removeFile(claim);
  }
}

/** The claim on removing `target`, keyed on what the observer saw there. A
 *  claim on the lock itself is keyed on the observed owner alone, which is the
 *  name every earlier and later build shares, so they exclude each other. A
 *  claim on a claim also names that claim, and every claim name has one
 *  bounded length. */
function claimName(lock: string, target: string, key: string): string {
  const identity = target === lock ? key : `${target}\0${key}`;
  return `${lock}.reclaim.${createHash("sha256").update(identity).digest("hex")}`;
}

function chainTooDeep(claim: string): Blocked {
  return occupied(`reclaim claim '${claim}' ends a chain of ${MAX_CLAIM_DEPTH} leaked claims, which no claim above it may remove`);
}

/** Whether an empty claim is proven older than the expiry. A read that fails
 *  proves nothing, so the claim stays. */
function emptyClaimExpired(directory: LockDirectory, claim: string): boolean {
  try {
    return Date.now() - directory.regularFileModifiedAt(claim) > EMPTY_CLAIM_EXPIRY_MS;
  } catch {
    return false;
  }
}

function verdictOf(record: LockRecord, ownerProvenGone?: (pid: number) => boolean): Verdict {
  const state = processHolders.state(record.holder);
  if (state.kind !== "gone" && ownerProvenGone?.(record.pid) === true) return { kind: "gone", proof: "caller-proven" };
  return state;
}

/** The proof, asked again of one read, that the entry is still `owner`'s
 *  record and its holder is gone. */
function stillGone(owner: string, ownerProvenGone?: (pid: number) => boolean): (entry: Entry) => ReclaimProof | undefined {
  return (entry) => {
    if (entry.kind !== "record" || entry.record.owner !== owner) return undefined;
    const verdict = verdictOf(entry.record, ownerProvenGone);
    return verdict.kind === "gone" ? verdict.proof : undefined;
  };
}

function describeLive(state: Exclude<HolderState, { readonly kind: "gone" }>): string {
  return state.kind === "alive" ? "is running" : `cannot be proven gone: ${state.reason}`;
}

function describeUnread(entry: Exclude<Entry, { readonly kind: "absent" | "record" }>): string {
  switch (entry.kind) {
    case "empty":
      return "is empty";
    case "malformed":
      return "holds bytes that are not a lock record";
    case "foreign":
      return "is a foreign object that is not a lock record";
    case "unreadable":
      return `could not be read: ${entry.code}`;
  }
}

function refusal(name: string, blocked: Blocked): LockRefusal {
  if (blocked.kind === "foreign") return new LockRefusal(blocked.reason, false);
  const message = `Failed to acquire lock '${name}' after ${MAX_RETRIES + 1} attempts: ${blocked.reason}`;
  if (blocked.kind === "empty-claim") return new LockRefusal(message, true, blocked.claim);
  return new LockRefusal(message, blocked.kind === "held");
}

function backoffMs(baseDelayMs: number, attempt: number): number {
  return baseDelayMs * 2 ** Math.min(attempt, 4);
}

function readEntry(directory: LockDirectory, name: string): Entry {
  let bytes: Buffer | undefined;
  try {
    bytes = directory.readFile(name, MAX_RECORD_BYTES);
  } catch (error) {
    if (error instanceof ContainedPathError || error instanceof ContainedFileTooLargeError) return { kind: "foreign" };
    return { kind: "unreadable", code: errnoCode(error) ?? errorMessage(error) };
  }
  if (bytes === undefined) return { kind: "absent" };
  if (bytes.byteLength === 0) return { kind: "empty" };
  const record = decodeRecord(bytes);
  return record === undefined ? { kind: "malformed" } : { kind: "record", record };
}

/** A record by `pid` and `owner`, the fields every build writes; the identity
 *  fields beside them decode through the holder format. */
function decodeRecord(bytes: Buffer): LockRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf-8"));
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null || !("pid" in value) || !("owner" in value)) return undefined;
  const { pid, owner } = value;
  if (typeof pid !== "number" || !Number.isInteger(pid) || typeof owner !== "string") return undefined;
  const identity = {
    v: "v" in value ? value.v : undefined,
    start: "start" in value ? value.start : undefined,
    boot: "boot" in value ? value.boot : undefined,
  };
  return { pid, owner, holder: decodeHolderFields(pid, identity) };
}

/** Every entry of one directory named by path. The directory itself is the
 *  caller's trust: this adapter resolves each entry under it and classifies a
 *  read the way a contained directory does, so the lock protocol reads both
 *  adapters the same way. On macOS and Linux a read opens the entry itself,
 *  never a link at its name and never a wait for the writer of a named pipe
 *  put in its place. */
function pathLockDirectory(directory: string): LockDirectory {
  return {
    readFile: (name, maxBytes) => readPathFile(join(directory, name), maxBytes),
    createExclusive: (name, content) => createPathFile(join(directory, name), content),
    linkFile: (existing, name) => linkPathFile(join(directory, existing), join(directory, name)),
    removeFile: (name) => unlinkIfPresent(join(directory, name)),
    entryNames: () => readdirSync(directory),
    regularFileModifiedAt: (name) => regularPathFileModifiedAt(join(directory, name)),
  };
}

/** How a read opens an existing entry, as a contained directory opens one.
 *  Windows has neither flag. */
const EXISTING_ENTRY_FLAGS = process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

function readPathFile(filePath: string, maxBytes: number): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(filePath, EXISTING_ENTRY_FLAGS);
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return undefined;
    if (isErrnoCode(error, "EISDIR") || isErrnoCode(error, "ELOOP")) throw new ContainedPathError(`'${filePath}' is not a regular file`, { cause: error });
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new ContainedPathError(`'${filePath}' is not a regular file`);
    if (stats.size > maxBytes) throw new ContainedFileTooLargeError(maxBytes);
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function regularPathFileModifiedAt(filePath: string): number {
  const stats = lstatSync(filePath);
  if (!stats.isFile()) throw new ContainedPathError(`'${filePath}' is not a regular file`);
  return stats.mtimeMs;
}

function createPathFile(filePath: string, content: string): boolean {
  let fd: number;
  try {
    fd = openSync(filePath, "wx", FILE_MODE);
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) return false;
    throw error;
  }
  try {
    try {
      fchmodSync(fd, FILE_MODE);
      writeFileSync(fd, content, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    unlinkIfPresent(filePath);
    throw error;
  }
  return true;
}

function linkPathFile(existingPath: string, filePath: string): boolean {
  try {
    linkSync(existingPath, filePath);
    return true;
  } catch (error) {
    if (isErrnoCode(error, "EEXIST")) return false;
    throw error;
  }
}

function unlinkIfPresent(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch (error) {
    if (!isErrnoCode(error, "ENOENT")) throw error;
  }
}

function isErrnoCode(error: unknown, code: string): boolean {
  return errnoCode(error) === code;
}
