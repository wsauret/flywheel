import { chmodSync, closeSync, mkdtempSync, openSync, readdirSync, readSync, rmSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Result, Schema } from "effect"

import { writeFileAtomic } from "./atomic-write.js"
import { Log } from "./log.js"
import { privateTemporaryRoot, type PrivateTemporaryRootStem } from "./private-temporary-root.js"
import { unixGroupRuns, unixProcessIdentity, windowsProcessIdentity, type ProcessIdentity } from "./process-container.js"
import { applyWindowsPrivateDirectoryAcl } from "./windows-private-directory-acl.js"

/** The retained output of one persistent process, and how long it lives.
 *
 *  A persistent process outlives the process that launched it, so it can hold
 *  none of that process's pipes. It writes its stdout and stderr into files in
 *  a private directory instead, one for each launch, inside this user's spool
 *  root in the temporary directory. The directory lives exactly as long
 *  as a process can still use it: the launcher until it releases the process,
 *  because it reads the output, and the process itself until it exits,
 *  because it writes the output. Each holder is recorded in the directory by
 *  its pid and its start identity, so a process that finds the directory later
 *  can prove that both holders are gone. A pid alone proves nothing, because
 *  the system gives a free pid to the next process that starts. */

const log = Log.create({ service: "persistent-spool" })

const MAX_READ_BYTES = 64 * 1024
/** Every spool of this user lives in one private root, `flywheel-spools-<uid>`. */
const SPOOL_ROOT_STEM = "flywheel-spools" satisfies PrivateTemporaryRootStem
const SPOOL_PREFIX = "spool-"
const HOLDERS_FILE = "holders.json"

export interface PersistentSpool {
  readonly directory: string
  readonly stdoutPath: string
  readonly stderrPath: string
}

export interface WritablePersistentSpool extends PersistentSpool {
  readonly stdoutFd: number
  readonly stderrFd: number
}

export interface PersistentRead {
  readonly data: Uint8Array
  readonly nextOffset: number
  readonly eof: boolean
}

/** One process that holds a spool. `identity` is its start identity when the
 *  hold was recorded; a holder recorded without one is proven gone only by a
 *  pid that holds no process at all. */
export interface SpoolHolder {
  readonly pid: number
  readonly identity?: string
}

/** Who holds a spool: the launcher until it releases the process, and the
 *  writer until it exits. */
export interface SpoolHolders {
  readonly launcher?: SpoolHolder
  readonly writer: SpoolHolder
}

/** What the kernel answers about the processes a spool names. */
export interface SpoolHolderProbe {
  identify(pid: number): ProcessIdentity
  /** Whether a process still runs in process group `pgid`. Only macOS and
   *  Linux have groups: there the writer is launched as the leader of a new
   *  one, and every process in it inherited the spool's descriptors. */
  groupRuns?(pgid: number): boolean
}

/** Where a sweep looks and how it proves who runs. Each field defaults to
 *  this host: its temporary directory and its kernel. */
export interface SpoolSweepHost {
  readonly temporary?: string
  readonly probe?: SpoolHolderProbe
}

const kernelProbe: SpoolHolderProbe = process.platform === "win32"
  ? { identify: (pid) => windowsProcessIdentity(pid) }
  : { identify: (pid) => unixProcessIdentity(pid), groupRuns: (pgid) => unixGroupRuns(pgid) }

// Version 1 is the first shape. A spool that an earlier release made lies
// directly in the temporary directory, outside the spool root, and has no
// record that could prove its writer gone, so no sweep reads it.
const Holder = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  identity: Schema.optionalKey(Schema.String),
})
const HoldersRecord = Schema.Struct({
  version: Schema.Literal(1),
  launcher: Schema.optionalKey(Holder),
  writer: Holder,
})
const decodeHolders = Schema.decodeUnknownResult(HoldersRecord, { onExcessProperty: "error" })

/** Acquires private output files. The caller closes both descriptors after
 * spawning the writer; failed acquisition releases its descriptors and
 * directory. It is synchronous so that a launch spawns its writer in the
 * caller's turn: a client starts the account service and then imports its
 * interface in one long synchronous step, and a spawn that waited for a later
 * turn waited for all of that import on every cold start. */
export function createPersistentSpool(temporary: string = tmpdir()): WritablePersistentSpool {
  const directory = mkdtempSync(join(privateTemporaryRoot(temporary, SPOOL_ROOT_STEM), SPOOL_PREFIX))
  let stdoutFd: number | undefined
  try {
    applyWindowsPrivateDirectoryAcl(directory)
    chmodSync(directory, 0o700)
    const stdoutPath = join(directory, "stdout")
    const stderrPath = join(directory, "stderr")
    stdoutFd = openSync(stdoutPath, "wx", 0o600)
    const stderrFd = openSync(stderrPath, "wx", 0o600)
    return { directory, stdoutPath, stderrPath, stdoutFd, stderrFd }
  } catch (error) {
    try { if (stdoutFd !== undefined) closeSync(stdoutFd) } catch { /* preserve the original acquisition error */ }
    try { rmSync(directory, { recursive: true, force: true }) } catch { /* preserve the original acquisition error */ }
    throw error
  }
}

export function spoolHolder(pid: number, identity: ProcessIdentity): SpoolHolder {
  return identity.kind === "process" ? { pid, identity: identity.identity } : { pid }
}

/** Replaces the spool's record of who holds it. The write is atomic, so a
 *  reader sees the previous record or this one and never a torn one. */
export function recordSpoolHolders(directory: string, holders: SpoolHolders): void {
  writeFileAtomic(join(directory, HOLDERS_FILE), JSON.stringify({ version: 1, ...holders }), { mode: 0o600 })
}

/** Removes a spool that nobody holds any more. The record goes last, so a
 *  removal cut short leaves a spool that the next sweep proves and removes
 *  again, never one without a record that no sweep can prove. */
export function removePersistentSpool(directory: string): void {
  let entries: readonly string[]
  try {
    entries = readdirSync(directory)
  } catch (error) {
    if (errorCode(error) === "ENOENT") return
    throw error
  }
  for (const entry of entries) {
    if (entry !== HOLDERS_FILE) rmSync(join(directory, entry), { recursive: true, force: true })
  }
  rmSync(join(directory, HOLDERS_FILE), { force: true })
  rmSync(directory, { recursive: true, force: true })
}

/** Removes every spool whose holders are all proven gone. It covers the one
 *  exit a launcher cannot see: a writer that outlives its launcher and exits
 *  later, or is killed. A spool without a record, and one whose record this
 *  build cannot read, stay. Every failure is contained, so it never rejects. */
export async function sweepPersistentSpools(host: SpoolSweepHost = {}): Promise<void> {
  const { temporary = tmpdir(), probe = kernelProbe } = host
  let root: string
  let names: readonly string[]
  try {
    root = privateTemporaryRoot(temporary, SPOOL_ROOT_STEM)
    names = await readdir(root)
  } catch (error) {
    log.debug("the persistent spool directory could not be swept", { error: errorCode(error) ?? String(error) })
    return
  }
  for (const name of names) {
    const directory = join(root, name)
    try {
      const holders = await readHolders(directory)
      if (holders === undefined) continue
      if (holders.launcher !== undefined && !holderGone(holders.launcher, probe.identify(holders.launcher.pid))) continue
      if (!writerGone(holders.writer, probe)) continue
      removePersistentSpool(directory)
    } catch (error) {
      log.debug("a persistent spool could not be swept; a later launch tries again", { directory, error: errorCode(error) ?? String(error) })
    }
  }
}

export function readPersistentSpool(path: string, offset: number, maxBytes: number): PersistentRead {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("persistent spool offset is invalid")
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_READ_BYTES) throw new Error(`persistent spool reads must be between 1 and ${MAX_READ_BYTES} bytes`)
  const fd = openSync(path, "r")
  try {
    const data = new Uint8Array(maxBytes)
    const length = readSync(fd, data, 0, maxBytes, offset)
    return { data: data.slice(0, length), nextOffset: offset + length, eof: length < maxBytes }
  } finally {
    closeSync(fd)
  }
}

async function readHolders(directory: string): Promise<SpoolHolders | undefined> {
  let text: string
  try {
    text = await readFile(join(directory, HOLDERS_FILE), "utf8")
  } catch (error) {
    // No record yet: a launch is still starting its writer.
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  const decoded = decodeHolders(parsed)
  if (Result.isSuccess(decoded)) return decoded.success
  log.warn("a persistent spool records its holders in a shape this build cannot read, so it stays", { directory })
  return undefined
}

/** A holder is gone when its pid holds no process, or holds a process with
 *  another start identity. A probe that could not answer proves nothing. */
function holderGone(holder: SpoolHolder, now: ProcessIdentity): boolean {
  if (now.kind === "absent") return true
  return now.kind === "process" && holder.identity !== undefined && now.identity !== holder.identity
}

/** The writer is gone only when its process group runs nothing either. A pid
 *  that now holds another process proves that the group ended first, because
 *  the kernel never gives a new process the number of a group that exists. */
function writerGone(writer: SpoolHolder, probe: SpoolHolderProbe): boolean {
  const now = probe.identify(writer.pid)
  if (!holderGone(writer, now)) return false
  return now.kind !== "absent" || probe.groupRuns?.(writer.pid) !== true
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined
}
