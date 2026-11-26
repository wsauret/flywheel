/** The source a command of the dev entry runs from (ARCH-DISTRIBUTION-030).
 *
 *  Every command that the dev entry (`scripts/dev.ts`) runs, a dev service
 *  and a terminal among them, runs from one snapshot of its checkout's
 *  source, fixed when the command starts. Its main thread, its lazy imports, its Workers, and every process
 *  it starts from its own source, such as a dev service's guardian and
 *  executor generations, load that snapshot, so an edit to the checkout never
 *  changes or breaks a running process. A snapshot copies
 *  the file set of `source-snapshot-content.ts` into `sourceSnapshotHome(checkout)/<digest>/` and keeps
 *  the checkout's layout, so a path that a module takes relative to its own
 *  URL resolves inside the snapshot, and a bare import resolves up to the
 *  checkout's `node_modules`, or, for the web client, through a link to the
 *  checkout's `webview/node_modules`. What the checkout holds beside its source is
 *  read through `sourceCheckout()` and `flywheelCacheDirectory()`.
 *
 *  Each process that runs from a snapshot holds it as a shared holder of the
 *  snapshot's gate, `<digest>.gate`, the `ownership-file-lock` gate that a
 *  project's serving claim also uses. A join takes the gate, confirms the
 *  snapshot is still there, registers, and releases the gate, so a sweep
 *  that holds the gate sees every holder that joined before it. A process
 *  removes its holder record as it exits, and a join removes the record of
 *  each holder that is proven gone, such as a killed process.
 *
 *  Each dev service sweeps its checkout's snapshots once it listens. A
 *  snapshot that no process holds is renamed away under its gate and then
 *  deleted, so a join after the rename finds no snapshot and makes it again.
 *  The sweep keeps the proved snapshot, which a dev service returns to.
 *
 *  Each snapshot is a build of the dev lane (ARCH-DISTRIBUTION-030). A snapshot proves
 *  itself when one of its project executors reports ready, and the proof
 *  record beside the snapshots names the last one that did. A dev service
 *  whose own executors cannot open records its snapshot there as refused and
 *  makes way, and the dev entry and the cutover check then run the proved
 *  snapshot in place of the checkout's source until that source changes.
 *  A partial copy or deletion is removed once the process that made it,
 *  which its name carries, is proven gone.
 *
 *  Only a source run reaches this module: every caller imports it lazily,
 *  behind the source-run or dev-lane check or from a source-only entry, so
 *  an installed build never loads it. */

import { randomBytes } from "node:crypto"
import * as fs from "node:fs"
import { join, relative } from "node:path"
import { Schema } from "effect"

import type { AntigravityPinnedBytes } from "./antigravity-engine-pin.js"
import { isSourceSnapshotDigest, runningSourceSnapshot, sourceSnapshotHome, type SourceSnapshotLocation } from "../../platform/cli-subprocess.js"
import { ContainedPathError, type ContainedDirectory } from "../../platform/files/descriptor-directory/descriptor-directory-contract.js"
import { openContainedDirectory, openExistingContainedDirectory } from "../../platform/files/descriptor-directory.js"
import { errorMessage } from "../../diagnostics/error-message.js"
import { errnoCode } from "../../platform/files/system-error.js"
import { Log } from "../../diagnostics/log.js"
import { acquireLockSyncIn, liveSharedHoldersIn, registerSharedHolderIn, releaseLockIn, releaseSharedHolderIn, tryAcquireLockSyncIn, type SharedHold } from "../../process/locks/ownership-file-lock.js"
import { decodeHolderText, encodeHolderText, processHolders, type ProcessHolder } from "../../process/process-holder.js"
import { checkoutDigest, copyAndDigest, linkClientPackages, listSource, pinAntigravityEngine, pinClaudeEngine } from "./source-snapshot-content.js"

const log = Log.create({ service: "source-snapshot" })

/** How many times an entry, or a comparison of a checkout with its
 *  snapshot, reads a checkout that changes under the read before it gives
 *  up. */
const READ_ATTEMPTS = 3

/** How the dev entry chose the source its command runs from. `root` is the
 *  snapshot the command imports from, and `signature` is the stat signature
 *  of the checkout while it held exactly that snapshot's source. A failed
 *  entry runs the live checkout and says why. */
export type SourceEntry =
  | {
    readonly kind: "reused" | "created"
    readonly checkout: string
    readonly digest: string
    readonly root: string
    readonly signature: string
    readonly files: number
    readonly bytes: number
    readonly ms: number
    /** The source is refused, but no proved snapshot of the checkout is
     *  there to run in its place, so the command runs it anyway. */
    readonly runsRefused?: true
  }
  | {
    /** The checkout's source is a refused snapshot, so the command runs the
     *  proved snapshot `digest` in its place. `signature` is the stat
     *  signature of the checkout while it held the refused source `refused`. */
    readonly kind: "proved"
    readonly checkout: string
    readonly digest: string
    readonly refused: string
    readonly root: string
    readonly signature: string
    readonly ms: number
  }
  | { readonly kind: "failed"; readonly checkout: string; readonly reason: string; readonly ms: number }

/** What a test supplies in place of the running entry and comparison. */
export interface SourceEntrySeams {
  /** Runs after each copy and before the walk that checks it. */
  readonly afterCopy?: () => void
  /** Runs after each walk whose files are then read. */
  readonly beforeRead?: () => void
  /** The bytes a pinned `agy` must hold, in place of the pin's. */
  readonly antigravityPin?: AntigravityPinnedBytes
}

/** The name of an entry this process makes in the snapshot home and
 *  removes itself: a copy or a record it is still writing (`tmp`), or a
 *  snapshot it is deleting (`removing`). The name carries this process's
 *  holder text (`process-holder.ts`), with its spaces as dashes, so a sweep
 *  removes only what a process that is proven gone left. */
function createdEntryName(kind: "tmp" | "removing"): string {
  return `.${kind}-${encodeHolderText(process.pid, processHolders.own()).replaceAll(" ", "-")}-${randomBytes(4).toString("hex")}`
}

/** The process that made an entry of the snapshot home, or undefined when
 *  no process made it under a `createdEntryName`. */
function creatorOf(name: string): ProcessHolder | undefined {
  const holder = /^\.(?:tmp|removing)-(.+)-[0-9a-f]{8}$/.exec(name)?.[1]
  return holder === undefined ? undefined : decodeHolderText(holder.replaceAll("-", " "))
}

/** The snapshot that the last entry made for a signature. */
interface LatestSnapshot {
  readonly signature: string
  readonly digest: string
  readonly files: number
  readonly bytes: number
}

const LATEST_FILE = "latest.json"

/** A cache: a record this build does not recognize is a miss, and the next
 *  entry that copies writes it again. */
function readLatest(home: string): LatestSnapshot | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(join(home, LATEST_FILE), "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    if (!("version" in parsed) || parsed.version !== 1) return undefined
    if (!("signature" in parsed) || typeof parsed.signature !== "string") return undefined
    if (!("digest" in parsed) || typeof parsed.digest !== "string" || !isSourceSnapshotDigest(parsed.digest)) return undefined
    if (!("files" in parsed) || typeof parsed.files !== "number") return undefined
    if (!("bytes" in parsed) || typeof parsed.bytes !== "number") return undefined
    return { signature: parsed.signature, digest: parsed.digest, files: parsed.files, bytes: parsed.bytes }
  } catch {
    return undefined
  }
}

/** Records the snapshot an entry chose for the next entry. The record is
 *  only a cache, so one that cannot be written costs the next entry one
 *  copy, which then finds this snapshot by its digest, and this entry still
 *  runs from its snapshot. */
function writeLatest(checkout: string, latest: LatestSnapshot): void {
  const home = sourceSnapshotHome(checkout)
  const pending = join(home, createdEntryName("tmp"))
  try {
    fs.writeFileSync(pending, `${JSON.stringify({ version: 1, ...latest })}\n`)
    fs.renameSync(pending, join(home, LATEST_FILE))
  } catch (error) {
    log.warn("the record of the last snapshot could not be written, so the next dev entry copies the checkout again", { checkout, digest: latest.digest, error: errorMessage(error) })
    try {
      fs.rmSync(pending, { force: true })
    } catch {
      // A sweep removes the pending record once this process is gone.
    }
  }
}

/** Removes a copy that this entry made and does not publish, off the
 *  thread. A copy that cannot be removed now, such as one on Windows that a
 *  scanner holds open, stays for a sweep, which removes it once this process
 *  is gone, and the entry goes on. */
async function discardCopy(temporary: string): Promise<void> {
  try {
    await fs.promises.rm(temporary, { recursive: true, force: true })
  } catch {
    // A later sweep removes it, because its name names this process.
  }
}

/** Moves a finished copy to its digest's name. A snapshot of that digest
 *  that is already there is the same source, so this entry reuses it. */
async function publishCopy(temporary: string, target: string): Promise<"created" | "reused"> {
  try {
    fs.renameSync(temporary, target)
    return "created"
  } catch (error) {
    const code = errnoCode(error)
    if ((code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "EPERM") || !fs.existsSync(target)) throw error
    await discardCopy(temporary)
    return "reused"
  }
}

const gateName = (digest: string): string => `${digest}.gate`

/** The directories from a checkout down to its snapshot home. */
function snapshotHomeParts(checkout: string): string[] {
  return relative(checkout, sourceSnapshotHome(checkout)).split(/[\\/]/)
}

/** Opens the snapshot home of `checkout`, creating it. Every directory from
 *  the checkout down to it must be a real directory, never a link: a module
 *  in a snapshot names the checkout by its own real path, and a link would
 *  put the snapshot, and what the entry writes, outside the checkout. */
function openSnapshotHome(checkout: string): ContainedDirectory {
  return openContainedDirectory(checkout, snapshotHomeParts(checkout))
}

const PROOF_FILE = "proof.json"
const PROOF_GATE = "proof.gate"
const PROOF_MAX_BYTES = 4096

const SnapshotDigestSchema = Schema.String.check(Schema.makeFilter((digest: string) => isSourceSnapshotDigest(digest) || "a snapshot digest is sixteen hex characters"))

/** The proof record of a checkout's snapshots. `proved` is the last snapshot
 *  one of whose project executors reported ready. `refused` is the snapshot a
 *  dev service left because its executors could not open, with the reason;
 *  the dev entry and the cutover check never run it again while the proved
 *  snapshot is there. */
const SnapshotProofSchema = Schema.Struct({
  version: Schema.Literal(1),
  proved: Schema.optionalKey(SnapshotDigestSchema),
  refused: Schema.optionalKey(Schema.Struct({ digest: SnapshotDigestSchema, reason: Schema.String })),
})
type SnapshotProof = typeof SnapshotProofSchema.Type
const decodeProof = Schema.decodeUnknownSync(SnapshotProofSchema)

/** How the proof record stands. `unknown` is a record of a shape this build
 *  does not know, which names no snapshot and which the next change
 *  replaces. A record that cannot be read at all is an error, never an empty
 *  record, so no change is made over it and no sweep removes a snapshot on
 *  its account. */
type StoredProof =
  | { readonly kind: "absent" }
  | { readonly kind: "known"; readonly proof: SnapshotProof }
  | { readonly kind: "unknown"; readonly content: string; readonly reason: string }

const NO_PROOF: SnapshotProof = { version: 1 }

/** The contents already reported as a shape this build does not know, and
 *  the read errors already reported, so each is reported once. */
const reportedProofs = new Set<string>()

function reportOnce(key: string, report: () => void): void {
  if (reportedProofs.has(key)) return
  reportedProofs.add(key)
  report()
}

/** The proof record in the snapshot home. Throws when it cannot be read. */
function readProof(home: ContainedDirectory): StoredProof {
  const raw = home.readFile(PROOF_FILE, PROOF_MAX_BYTES)
  if (raw === undefined) return { kind: "absent" }
  const content = raw.toString("utf8")
  try {
    return { kind: "known", proof: decodeProof(JSON.parse(content)) }
  } catch (error) {
    return { kind: "unknown", content, reason: errorMessage(error) }
  }
}

/** The proof a reader acts on: a record of a shape this build does not know
 *  names no snapshot and is reported once for each content, and a record
 *  that cannot be read is reported once for each error and answers nothing,
 *  so the reader decides what an unknown proof means for it. */
function knownProof(read: () => StoredProof): SnapshotProof | undefined {
  let stored: StoredProof
  try {
    stored = read()
  } catch (error) {
    const reason = errorMessage(error)
    reportOnce(`error:${reason}`, () => log.warn("the proof record of the checkout's snapshots could not be read", { error: reason }))
    return undefined
  }
  if (stored.kind === "known") return stored.proof
  if (stored.kind === "unknown") reportOnce(stored.content, () => log.warn("the proof record of the checkout's snapshots has a shape this build does not know; it names no snapshot", { error: stored.reason }))
  return NO_PROOF
}

/** The proof record of `checkout`'s snapshots, read once without its gate. */
function proofOf(checkout: string): SnapshotProof | undefined {
  return knownProof(() => {
    const home = openExistingContainedDirectory(checkout, snapshotHomeParts(checkout))
    if (home === undefined) return { kind: "absent" }
    try {
      return readProof(home)
    } finally {
      home.close()
    }
  })
}

/** Applies one change to the proof record under its gate, so the proof of
 *  one service and the refusal of another never lose each other's change. A
 *  change that answers nothing leaves the record as it is. A record that
 *  cannot be read aborts the change by the error it throws, and a record of a
 *  shape this build does not know is reported as it is replaced. */
function changeProof(checkout: string, decide: (proof: SnapshotProof, home: ContainedDirectory) => SnapshotProof | undefined): void {
  const home = openSnapshotHome(checkout)
  try {
    const gate = acquireLockSyncIn(home, PROOF_GATE)
    try {
      const stored = readProof(home)
      const next = decide(stored.kind === "known" ? stored.proof : NO_PROOF, home)
      if (next === undefined) return
      if (stored.kind === "unknown") log.warn("the proof record of the checkout's snapshots has a shape this build does not know; it is replaced by a record of this build's shape", { error: stored.reason })
      const failure = home.publishFileThrough(createdEntryName("tmp"), PROOF_FILE, `${JSON.stringify(next)}\n`)
      if (failure) throw failure
    } finally {
      releaseLockIn(home, gate)
    }
  } finally {
    home.close()
  }
}

/** Records that `snapshot` is proved: one of its project executors reported
 *  ready. Answers true only when this call wrote the proof, so a snapshot the
 *  record already names as proved answers false. A refused snapshot is never
 *  recorded as proved, and a refusal is never cleared here. A record that
 *  cannot be read or written leaves the snapshot unproved and is reported;
 *  the service goes on. */
export function recordSnapshotProved(snapshot: SourceSnapshotLocation): boolean {
  let proved = false
  try {
    changeProof(snapshot.checkout, (proof) => {
      if (proof.refused?.digest === snapshot.digest || proof.proved === snapshot.digest) return undefined
      proved = true
      return { ...proof, proved: snapshot.digest }
    })
  } catch (error) {
    log.warn("the proof of the dev service's snapshot could not be recorded", { checkout: snapshot.checkout, digest: snapshot.digest, error: errorMessage(error) })
    return false
  }
  return proved
}

/** How a refusal of a snapshot ended: `returned` names the proved snapshot
 *  the next dev entry runs in its place; `stays` is lasting, because no other
 *  snapshot of the checkout is proved and still there, or this one is the
 *  proved one; `retries` means the record could not be read or written now. */
export type SnapshotRefusal =
  | { readonly kind: "returned"; readonly proved: string }
  | { readonly kind: "stays"; readonly reason: string }
  | { readonly kind: "retries"; readonly reason: string }

/** Records `snapshot` as refused, so the next dev entry runs the proved
 *  snapshot in its place. */
export function refuseSourceSnapshot(snapshot: SourceSnapshotLocation, reason: string): SnapshotRefusal {
  let answer: SnapshotRefusal = { kind: "stays", reason: "no snapshot of this checkout is proved" }
  try {
    changeProof(snapshot.checkout, (proof, home) => {
      const { proved } = proof
      if (proved === undefined) return undefined
      if (proved === snapshot.digest) {
        answer = { kind: "stays", reason: "this snapshot is proved" }
        return undefined
      }
      if (!home.hasEntry(proved)) {
        answer = { kind: "stays", reason: `the proved snapshot ${proved} is gone` }
        return undefined
      }
      answer = { kind: "returned", proved }
      return { version: 1, proved, refused: { digest: snapshot.digest, reason } }
    })
  } catch (error) {
    return { kind: "retries", reason: `the proof record could not be changed: ${errorMessage(error)}` }
  }
  return answer
}

/** Refuses the snapshot `snapshot` that a dev service start ran and that
 *  failed before the service listened, such as checkout source that does not
 *  build, so its manager's next start runs the snapshot that last opened a
 *  project (PI-UPDATES-009). Without it the manager would start the same
 *  broken source again and again, and a client that restarted the service
 *  from away would never reconnect. The caller decides that the failure is
 *  the build's own, not the host's, such as a port another program holds.
 *  Answers true when the next start returns to the proved snapshot. It never
 *  throws. */
export function refuseFailedServiceStart(snapshot: SourceSnapshotLocation, cause: string): boolean {
  const refusal = refuseSourceSnapshot(snapshot, `failed to start: ${cause}`)
  if (refusal.kind !== "returned") {
    log.warn("the dev service failed to start and stays on its source", { digest: snapshot.digest, refusal: refusal.kind, reason: refusal.reason })
    return false
  }
  log.info("the dev service failed to start, so its snapshot is refused and the next start runs the proved snapshot", { refused: snapshot.digest, proved: refusal.proved })
  return true
}

/** The snapshots this process holds, which it releases as it exits. */
const holds: Array<{ readonly checkout: string; readonly hold: SharedHold }> = []

/** Removes this process's holder records as it exits, so a process that
 *  ends normally leaves none, and only a killed one leaves a record for the
 *  next join or sweep to remove. It runs synchronously, as an exit listener
 *  must, and a record it cannot remove is left to them the same way. */
function releaseHolds(): void {
  for (const { checkout, hold } of holds.splice(0)) {
    try {
      const home = openExistingContainedDirectory(checkout, snapshotHomeParts(checkout))
      if (home === undefined) continue
      try {
        releaseSharedHolderIn(home, hold)
      } finally {
        home.close()
      }
    } catch {
      // The next join or sweep removes the record once this process is gone.
    }
  }
}

/** Makes this process a holder of the snapshot `digest` of `checkout`, and
 *  answers false when that snapshot is no longer there. */
function joinSnapshot(home: ContainedDirectory, checkout: string, digest: string): boolean {
  const gate = acquireLockSyncIn(home, gateName(digest))
  try {
    const snapshot = home.openExistingChild(digest)
    if (snapshot === undefined) return false
    snapshot.close()
    // The count removes the record of each holder that is proven gone, such
    // as an executor that its command supervisor killed before it could
    // release its record. So a snapshot that stays in use keeps about one
    // record for each process that runs from it.
    liveSharedHoldersIn(home, gateName(digest))
    if (holds.length === 0) process.once("exit", releaseHolds)
    holds.push({ checkout, hold: registerSharedHolderIn(home, gateName(digest)) })
    return true
  } finally {
    releaseLockIn(home, gate)
  }
}

/** Chooses the source a command of the dev entry runs from and makes this
 *  process a holder of it. It reuses the snapshot the last entry made when
 *  the checkout's stat signature is unchanged. A checkout whose source is
 *  the refused snapshot runs the proved snapshot in its place. Otherwise it
 *  copies the file set, hashes the copy, and walks the checkout again; a
 *  checkout that changed during the copy is copied again, up to
 *  `READ_ATTEMPTS` times. A copy
 *  whose digest is already a snapshot reuses that snapshot. Any failure
 *  answers `failed` with its reason, and the command runs the live checkout
 *  as it would without a snapshot. It never rejects. */
export async function enterSourceSnapshot(checkout: string, seams: SourceEntrySeams = {}): Promise<SourceEntry> {
  const started = performance.now()
  const elapsed = (): number => Math.round(performance.now() - started)
  let real = checkout
  const failed = (reason: string): SourceEntry => ({ kind: "failed", checkout: real, reason, ms: elapsed() })
  let home: ContainedDirectory
  try {
    real = fs.realpathSync(checkout)
    home = openSnapshotHome(real)
  } catch (error) {
    return failed(error instanceof ContainedPathError
      ? `a link or a file holds part of ${sourceSnapshotHome(real)}, so a snapshot there would sit outside the checkout (${error.message})`
      : `the snapshot home could not be opened: ${errorMessage(error)}`)
  }
  const homePath = sourceSnapshotHome(real)
  const entered = (kind: "created" | "reused", snapshot: LatestSnapshot, runsRefused: boolean): SourceEntry => ({ kind, checkout: real, digest: snapshot.digest, root: join(homePath, snapshot.digest), signature: snapshot.signature, files: snapshot.files, bytes: snapshot.bytes, ms: elapsed(), ...(runsRefused ? { runsRefused: true } : {}) })
  // A checkout whose source `digest` could not start runs the proved
  // snapshot in its place while that snapshot is there, and runs the refused
  // source only when it is not. A proof that cannot be read refuses nothing.
  const refusalOf = (digest: string, signature: string): SourceEntry | "runs refused" | undefined => {
    const proof = knownProof(() => readProof(home))
    if (proof?.refused?.digest !== digest) return undefined
    if (proof.proved === undefined || proof.proved === digest || !joinSnapshot(home, real, proof.proved)) return "runs refused"
    return { kind: "proved", checkout: real, digest: proof.proved, refused: digest, root: join(homePath, proof.proved), signature, ms: elapsed() }
  }
  let temporary: string | undefined
  try {
    // oxlint-disable-next-line no-unreachable-loop -- false positive: `continue` repeats this loop, which oxlint misreads inside a try with catch and finally
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      const listing = await listSource(real)
      const { files, signature } = listing
      const latest = readLatest(homePath)
      if (latest?.signature === signature) {
        const refusal = refusalOf(latest.digest, signature)
        if (typeof refusal === "object") return refusal
        if (joinSnapshot(home, real, latest.digest)) return entered("reused", latest, refusal === "runs refused")
      }
      temporary = join(homePath, createdEntryName("tmp"))
      const antigravity = await pinAntigravityEngine(real, temporary, listing, seams.antigravityPin)
      seams.beforeRead?.()
      const copy = await copyAndDigest(real, files, temporary, antigravity)
      seams.afterCopy?.()
      if (copy === undefined || (await listSource(real)).signature !== signature) {
        await discardCopy(temporary)
        temporary = undefined
        continue
      }
      await pinClaudeEngine(real, temporary)
      await linkClientPackages(real, temporary)
      const kind = await publishCopy(temporary, join(homePath, copy.digest))
      temporary = undefined
      const snapshot = { signature, digest: copy.digest, files: files.length, bytes: copy.bytes }
      const refusal = refusalOf(copy.digest, signature)
      if (typeof refusal === "object") {
        writeLatest(real, snapshot)
        return refusal
      }
      // A sweep can remove a snapshot that nothing holds yet, between its
      // publication and this join. The next attempt makes it again.
      if (!joinSnapshot(home, real, copy.digest)) continue
      writeLatest(real, snapshot)
      return entered(kind, snapshot, refusal === "runs refused")
    }
    return failed(`the checkout changed during each of ${READ_ATTEMPTS} copies`)
  } catch (error) {
    return failed(`the snapshot could not be made: ${errorMessage(error)}`)
  } finally {
    if (temporary !== undefined) await discardCopy(temporary)
    home.close()
  }
}

let adopted: SourceEntry | undefined
/** The snapshot this process holds, by digest. */
let held: string | undefined

/** Hands this process's entry decision to the copy of this module that the
 *  process runs, which is the snapshot's own when the entry chose one, and
 *  records the decision once. No environment variable carries it, because
 *  every executor and agent command inherits the environment. A record that
 *  a process makes before it opens its own log goes to the account log. */
export function adoptSourceEntry(entry: SourceEntry): void {
  adopted = entry
  if (entry.kind === "failed") {
    log.warn("this process runs its live checkout, because its source could not be snapshotted", { checkout: entry.checkout, reason: entry.reason, ms: entry.ms })
    return
  }
  held = entry.digest
  if (entry.kind === "proved") {
    log.info("this process runs the last proved snapshot of its checkout, because the checkout's source could not start", { checkout: entry.checkout, digest: entry.digest, refused: entry.refused, ms: entry.ms })
  } else if (entry.runsRefused === true) {
    log.warn("this process runs its checkout's refused source, because no proved snapshot of the checkout is there to run in its place", { checkout: entry.checkout, digest: entry.digest, ms: entry.ms })
  } else {
    log.info(entry.kind === "created" ? "this process runs from a new snapshot of its checkout" : "this process runs from an existing snapshot of its checkout", { checkout: entry.checkout, digest: entry.digest, files: entry.files, bytes: entry.bytes, ms: entry.ms })
  }
}

/** How the source of a dev service's checkout differs from the snapshot the
 *  service runs from, by the digest of each: the trigger of the replacement
 *  that makes way for a service of the checkout's current source. */
export interface SourceChange {
  readonly kind: "source changed"
  readonly checkout: string
  readonly ownDigest: string
  readonly currentDigest: string
}

/** A service's answer to one client's cutover request: `retiring` once it
 *  has begun to make way for another service, which `beforeRetire` tells
 *  the client before the listener withdraws, and `busy` while it stays. */
export type CutoverAnswer = (beforeRetire?: () => Promise<void>) => Promise<"busy" | "retiring">

/** Asks the service's replacement owner to make way for the source `trigger`
 *  names, and records it with the request. */
export type SourceReplacementRequest = (trigger: SourceChange, beforeRetire: (() => Promise<void>) | undefined) => Promise<"busy" | "retiring">

/** The source a service runs from, as the service uses it once its log is
 *  open. A service that runs no snapshot, an installed one or a dev service
 *  of a live checkout, names none, sweeps none, and answers a cutover by its
 *  build alone. */
export interface ServiceSource {
  /** The snapshot the service runs from, which its identity record names. */
  readonly snapshot: SourceSnapshotLocation | undefined
  /** Present while the service runs the proved snapshot `running` because
   *  its checkout's source `refused` could not start, which its update
   *  status names. */
  readonly refusedSource: { readonly refused: string; readonly running: string } | undefined
  /** Sweeps the other snapshots of the checkout that holds `snapshot`. The
   *  service starts it once it listens and never waits for it. It never
   *  rejects. */
  sweepOthers(): Promise<void>
  /** The service's answer to a new client's cutover request. It weighs the
   *  build first, through `build`. A service that stays for its build and
   *  runs from a snapshot then compares its checkout's source with the
   *  snapshot, and makes way through `request` when they differ. */
  cutoverAnswer(build: CutoverAnswer, request: SourceReplacementRequest): CutoverAnswer
}

/** The source the dev service runs from, once its log is open: the snapshot
 *  its entry chose, or undefined when it runs from its live checkout. */
export function reportSourceEntry(seams: SourceEntrySeams = {}): ServiceSource | undefined {
  const snapshot = runningSourceSnapshot()
  // A service that runs live has no snapshot for its checkout to differ
  // from, and sweeps none; the next service that runs from a snapshot of its
  // checkout does.
  if (snapshot === undefined) return undefined
  const signature = adopted?.kind !== "failed" && adopted?.digest === snapshot.digest ? adopted.signature : undefined
  const sourceChange = sourceChangeCheck(snapshot, signature, seams)
  return {
    snapshot,
    refusedSource: adopted?.kind === "proved" && adopted.digest === snapshot.digest ? { refused: adopted.refused, running: snapshot.digest } : undefined,
    sweepOthers: () => sweepSourceSnapshots(snapshot),
    cutoverAnswer: (build, request) => async (beforeRetire) => {
      if ((await build(beforeRetire)) === "retiring") return "retiring"
      const change = await sourceChange()
      // The service that makes way is replaced by whatever source its
      // checkout holds when the successor starts.
      return change === undefined ? "busy" : await request(change, beforeRetire)
    },
  }
}

/** Compares the source that `snapshot`'s checkout holds now with the
 *  snapshot. A checkout that holds the snapshot's source, or a refused
 *  source, which the service never makes way for, holds no change.
 *  `signature` is a stat signature of the checkout while it held such a
 *  source, when one is known. A walk whose signature matches it answers at
 *  once. Any other walk hashes the checkout, and a hash that finds no change
 *  makes that walk's signature the one to match, so a file that was only
 *  touched is hashed once. A file that leaves the checkout between the walk
 *  and the hash makes it walk again. Both read off
 *  the thread: the service answers every client while it compares. */
function sourceChangeCheck(snapshot: SourceSnapshotLocation, signature: string | undefined, seams: SourceEntrySeams): () => Promise<SourceChange | undefined> {
  let matched = signature
  return async () => {
    const started = performance.now()
    try {
      for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
        const listing = await listSource(snapshot.checkout)
        const walked = listing.signature
        const hashed = walked !== matched
        if (hashed) seams.beforeRead?.()
        const digest = hashed ? await checkoutDigest(snapshot.checkout, listing, seams.antigravityPin) : snapshot.digest
        if (digest === undefined) continue
        const refused = digest !== snapshot.digest && proofOf(snapshot.checkout)?.refused?.digest === digest
        if (digest !== snapshot.digest && !refused) return { kind: "source changed", checkout: snapshot.checkout, ownDigest: snapshot.digest, currentDigest: digest }
        matched = walked
        if (refused) log.debug("the checkout holds a source that could not start, so the dev service keeps serving from its snapshot", { checkout: snapshot.checkout, digest, hashed, ms: Math.round(performance.now() - started) })
        else log.debug("the checkout holds the source of the dev service's snapshot", { checkout: snapshot.checkout, digest, hashed, ms: Math.round(performance.now() - started) })
        return undefined
      }
      throw new Error(`the checkout changed during each of ${READ_ATTEMPTS} reads`)
    } catch (error) {
      log.warn("the dev service could not compare its checkout's source with its snapshot, so it keeps serving from the snapshot", { checkout: snapshot.checkout, digest: snapshot.digest, error: errorMessage(error) })
      return undefined
    }
  }
}

/** Makes this process a holder of the snapshot it runs from, so no sweep
 *  removes it while the process runs. A process outside a snapshot, or one
 *  that already holds it, does nothing. A process started by a holder
 *  registers while that holder still holds the snapshot, so a process that
 *  outlives its starter, such as a handed-over command supervisor, stays
 *  protected. A join that fails leaves the process running unheld and says
 *  so once. */
export function holdRunningSnapshot(): void {
  const running = runningSourceSnapshot()
  if (running === undefined || held === running.digest) return
  try {
    const home = openSnapshotHome(running.checkout)
    try {
      if (!joinSnapshot(home, running.checkout, running.digest)) throw new Error("the snapshot this process runs from is gone")
    } finally {
      home.close()
    }
    held = running.digest
  } catch (error) {
    log.warn("this process runs from a snapshot it could not hold, so a sweep can remove the snapshot while it runs", { checkout: running.checkout, digest: running.digest, error: errorMessage(error) })
  }
}

/** What a test supplies in place of a running sweep. */
export interface SweepSeams {
  /** Runs after the sweep lists the snapshot home and before it takes any
   *  gate. */
  readonly afterList?: () => Promise<void>
}

/** Moves the snapshot `digest` out of every join's reach when no process
 *  holds it, and answers its new name. The holders are counted under the
 *  snapshot's gate, which every join takes, so a join that registered
 *  before the gate was taken keeps the snapshot, and a join after the rename
 *  finds no snapshot and makes it again. A gate that a join or another sweep
 *  holds keeps the snapshot until a later sweep. */
function retireUnheld(home: ContainedDirectory, digest: string): string | undefined {
  const gate = tryAcquireLockSyncIn(home, gateName(digest))
  if (gate === undefined) return undefined
  try {
    if (!home.hasEntry(digest) || liveSharedHoldersIn(home, gateName(digest)) > 0) return undefined
    const removing = createdEntryName("removing")
    home.renameInto(digest, home, removing)
    return removing
  } finally {
    releaseLockIn(home, gate)
  }
}

/** The entries of the snapshot home that no process needs: each snapshot
 *  other than `running` and the proved one that no process holds, moved out
 *  of every join's reach, and each entry whose creator is proven gone. A
 *  failure on one entry is added to `failures`, and the others are still
 *  read. */
async function unneededEntries(running: SourceSnapshotLocation, seams: SweepSeams, failures: string[]): Promise<string[]> {
  const home = openSnapshotHome(running.checkout)
  try {
    const names = home.entryNames()
    // The proved snapshot is never removed, so a proof that cannot be read
    // removes no snapshot at all.
    const proof = knownProof(() => readProof(home))
    if (proof === undefined) failures.push("the proof record could not be read, so no snapshot was removed")
    await seams.afterList?.()
    const unneeded: string[] = []
    for (const name of names) {
      try {
        if (isSourceSnapshotDigest(name)) {
          const retired = proof === undefined || name === running.digest || name === proof.proved ? undefined : retireUnheld(home, name)
          if (retired !== undefined) unneeded.push(retired)
          continue
        }
        const creator = creatorOf(name)
        if (creator !== undefined && processHolders.state(creator).kind === "gone") unneeded.push(name)
      } catch (error) {
        failures.push(`${name}: ${errorMessage(error)}`)
      }
    }
    return unneeded
  } finally {
    home.close()
  }
}

/** The bytes of the files under `path`, or of `path` itself when it is a
 *  file. It never enters a link, such as the link to the client's packages:
 *  Bun's recursive `readdir` follows links, so it walks one level at a time. */
async function bytesUnder(path: string): Promise<number> {
  const stats = await fs.promises.lstat(path)
  if (!stats.isDirectory()) return stats.size
  const entries = await fs.promises.readdir(path, { withFileTypes: true })
  const sizes = await Promise.all(entries.filter((entry) => !entry.isSymbolicLink()).map((entry) => bytesUnder(join(path, entry.name))))
  return sizes.reduce((sum, size) => sum + size, 0)
}

/** Removes what no process needs from the snapshot home that holds
 *  `running`, the snapshot this process runs from: every other snapshot that
 *  no process holds and that is not the proved one, and every copy or
 *  removal whose creator is proven gone. A removal that fails, such as one on Windows that meets a file in use,
 *  leaves its entry for the next sweep. The deletions run by path and off
 *  the main thread, because a contained directory deletes only
 *  synchronously, and a snapshot holds about 2000 files whose synchronous
 *  deletion holds every client's traffic for about 150 ms. It never rejects:
 *  it records what it removed once, and its failures once. */
export async function sweepSourceSnapshots(running: SourceSnapshotLocation, seams: SweepSeams = {}): Promise<void> {
  const started = performance.now()
  const homePath = sourceSnapshotHome(running.checkout)
  const failures: string[] = []
  let unneeded: string[] = []
  try {
    unneeded = await unneededEntries(running, seams, failures)
  } catch (error) {
    failures.push(errorMessage(error))
  }
  let removed = 0
  let bytes = 0
  for (const name of unneeded) {
    try {
      const path = join(homePath, name)
      const size = await bytesUnder(path)
      await fs.promises.rm(path, { recursive: true, force: true })
      removed += 1
      bytes += size
    } catch (error) {
      failures.push(`${name}: ${errorMessage(error)}`)
    }
  }
  if (removed > 0) log.info("removed the snapshots of the checkout that no process runs from", { checkout: running.checkout, removed, bytes, ms: Math.round(performance.now() - started) })
  if (failures.length > 0) log.warn("the dev service could not remove every snapshot that no process runs from; the next dev service start tries again", { checkout: running.checkout, failures: failures.length, error: failures[0] })
}
