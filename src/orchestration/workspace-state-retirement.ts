/** Retirement of one incompatible state generation.
 *
 *  A generation this release cannot read is not preserved for ever. It is staged
 *  as temporary crash-recovery bytes, replaced by an empty current generation,
 *  and then deleted, so a project that has been through a retirement holds one
 *  generation and no archive of the one before it.
 *
 *  Deleting bytes is only ever safe for state this release has declared, so the
 *  epoch table below is the whole decision: an epoch with no declared transition
 *  and no declared cleanup is refused before anything on disk is touched, and a
 *  generation whose epoch cannot be read at all is refused too. Epoch 0 is the
 *  absence of a stamp rather than a generation this release has ever described,
 *  so it is declared nowhere and refused like any other unknown epoch.
 *
 *  Every durable step of the sequence is recorded in one manifest before the
 *  next step begins, and every step is written so that repeating it is
 *  harmless. A start that dies anywhere therefore resumes exactly where it
 *  stopped, and the manifest is the last thing removed.
 *
 *  The manifest is also the only licence to delete. Bytes an older release left
 *  behind are adopted into one before the first of them is unlinked, so a
 *  half-finished deletion is owed work rather than an unclassifiable directory,
 *  and a staging directory no manifest owns refuses the start instead of being
 *  swept as scratch. */

import { Database } from "bun:sqlite"
import { randomUUID } from "node:crypto"
import * as path from "node:path"
import { Schema } from "effect"
import type { ContainedDirectory } from "../infra/descriptor-directory.js"
import { errorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"
import { ServeStartupFailure, type ServeStartRefusal } from "../protocol/serve-handshake.js"
import { redactSecrets } from "../infra/redact-secrets.js"
import { DATABASE_MEMBERS, DATABASE_SIDECARS, EVENT_STORE_MEMBER, GENERATION_MEMBERS } from "./workspace-state-generation-members.js"

const log = Log.create({ service: "workspace.state" })

const PRIVATE = { privateDirectories: true } as const

export const WORKSPACE_STATE_EPOCH = 2

const RETIRING_DIR = "retiring"
const RETIREMENT_MANIFEST = "retirement.json"

/** The one entry every manifest record is published through. It is deterministic
 *  and owned by the operation, so a start killed between the write and the
 *  rename leaves a remainder the next start can read as its own half-finished
 *  publication rather than an entry no operation accounts for. */
const RETIREMENT_MANIFEST_PENDING = "retirement.json.pending"

/** The manifest is one small JSON object; anything larger is not one. */
const MANIFEST_MAX_BYTES = 64 * 1024

/** A refusal or a retirement reason is an operator-facing string. It is redacted
 *  and bounded because it can carry a filesystem error, and nothing in this
 *  module ever reads one back. */
const REASON_MAX_CHARS = 500

/** What one state epoch requires of a start that finds it.
 *
 *  `transition` is what a live generation stamped with this epoch needs.
 *  `cleanup` is what a copy of this epoch staged by an older release needs once
 *  the live generation is settled. An epoch that has no entry has neither
 *  disposition declared, and a start refuses it instead of guessing. */
interface EpochDisposition {
  readonly transition: "current" | "retire"
  readonly cleanup: "delete" | "keep"
}

/** Every epoch this release has an opinion about. An epoch that is absent from
 *  this table, including epoch 0, has neither disposition declared and is
 *  refused. Raising `WORKSPACE_STATE_EPOCH` therefore obliges its author to
 *  declare the edge the bump creates: the guard test over this table fails
 *  while any epoch below the current one is missing. */
export const EPOCH_DISPOSITIONS: ReadonlyMap<number, EpochDisposition> = new Map<number, EpochDisposition>([
  [1, { transition: "retire", cleanup: "delete" }],
  [WORKSPACE_STATE_EPOCH, { transition: "current", cleanup: "keep" }],
])

/** The durable phases of one operation, in the order they are written.
 *
 *  Every mutating step owns two of them: the phase recorded before it begins and
 *  the phase recorded once it is done. The pair is what a resumed start reads to
 *  know which entries may legitimately exist. Before `stamping` no replacement
 *  database may exist at all; between `staged` and `publishing` no staged member
 *  may be back in the held directory; before `discarding` the staged target must
 *  still hold every member the manifest names. */
const RETIREMENT_PHASES = [
  "staging",
  "staged",
  "stamping",
  "stamped",
  "publishing",
  "published",
  "discarding",
  "discarded",
] as const
type RetirementPhase = typeof RETIREMENT_PHASES[number]

function phaseIndex(phase: RetirementPhase): number {
  return RETIREMENT_PHASES.indexOf(phase)
}

/** Where the members this operation owes deletion for are staged: under the
 *  operation's own staging directory, or where an older release left a
 *  quarantine target this start adopted. */
const OperationLocationSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("staging") }),
  Schema.Struct({ kind: Schema.Literal("legacy"), name: Schema.String }),
])

const RetirementManifestSchema = Schema.Struct({
  version: Schema.Literal(3),
  id: Schema.String,
  /** The epoch of the generation being deleted. */
  sourceEpoch: Schema.Int,
  /** The epoch it is being replaced by, which pins the manifest to the release
   *  that wrote it. */
  targetEpoch: Schema.Int,
  reason: Schema.String,
  phase: Schema.Literals(RETIREMENT_PHASES),
  location: OperationLocationSchema,
  members: Schema.Array(Schema.String),
})

type RetirementManifest = typeof RetirementManifestSchema.Type

/** One durable point of the sequence, named by what is on disk once it is
 *  reached. */
export type RetirementCheckpoint =
  | "manifest-published"
  | "legacy-adopted"
  | `member-staged:${string}`
  | `member-discarded:${string}`
  | `phase-recorded:${RetirementPhase}`

let checkpointObserver: ((checkpoint: RetirementCheckpoint) => void) | undefined

/** Watch the durable checkpoints of the retirement sequence. This is how an
 *  interruption fixture stops a real start at a real checkpoint, so resume is
 *  proven against the state production wrote rather than against a hand-staged
 *  imitation of it. Production registers no observer. */
export function observeRetirementCheckpoints(observe: ((checkpoint: RetirementCheckpoint) => void) | undefined): void {
  checkpointObserver = observe
}

function reached(checkpoint: RetirementCheckpoint): void {
  checkpointObserver?.(checkpoint)
}

export interface WorkspaceGenerationOutcome {
  /** Whether the settled generation holds facts an upgrade pass must see. A
   *  generation this start created holds none. */
  readonly migrate: boolean
}

/** Bring the held generation to the current epoch, and report what the caller
 *  still owes it.
 *
 *  `flywheel` is the project's held `.flywheel` directory and `dbFile` is the
 *  event store path inside it. `otherOwnersLive` says whether another process
 *  still owns this generation: while one does, its open database handles and
 *  session directories name the entries a retirement would move, so a
 *  retirement is refused rather than performed behind its back.
 *
 *  Throws, having touched nothing, for state this release cannot classify. */
export function settleWorkspaceGeneration(
  flywheel: ContainedDirectory,
  dbFile: string,
  otherOwnersLive: boolean,
): WorkspaceGenerationOutcome {
  const flywheelDir = path.dirname(dbFile)
  // The pending operation is read before anything is classified, created, or
  // deleted. A staging directory this release cannot account for refuses the
  // whole start here, where the refusal has still changed nothing.
  const pending = recoverPendingOperation(flywheel)
  const outcome = advanceGeneration(flywheel, flywheelDir, otherOwnersLive, pending)
  cleanLegacyTargets(flywheel, flywheelDir)
  sweepSettledStaging(flywheel)
  return outcome
}

/** The event store epoch of the held generation.
 *
 *  Every database member is admitted through the descriptor first, so a link at
 *  the database, its write-ahead log, or its shared-memory file is refused
 *  before SQLite can follow it, and the directory the path names is proven to be
 *  the held one before the handle is opened. */
export function readGenerationEpoch(flywheel: ContainedDirectory, dbFile: string): number {
  for (const name of DATABASE_MEMBERS) flywheel.admitPrivateFile(name)
  flywheel.requireSamePathAs(path.dirname(dbFile))
  return readUserVersion(dbFile)
}

function readUserVersion(dbFile: string): number {
  // Readonly first: probes must not modify state they may refuse. Observed
  // in production: a readonly open of a WAL store fresh from `.backup` (main
  // file only, sidecars absent) failed with SQLITE_CANTOPEN persistently for
  // minutes, and one write-capable open cleared it. Write-capable WAL
  // recovery rewrites only the -shm/-wal sidecars, never database content,
  // and without the fallback the store is refused as unopenable and the
  // runtime worker respawns against the same refusal forever.
  try {
    return readUserVersionWith(dbFile, { readonly: true })
  } catch {
    return readUserVersionWith(dbFile, { readwrite: true, create: false })
  }
}

function readUserVersionWith(dbFile: string, options: ConstructorParameters<typeof Database>[1]): number {
  const db = new Database(dbFile, options)
  try {
    const row = db.query<{ user_version?: unknown }, []>("PRAGMA user_version").get()
    return typeof row?.user_version === "number" ? row.user_version : 0
  } finally {
    db.close()
  }
}

function advanceGeneration(
  flywheel: ContainedDirectory,
  flywheelDir: string,
  otherOwnersLive: boolean,
  pending: RetirementManifest | undefined,
): WorkspaceGenerationOutcome {
  if (pending?.location.kind === "staging") {
    requireSoleOwner(otherOwnersLive, "interrupted retirement")
    runOperation(flywheel, flywheelDir, pending)
    return { migrate: false }
  }
  // An adopted legacy target holds no member of the live generation, so
  // finishing its deletion decides nothing about the generation this start has
  // still to classify.
  if (pending) runOperation(flywheel, flywheelDir, pending)
  const classified = classifyGeneration(flywheel, flywheelDir)
  switch (classified.kind) {
    case "refuse":
      throw new ServeStartupFailure(`workspace state cannot be prepared: ${redactReason(classified.reason)}`, classified.refusal)
    case "fresh":
      createStampedDatabase(flywheel, flywheelDir, EVENT_STORE_MEMBER)
      return { migrate: false }
    case "current":
      return { migrate: true }
    case "retire":
      requireSoleOwner(otherOwnersLive, classified.reason)
      retireGeneration(flywheel, flywheelDir, classified)
      return { migrate: false }
  }
}

function requireSoleOwner(otherOwnersLive: boolean, reason: string): void {
  if (otherOwnersLive) {
    throw new Error(`workspace state cannot be replaced while another owner holds this project's state generation (${redactReason(reason)})`)
  }
}

function redactReason(reason: string): string {
  return redactSecrets(reason).slice(0, REASON_MAX_CHARS)
}

type GenerationClassification =
  | { readonly kind: "fresh" }
  | { readonly kind: "current" }
  | { readonly kind: "retire"; readonly epoch: number; readonly reason: string }
  | { readonly kind: "refuse"; readonly reason: string; readonly refusal?: ServeStartRefusal }

/** Decide what the generation on disk needs, reading only. Every answer that is
 *  not a declared transition is a refusal: retirement deletes what it stages, so
 *  state whose epoch is unproven keeps its exact layout instead. */
function classifyGeneration(flywheel: ContainedDirectory, flywheelDir: string): GenerationClassification {
  const present = GENERATION_MEMBERS.filter((name) => flywheel.hasEntry(name))
  if (!present.includes(EVENT_STORE_MEMBER)) {
    if (present.length === 0) return { kind: "fresh" }
    return { kind: "refuse", reason: `orphaned workspace members without an event store: ${present.join(", ")}` }
  }
  let epoch: number
  try {
    epoch = readGenerationEpoch(flywheel, path.join(flywheelDir, EVENT_STORE_MEMBER))
  } catch (err) {
    return { kind: "refuse", reason: `event store could not be opened: ${errorMessage(err)}` }
  }
  const disposition = EPOCH_DISPOSITIONS.get(epoch)
  // Only a later release stamps an epoch above this one, and only updating
  // Flywheel opens its state; resetting the service never does.
  if (!disposition && epoch > WORKSPACE_STATE_EPOCH) {
    return {
      kind: "refuse",
      reason: `a newer release wrote workspace state epoch ${epoch}; this release reads epoch ${WORKSPACE_STATE_EPOCH}`,
      refusal: { kind: "state-from-newer-release", stateEpoch: epoch, readableEpoch: WORKSPACE_STATE_EPOCH },
    }
  }
  if (!disposition) {
    return { kind: "refuse", reason: `workspace state epoch ${epoch} has no declared transition to epoch ${WORKSPACE_STATE_EPOCH}` }
  }
  if (disposition.transition === "current") return { kind: "current" }
  return { kind: "retire", epoch, reason: `workspace state epoch ${epoch}, current epoch ${WORKSPACE_STATE_EPOCH}` }
}

/** Create one empty database at `name` and stamp it with the current epoch. The
 *  entry is created through the descriptor, so the file SQLite then opens by
 *  path is the one this operation just made, and the bytes are flushed before
 *  any caller is told the database exists. */
function createStampedDatabase(flywheel: ContainedDirectory, flywheelDir: string, name: string): void {
  if (!flywheel.createExclusive(name, "")) throw new Error(`workspace state refuses an existing ${name}`)
  flywheel.requireSamePathAs(flywheelDir)
  const db = new Database(path.join(flywheelDir, name), { create: true })
  try {
    db.exec(`PRAGMA user_version = ${WORKSPACE_STATE_EPOCH}`)
  } finally {
    db.close()
  }
  flywheel.admitPrivateFile(name)
  flywheel.syncFile(name)
}

interface RetirementOperation {
  readonly flywheel: ContainedDirectory
  readonly flywheelDir: string
  /** The operation's own directory, which holds the manifest and, for a
   *  retirement this release staged, the staged generation. */
  readonly retiring: ContainedDirectory
  readonly manifest: RetirementManifest
}

interface RetirementStep {
  /** Recorded before the step mutates anything, so a resumed start knows which
   *  half-made entries this operation owns. */
  readonly begun: RetirementPhase
  /** Recorded once the step's durable effect is complete. */
  readonly done: RetirementPhase
  readonly run: (operation: RetirementOperation) => void
}

const RETIREMENT_STEPS: readonly RetirementStep[] = [
  { begun: "staging", done: "staged", run: stageMembers },
  { begun: "stamping", done: "stamped", run: stampReplacement },
  { begun: "publishing", done: "published", run: publishReplacement },
  { begun: "discarding", done: "discarded", run: discardStagedMembers },
]

function retireGeneration(
  flywheel: ContainedDirectory,
  flywheelDir: string,
  classified: { readonly epoch: number; readonly reason: string },
): void {
  const manifest: RetirementManifest = {
    version: 3,
    id: randomUUID(),
    sourceEpoch: classified.epoch,
    targetEpoch: WORKSPACE_STATE_EPOCH,
    reason: redactReason(classified.reason),
    phase: "staging",
    location: { kind: "staging" },
    members: GENERATION_MEMBERS.filter((name) => flywheel.hasEntry(name)),
  }
  // The manifest is published before the staging target exists, so a staging
  // target no manifest names can never be this release's work.
  publishManifest(flywheel, manifest)
  reached("manifest-published")
  runOperation(flywheel, flywheelDir, manifest)
}

function publishManifest(flywheel: ContainedDirectory, manifest: RetirementManifest): void {
  const retiring = flywheel.openChild(RETIRING_DIR, PRIVATE)
  try {
    recordManifest(retiring, requireManifestContract(manifest))
  } finally {
    retiring.close()
  }
}

/** Write one manifest record through the operation's own pending entry, so the
 *  only remainder a start killed inside the write can leave is one this
 *  protocol names. */
function recordManifest(retiring: ContainedDirectory, manifest: RetirementManifest): void {
  retiring.publishFileThrough(RETIREMENT_MANIFEST_PENDING, RETIREMENT_MANIFEST, JSON.stringify(manifest))
}

/** Run every step the manifest still owes, then remove the manifest. */
function runOperation(flywheel: ContainedDirectory, flywheelDir: string, initial: RetirementManifest): void {
  const retiring = flywheel.openChild(RETIRING_DIR, PRIVATE)
  try {
    const operation: RetirementOperation = { flywheel, flywheelDir, retiring, manifest: initial }
    requireResumeState(operation)
    let phase = initial.phase
    for (const step of pendingSteps(initial.phase)) {
      phase = recordPhase(operation, phase, step.begun)
      step.run(operation)
      phase = recordPhase(operation, phase, step.done)
    }
    if (phaseIndex(phase) >= phaseIndex("discarded")) removeEmptiedTarget(operation)
    // The manifest is the operation: while it is there the sequence is owed, and
    // removing it is what completes the work. Every byte it licensed the
    // deletion of is already gone.
    retiring.removeFile(RETIREMENT_MANIFEST)
  } finally {
    retiring.close()
  }
  log.warn(initial.location.kind === "staging" ? "workspace state retired" : "legacy workspace state discarded", {
    epoch: initial.sourceEpoch,
    reason: initial.reason,
  })
}

/** Write the manifest at `next`, unless it already reads that way. The phase is
 *  the only field a step changes, so the record written is the manifest this
 *  operation began with, carrying how far it has got. */
function recordPhase(operation: RetirementOperation, current: RetirementPhase, next: RetirementPhase): RetirementPhase {
  if (current === next) return current
  recordManifest(operation.retiring, { ...operation.manifest, phase: next })
  reached(`phase-recorded:${next}`)
  return next
}

function pendingSteps(phase: RetirementPhase): readonly RetirementStep[] {
  return RETIREMENT_STEPS.filter((step) => phaseIndex(step.done) > phaseIndex(phase))
}

/** Refuse a resumed operation whose disk does not match the phase it recorded.
 *
 *  A member in both the held directory and the staged target, or in neither,
 *  means something outside this operation moved it; a replacement database
 *  before the operation began stamping one, or a source that reappeared after
 *  it was staged, mean the same. Deleting the staged bytes needs one more
 *  thing: the generation that replaced them must be live, because the staged
 *  copy is the only other copy there is. None of this can be resolved by
 *  guessing which copy is the generation. */
function requireResumeState(operation: RetirementOperation): void {
  const { manifest } = operation
  if (manifest.location.kind === "legacy") return
  const at = phaseIndex(manifest.phase)
  if (at < phaseIndex("stamping") && operation.flywheel.hasEntry(temporaryDatabaseName(manifest.id))) {
    throw new Error("workspace retirement found a replacement database it had not begun to stamp")
  }
  if (at >= phaseIndex("staged")) {
    // Once publication has begun, the event store name is the replacement's, so
    // it is the one member of the staged generation that may be back.
    const published = at >= phaseIndex("publishing")
    const reappeared = manifest.members.filter((name) =>
      !(published && name === EVENT_STORE_MEMBER) && operation.flywheel.hasEntry(name))
    if (reappeared.length > 0) {
      throw new Error(`workspace retirement cannot prove the location of ${reappeared.join(", ")}`)
    }
  }
  if (at >= phaseIndex("staged") && at < phaseIndex("discarding")) {
    const target = openStagedTarget(operation)
    try {
      const missing = manifest.members.filter((name) => target?.hasEntry(name) !== true)
      if (missing.length > 0) throw new Error(`workspace retirement cannot prove the location of ${missing.join(", ")}`)
    } finally {
      target?.close()
    }
  }
  if (at >= phaseIndex("discarding")) requirePublishedReplacement(operation)
}

/** Refuse to discard the staged generation unless the one that replaced it is
 *  live: an event store of the manifest's target epoch, in the held directory.
 *  Until that holds, the staged bytes are the project's only state. */
function requirePublishedReplacement(operation: RetirementOperation): void {
  if (!operation.flywheel.hasEntry(EVENT_STORE_MEMBER)) {
    throw new Error("workspace retirement cannot discard the generation it staged without the replacement it published")
  }
  const epoch = readGenerationEpoch(operation.flywheel, path.join(operation.flywheelDir, EVENT_STORE_MEMBER))
  if (epoch !== operation.manifest.targetEpoch) {
    throw new Error(`workspace retirement found epoch ${epoch} published, not the target epoch ${operation.manifest.targetEpoch}`)
  }
}

/** Hold the directory this operation's members are staged in, or report that it
 *  is gone. */
function openStagedTarget(operation: RetirementOperation): ContainedDirectory | undefined {
  const { location } = operation.manifest
  if (location.kind === "staging") return operation.retiring.openExistingChild(operation.manifest.id)
  return withLegacyStateDirectory(operation.flywheel, (state) => state?.openExistingChild(location.name))
}

/** Where the members this operation owes deletion for are staged, as a path. A
 *  path-taking library, which is what reads a database epoch, cannot be handed a
 *  descriptor, so the identity of the directory is proven against the held
 *  descriptor before the path is used. */
function stagedTargetPath(operation: RetirementOperation): string {
  const { location } = operation.manifest
  return location.kind === "staging"
    ? path.join(operation.flywheelDir, RETIRING_DIR, operation.manifest.id)
    : path.join(operation.flywheelDir, LEGACY_QUARANTINE_DIR, LEGACY_STATE_DIR, location.name)
}

/** Refuse unless the database of `directory` still carries `expected`.
 *
 *  A manifest is a licence to move and to delete one named generation, and its
 *  own text is not evidence that the bytes on disk are still that generation. So
 *  the epoch is read from the database itself at both destructive boundaries:
 *  once immediately before the first rename, and once immediately before the
 *  first discard. Every database member is admitted through the descriptor
 *  first, so a link at the database or at one of its sidecars is refused before
 *  SQLite can follow it, and a database that will not open refuses the operation
 *  rather than being deleted unproven. */
function requireStampedEpoch(
  directory: ContainedDirectory,
  directoryPath: string,
  expected: number,
  where: "live" | "staged",
): void {
  for (const name of DATABASE_MEMBERS) directory.admitPrivateFile(name)
  directory.requireSamePathAs(directoryPath)
  let epoch: number
  try {
    epoch = readUserVersion(path.join(directoryPath, EVENT_STORE_MEMBER))
  } catch (err) {
    throw new Error(`workspace retirement cannot read the epoch of the ${where} generation: ${redactReason(errorMessage(err))}`, { cause: err })
  }
  if (epoch !== expected) {
    throw new Error(`workspace retirement found the ${where} generation stamped epoch ${epoch}, not the epoch ${expected} its manifest owns`)
  }
}

/** Remove the staged target once every member it held is gone. It is removed as
 *  one empty directory, so an entry that appeared after the discard proved the
 *  target empty refuses the operation instead of being deleted with it. */
function removeEmptiedTarget(operation: RetirementOperation): void {
  const { location } = operation.manifest
  const removed = location.kind === "staging"
    ? operation.retiring.removeEmptyChild(operation.manifest.id)
    : withLegacyStateDirectory(operation.flywheel, (state) => state?.removeEmptyChild(location.name) !== false)
  if (!removed) throw new Error("workspace retirement refuses to remove a target that is no longer empty")
}

/** Move every member the manifest names into the staging target. A member is in
 *  exactly one of the two places, because a rename is atomic: in both or in
 *  neither means something outside this operation moved it, and the operation
 *  refuses rather than guessing which copy is the generation. */
function stageMembers(operation: RetirementOperation): void {
  // The epoch is read again here, as close to the first rename as a path-taking
  // database API allows: the classification that chose retirement is older than
  // this manifest, and only a live generation still stamped `sourceEpoch` may be
  // moved aside. A generation an interrupted attempt already staged is not in
  // the held directory to read.
  if (operation.flywheel.hasEntry(EVENT_STORE_MEMBER)) {
    requireStampedEpoch(operation.flywheel, operation.flywheelDir, operation.manifest.sourceEpoch, "live")
  }
  const target = operation.retiring.openChild(operation.manifest.id, PRIVATE)
  try {
    for (const name of operation.manifest.members) {
      const live = operation.flywheel.hasEntry(name)
      const staged = target.hasEntry(name)
      if (live === staged) throw new Error(`workspace retirement cannot prove the location of ${name}`)
      if (staged) continue
      operation.flywheel.renameInto(name, target, name)
      reached(`member-staged:${name}`)
    }
  } finally {
    target.close()
  }
  const remaining = GENERATION_MEMBERS.filter((name) => operation.flywheel.hasEntry(name))
  if (remaining.length > 0) {
    throw new Error(`workspace retirement observed ${remaining.join(", ")} after the generation was staged`)
  }
}

/** Create the replacement database under a name only this operation uses, so no
 *  reader can ever mistake it for the event store.
 *
 *  A replacement an interrupted attempt left is adopted when it already carries
 *  the current epoch, and discarded only when it is proven not to: the
 *  create-only path below is never run against a database that is already the
 *  complete replacement. */
function stampReplacement(operation: RetirementOperation): void {
  const temporary = temporaryDatabaseName(operation.manifest.id)
  if (operation.flywheel.hasEntry(temporary)) {
    if (stampedEpoch(operation.flywheel, operation.flywheelDir, temporary) === WORKSPACE_STATE_EPOCH) return
    operation.flywheel.removeFile(temporary)
  }
  createStampedDatabase(operation.flywheel, operation.flywheelDir, temporary)
}

/** Publish the replacement with one rename inside the held directory, so the
 *  event store either is the old generation's or is the new one's. */
function publishReplacement(operation: RetirementOperation): void {
  const temporary = temporaryDatabaseName(operation.manifest.id)
  if (operation.flywheel.hasEntry(temporary)) {
    if (operation.flywheel.hasEntry(EVENT_STORE_MEMBER)) {
      throw new Error("workspace retirement refuses to publish over an event store it did not stage")
    }
    operation.flywheel.renameInto(temporary, operation.flywheel, EVENT_STORE_MEMBER)
  }
  const epoch = readGenerationEpoch(operation.flywheel, path.join(operation.flywheelDir, EVENT_STORE_MEMBER))
  if (epoch !== WORKSPACE_STATE_EPOCH) {
    throw new Error(`workspace retirement published epoch ${epoch}, not the current epoch ${WORKSPACE_STATE_EPOCH}`)
  }
}

/** Delete the staged generation one member at a time, then the target that held
 *  them.
 *
 *  The staged bytes are crash-recovery state, not an archive: once the
 *  replacement is published there is nothing left to recover them for. A
 *  deletion interrupted part way through leaves the manifest, which still names
 *  every member, so the next start finishes the same list instead of meeting a
 *  target it can no longer prove. */
function discardStagedMembers(operation: RetirementOperation): void {
  const target = openStagedTarget(operation)
  if (target) {
    try {
      // The last read before bytes go: the staged copy must still be the
      // generation this manifest owns. A database a resumed start already
      // discarded is not there to read, and its epoch was proven before that
      // deletion began.
      if (target.hasEntry(EVENT_STORE_MEMBER)) {
        requireStampedEpoch(target, stagedTargetPath(operation), operation.manifest.sourceEpoch, "staged")
      }
      for (const name of operation.manifest.members) {
        if (!target.hasEntry(name)) continue
        target.removeTree(name)
        reached(`member-discarded:${name}`)
      }
      // The epoch probes above and at adoption can have recreated the database
      // sidecars (see readUserVersion). Every manifest licenses the database
      // member itself, so bytes only SQLite recovery puts beside it are this
      // operation's residue, never user data, and go with it.
      for (const name of DATABASE_SIDECARS) {
        if (target.hasEntry(name)) target.removeTree(name)
      }
      const unaccounted = target.entryNames()
      if (unaccounted.length > 0) {
        throw new Error(`workspace retirement refuses to discard a target holding ${[...unaccounted].sort().join(", ")}`)
      }
    } finally {
      target.close()
    }
  }
  removeEmptiedTarget(operation)
}

function temporaryDatabaseName(id: string): string {
  return `retiring-${id}.sqlite`
}

/** The manifest of an operation a previous start left unfinished, published
 *  first when that start died inside the publication of it.
 *
 *  A project that never retired anything holds no staging directory at all, and
 *  an emptied one is the harmless remainder of a finished operation. Anything
 *  else in there is unproven: a staging directory with entries and no manifest,
 *  or one holding entries no operation owns, refuses the start.
 *
 *  The pending entry is the exception, because this protocol wrote it and knows
 *  what it means. Alone, it is a manifest whose rename never landed, so it is
 *  renamed into place and owed from its first phase. Beside a published
 *  manifest of the same operation it is a phase record whose rename never
 *  landed, so it is dropped and the operation replays from the phase that is
 *  published. Anything else it could be refuses the start.
 *
 *  Every manifest is read as a bounded regular file of a held directory, so a
 *  link put in its place is refused rather than read, and every refusal here
 *  happens before the first byte is moved. */
function recoverPendingOperation(flywheel: ContainedDirectory): RetirementManifest | undefined {
  const retiring = flywheel.openExistingChild(RETIRING_DIR)
  if (!retiring) return undefined
  try {
    const entries = retiring.entryNames()
    const published = readManifestEntry(retiring, RETIREMENT_MANIFEST)
    const pending = readManifestEntry(retiring, RETIREMENT_MANIFEST_PENDING)
    const manifest = published ?? pending
    if (!manifest) {
      if (entries.length === 0) return undefined
      throw new Error(`workspace state refuses a staging directory no operation owns: ${unownedList(entries)}`)
    }
    if (published && pending && pending.id !== published.id) {
      throw new Error("workspace state refuses a pending manifest of another operation")
    }
    const owned = new Set([
      RETIREMENT_MANIFEST,
      ...(pending ? [RETIREMENT_MANIFEST_PENDING] : []),
      ...(manifest.location.kind === "staging" ? [manifest.id] : []),
    ])
    const foreign = entries.filter((entry) => !owned.has(entry))
    if (foreign.length > 0) {
      throw new Error(`workspace state refuses a staging directory holding ${unownedList(foreign)}, which no operation owns`)
    }
    if (pending) {
      if (published) retiring.removeFile(RETIREMENT_MANIFEST_PENDING)
      else retiring.renameInto(RETIREMENT_MANIFEST_PENDING, retiring, RETIREMENT_MANIFEST)
    }
    return manifest
  } finally {
    retiring.close()
  }
}

/** One manifest entry of the staging directory, or undefined when it is absent.
 *  A manifest that does not decode, or that does not hold every invariant its
 *  writer always holds, throws: it is a licence to delete, so an unproven one
 *  refuses the start rather than being swept as scratch. */
function readManifestEntry(retiring: ContainedDirectory, name: string): RetirementManifest | undefined {
  const bytes = retiring.readFile(name, MANIFEST_MAX_BYTES)
  if (bytes === undefined) return undefined
  return requireManifestContract(Schema.decodeUnknownSync(RetirementManifestSchema)(JSON.parse(bytes.toString("utf8"))))
}

function unownedList(entries: readonly string[]): string {
  return [...entries].sort().join(", ")
}

/** Remove the staging directory a settled operation left empty. It is removed as
 *  one empty directory, so it holds no bytes and this deletes nothing; a staging
 *  directory that is not empty is the refusal below, never scratch to sweep. */
function sweepSettledStaging(flywheel: ContainedDirectory): void {
  if (flywheel.removeEmptyChild(RETIRING_DIR)) return
  const retiring = flywheel.openExistingChild(RETIRING_DIR)
  let entries: readonly string[] = []
  if (retiring) {
    try {
      entries = retiring.entryNames()
    } finally {
      retiring.close()
    }
  }
  throw new Error(`workspace state refuses a staging directory no operation owns: ${unownedList(entries)}`)
}

/** The invariants the writer above always holds, which the schema itself cannot
 *  state: one safe path component for every name, the epoch edge this release
 *  declares, and a member set drawn from what the location may hold, without
 *  repeats and never without the event store. */
function requireManifestContract(manifest: RetirementManifest): RetirementManifest {
  const allowed: readonly string[] = manifest.location.kind === "staging"
    ? GENERATION_MEMBERS
    : [...LEGACY_DELETABLE_ENTRIES]
  const wellFormed = isSafeComponent(manifest.id)
    && (manifest.location.kind === "staging" || isSafeComponent(manifest.location.name))
    && manifest.targetEpoch === WORKSPACE_STATE_EPOCH
    && declaresDeletableSource(manifest)
    && new Set(manifest.members).size === manifest.members.length
    && manifest.members.includes(EVENT_STORE_MEMBER)
    && manifest.members.every((name) => allowed.includes(name))
    // An adopted legacy target owes deletion and nothing else: its replacement
    // generation was published by the release that staged it.
    && (manifest.location.kind === "staging" || phaseIndex(manifest.phase) >= phaseIndex("discarding"))
  if (!wellFormed) throw new Error("workspace retirement manifest violates its writer contract")
  return manifest
}

function declaresDeletableSource(manifest: RetirementManifest): boolean {
  const disposition = EPOCH_DISPOSITIONS.get(manifest.sourceEpoch)
  if (!disposition) return false
  return manifest.location.kind === "staging" ? disposition.transition === "retire" : disposition.cleanup === "delete"
}

/** One name this module may hand a descriptor operation. `..` is the one that
 *  matters: it names the parent of the tree the operation is contained in. */
function isSafeComponent(name: string): boolean {
  return name.length > 0 && name !== "." && name !== ".." && !name.includes("/") && !name.includes("\0")
}

const LEGACY_QUARANTINE_DIR = "quarantine"
const LEGACY_STATE_DIR = "workspace-state"
const LEGACY_MANIFEST = "quarantine.json"

/** The whole vocabulary the legacy writer used, mapped to the entry it left in
 *  the target for each name it declared. A sidecar was preserved beside the
 *  database under a suffixed name; the session tree kept its own name. A
 *  manifest that does not declare exactly these four names, once each, was not
 *  written by that release, so the target it belongs to is never proven. */
const LEGACY_MEMBER_ENTRIES: ReadonlyMap<string, string> = new Map([
  [EVENT_STORE_MEMBER, EVENT_STORE_MEMBER],
  ["flywheel.sqlite-wal", "flywheel.sqlite-wal.preserved"],
  ["flywheel.sqlite-shm", "flywheel.sqlite-shm.preserved"],
  ["sessions", "sessions"],
])

/** Every entry a proven legacy target may hold: the entries of the members it
 *  moved, and its own manifest. */
const LEGACY_DELETABLE_ENTRIES: ReadonlySet<string> = new Set([LEGACY_MANIFEST, ...LEGACY_MEMBER_ENTRIES.values()])

const QuarantineManifestV1Schema = Schema.Struct({
  version: Schema.Literal(1),
  id: Schema.String,
  reason: Schema.String,
  members: Schema.Array(Schema.Struct({
    name: Schema.String,
    existed: Schema.Boolean,
    moved: Schema.Boolean,
  })),
})

/** What one legacy target is proven to be. Nothing here is read from the legacy
 *  manifest's prose: the epoch comes from the database's own stamp and the
 *  members from the entries the target actually holds. */
interface ProvenLegacyTarget {
  readonly epoch: number
  readonly members: readonly string[]
}

/** Adopt and delete the completed quarantine targets an older release left
 *  behind. Remove this conversion after 2026-12-18, when no store still carries
 *  a `quarantine/workspace-state` target. Only the ones this release can prove: one finalized target whose
 *  manifest accounts for every entry it holds, and whose database carries an
 *  epoch this release retires. Anything else keeps its exact layout.
 *
 *  A proven target is adopted into this release's own operation manifest before
 *  the first of its entries is unlinked, so a deletion interrupted half way
 *  through is owed work the next start finishes rather than a target it can no
 *  longer prove. */
function cleanLegacyTargets(flywheel: ContainedDirectory, flywheelDir: string): void {
  const stateDir = path.join(flywheelDir, LEGACY_QUARANTINE_DIR, LEGACY_STATE_DIR)
  const names = withLegacyStateDirectory(flywheel, (state) => (state ? [...state.entryNames()].sort() : []))
  for (const name of names) {
    const proven = withLegacyStateDirectory(
      flywheel,
      (state) => state && proveLegacyTarget(state, name, path.join(stateDir, name)),
    )
    if (!proven) continue
    const manifest: RetirementManifest = {
      version: 3,
      id: randomUUID(),
      sourceEpoch: proven.epoch,
      targetEpoch: WORKSPACE_STATE_EPOCH,
      reason: redactReason(`legacy quarantine of workspace state epoch ${proven.epoch}`),
      phase: "discarding",
      location: { kind: "legacy", name },
      members: proven.members,
    }
    publishManifest(flywheel, manifest)
    reached("legacy-adopted")
    runOperation(flywheel, flywheelDir, manifest)
  }
  removeEmptiedLegacyTree(flywheel)
}

/** Hold the legacy state directory for the length of `use`, or hand it
 *  `undefined` when this project has none. */
function withLegacyStateDirectory<T>(flywheel: ContainedDirectory, use: (state: ContainedDirectory | undefined) => T): T {
  const quarantine = flywheel.openExistingChild(LEGACY_QUARANTINE_DIR)
  if (!quarantine) return use(undefined)
  try {
    const state = quarantine.openExistingChild(LEGACY_STATE_DIR)
    try {
      return use(state)
    } finally {
      state?.close()
    }
  } finally {
    quarantine.close()
  }
}

/** Remove the legacy tree once nothing is left in it. Each level is removed as
 *  one empty directory, so nothing a user could want back is ever discarded, and
 *  a level something else wrote into keeps what it holds. */
function removeEmptiedLegacyTree(flywheel: ContainedDirectory): void {
  const quarantine = flywheel.openExistingChild(LEGACY_QUARANTINE_DIR)
  if (!quarantine) return
  try {
    if (!quarantine.removeEmptyChild(LEGACY_STATE_DIR)) return
  } finally {
    quarantine.close()
  }
  flywheel.removeEmptyChild(LEGACY_QUARANTINE_DIR)
}

/** Whether one entry of the legacy state directory is a target this release may
 *  adopt, and what it is proven to hold. Every failure to prove it, including an
 *  entry that is not a directory at all and a manifest that does not decode, is
 *  "leave it alone". */
function proveLegacyTarget(state: ContainedDirectory, name: string, targetDir: string): ProvenLegacyTarget | undefined {
  try {
    const target = state.openExistingChild(name)
    if (!target) return undefined
    try {
      const moved = provenLegacyMembers(target, name)
      if (!moved) return undefined
      const epoch = stampedEpoch(target, targetDir, EVENT_STORE_MEMBER)
      if (EPOCH_DISPOSITIONS.get(epoch)?.cleanup !== "delete") return undefined
      return { epoch, members: [...moved, LEGACY_MANIFEST] }
    } finally {
      target.close()
    }
  } catch {
    return undefined
  }
}

/** The entries a finalized legacy target is proven to hold beside its own
 *  manifest, or undefined when the target is not proven at all.
 *
 *  The manifest is read as a claim and checked against the disk it describes: it
 *  must name itself, declare the legacy writer's whole vocabulary once each,
 *  declare the database as one that existed and was moved, and declare of every
 *  other member exactly what the target holds. The target may then hold nothing
 *  but the entries of the members it says it moved, and its own manifest. A
 *  target that fails any of that is a user's own directory this release cannot
 *  read, and it keeps its exact layout. */
function provenLegacyMembers(target: ContainedDirectory, name: string): readonly string[] | undefined {
  const bytes = target.readFile(LEGACY_MANIFEST, MANIFEST_MAX_BYTES)
  if (bytes === undefined) return undefined
  const manifest = Schema.decodeUnknownSync(QuarantineManifestV1Schema)(JSON.parse(bytes.toString("utf8")))
  if (manifest.id !== name) return undefined
  const declared = new Map(manifest.members.map((member) => [member.name, member]))
  if (declared.size !== manifest.members.length || declared.size !== LEGACY_MEMBER_ENTRIES.size) return undefined
  const moved: string[] = []
  for (const [declaredName, entry] of LEGACY_MEMBER_ENTRIES) {
    const member = declared.get(declaredName)
    if (!member) return undefined
    const present = target.hasEntry(entry)
    if (member.existed !== present || member.moved !== present) return undefined
    if (present) moved.push(entry)
  }
  if (!moved.includes(EVENT_STORE_MEMBER)) return undefined
  const entries = target.entryNames()
  if (entries.length !== moved.length + 1) return undefined
  const owned = new Set([...moved, LEGACY_MANIFEST])
  return entries.every((entry) => owned.has(entry)) ? moved : undefined
}

/** The epoch a database entry of `directory` carries, or -1 when it will not
 *  open: an epoch the table does not hold, so the caller keeps what it found. */
function stampedEpoch(directory: ContainedDirectory, directoryPath: string, name: string): number {
  directory.admitPrivateFile(name)
  directory.requireSamePathAs(directoryPath)
  try {
    return readUserVersion(path.join(directoryPath, name))
  } catch {
    return -1
  }
}