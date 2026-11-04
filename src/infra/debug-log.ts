import { closeSync, fstatSync, openSync, readdirSync, readSync, renameSync, writeSync } from "node:fs"
import { readdir, stat, unlink } from "node:fs/promises"
import { StringDecoder } from "node:string_decoder"
import { randomUUID } from "node:crypto"
import { threadId } from "node:worker_threads"
import path from "node:path"
import type { EventScanFilter } from "./event-store-search.js"
import { LOG_DIR } from "./paths.js"
import { ensurePrivateDirectoryUnder, PRIVATE_FILE_MODE } from "./private-path.js"
import { diagnosticTier, diagnosticVersion } from "./diagnostics-registry.js"
import { isProcessAlive } from "./process-liveness.js"
import { createOrderedLane } from "./ordered-lane.js"
import { errorDetail } from "./error-message.js"
import { redactSecrets } from "./redact-secrets.js"

/** One JSONL diagnostics record. Not durable state: the retention sweep
 *  deletes these files, and no behavioral path reads them. `Log` rows share
 *  this shape as `log.<level>` records. */
export interface DebugLogRecord {
  ts: number
  sessionId?: string
  type: string
  actor?: string
  version?: number
  payload?: unknown
}

export type DebugLogRecordInput = Omit<DebugLogRecord, "ts" | "version"> & {
  /** For a family the registry declares "notable": this record reports work
   *  that failed, stalled, or ran slow, so it reaches the default level. The
   *  mark routes the record and is not written. */
  readonly notable?: boolean
}

/** A record a Worker's log forwarded to its owner. Its type and session are
 *  checked here, because the owner's stream files and filters by them; the
 *  payload is diagnostics and crosses as it is. */
export function parseForwardedLogRecord(value: unknown): DebugLogRecordInput | undefined {
  if (typeof value !== "object" || value === null || !("type" in value) || typeof value.type !== "string") return undefined
  const sessionId = "sessionId" in value && typeof value.sessionId === "string" ? value.sessionId : undefined
  const actor = "actor" in value && typeof value.actor === "string" ? value.actor : undefined
  return {
    type: value.type,
    ...("payload" in value ? { payload: value.payload } : {}),
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(actor === undefined ? {} : { actor }),
  }
}

/** Serialize one record as a JSONL line with the timestamp stamped at write.
 *  Returns null when the payload cannot serialize (for example, a circular
 *  reference). Secret scrubbing here is defense-in-depth: typed Redacted
 *  wrappers are the primary guard. An error at any depth lands as structured
 *  detail: its own fields can hold a whole schema tree and the decoded value,
 *  as an Effect SchemaError's `issue` does. The replacer reads the raw value
 *  from its holder because `JSON.stringify` hands it `toJSON` output, which
 *  Effect errors define. */
export function formatDebugLogLine(input: DebugLogRecordInput): string | null {
  try {
    const { notable: _routing, ...record } = input
    const version = diagnosticVersion(input.type)
    return `${redactSecrets(JSON.stringify({ ts: Date.now(), ...record, ...(version === undefined ? {} : { version }) }, function (key, value) {
      const raw = this[key]
      return raw instanceof Error ? errorDetail(raw) : value
    }))}\n`
  } catch {
    return null
  }
}

/** Whether a record reaches the sink at the current verbosity. */
function passesTier(input: DebugLogRecordInput, verbose: boolean): boolean {
  if (verbose) return true
  const tier = diagnosticTier(input.type)
  return tier === "info" || (tier === "notable" && input.notable === true)
}

/** How long a closed `.jsonl` file is kept after its last write. */
const RETENTION_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Byte budget for one log directory, open files included. Retention deletes
 *  closed files, oldest first, until the directory fits it. It is eight times
 *  MAX_FILE_BYTES: each live writer holds at most one file of that size that
 *  retention may not delete, so while fewer than eight writers run, the rest
 *  of the budget keeps closed files, the marked logs of a crash among them. */
const RETENTION_BYTES = 512 * 1024 * 1024

/** File count ceiling for one log directory, open files included. The byte
 *  budget alone lets a crash loop leave a small file per launch without
 *  bound, and every sweep and every `events search` reads each file. Beyond
 *  the ceiling the oldest ordinary closed files go first. */
const RETENTION_FILES = 256

/** The name suffix of a file whose process the account recorded as exiting
 *  unexpectedly. Retention deletes such a file only after every ordinary
 *  closed file, or when it expires with age. */
const UNEXPECTED_EXIT_SUFFIX = ".unexpected-exit.jsonl"

/** The writer a file name names. The name is
 *  `<timestamp>-<pid>-<threadId>-<uuid>.jsonl`, and the timestamp keeps its
 *  date dashes, so the pid is the run of digits after the timestamp's `Z`,
 *  never the first dash-delimited field. The thread id is present only when a
 *  UUID follows it, which tells it apart from the first UUID group of a name
 *  in the shape before it, `<timestamp>-<pid>-<uuid>.jsonl`. */
const LOG_FILE_WRITER = /^\d{4}-\d{2}-\d{2}T\d+Z-(\d+)-(?:(\d+)-(?=[0-9a-f]{8}-[0-9a-f]{4}-))?/

export interface LogFileWriter {
  readonly pid: string
  /** One process thread that writes its own file: a Worker has a sink of its
   *  own beside its process's main thread. */
  readonly writer: string
}

/** The launch timestamp a file name starts with. */
function launchStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "")
}

/** The writer a log file name names, or undefined for a name in no known
 *  shape. Retention and the release harness both read writers through this. */
export function logFileWriter(file: string): LogFileWriter | undefined {
  const match = LOG_FILE_WRITER.exec(file)
  const pid = match?.[1]
  if (pid === undefined) return undefined
  const thread = match?.[2]
  // Remove after 2026-12-23: a name written before 2026-09-23 carries no
  // thread id, so each such process reads as one writer, as those builds
  // were swept. By that date no build that writes that shape still runs, and
  // its files have aged out.
  if (thread === undefined) return { pid, writer: pid }
  return { pid, writer: `${pid}:${thread}` }
}

/** Byte cap for one `.jsonl` file. A long-lived writer holds its newest file
 *  for its whole life, so retention can never reclaim it however big it
 *  gets. Rolling at a cap, with the rolled files of a live writer counted
 *  like any other closed file, is what keeps that one writer inside the
 *  directory's byte budget, and what bounds the share of the budget that
 *  live writers hold. */
const MAX_FILE_BYTES = 64 * 1024 * 1024

/** Records of one INFO-tier type in a single launch before the sink reports
 *  the family as high volume. INFO is for per-request and per-turn families;
 *  crossing this means a per-event or per-read family was declared INFO by
 *  mistake, which no static check can catch because it depends on call rate.
 *  The sink says so once instead of quietly growing the file. */
const HIGH_VOLUME_TYPE_RECORDS = 50_000

interface RetentionPolicy {
  readonly ageMs: number
  readonly bytes: number
  readonly files: number
}

interface LogFileEntry {
  readonly file: string
  readonly mtime: number
  readonly size: number
}

/** Retention for the diagnostics directory. A `.log` file is deleted on
 *  sight: nothing writes text logs anymore, so one is stale by definition.
 *  The file a running writer is writing is never touched; that is its
 *  newest, since a running writer holds it open, and without this rule a
 *  service that respawns every few seconds sweeps away the diagnostics of the
 *  one resident service that outlives them all. Every other `.jsonl` file is
 *  closed, including the files a running writer rolled away from, and goes
 *  once it is older than the age limit. While the directory is still over its
 *  byte budget or its file count, closed files go oldest first: ordinary
 *  files before the files of a process that exited unexpectedly, so the logs
 *  that explain a crash outlive routine ones. Every failure is contained:
 *  retention is best-effort and must never disrupt logging. */
async function sweep(dir: string, policy: RetentionPolicy): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }
  const remove = async (file: string): Promise<void> => {
    try {
      await unlink(path.join(dir, file))
    } catch {
      // Another process's sweep can delete the file first.
    }
  }
  for (const name of names.filter((f) => f.endsWith(".log"))) await remove(name)
  const jsonl = names.filter((file) => file.endsWith(".jsonl"))
  // The file each live writer is writing: its newest by name, since the name
  // opens with the launch or roll timestamp in sortable form.
  const openFileByWriter = new Map<string, string>()
  for (const file of jsonl) {
    const writer = logFileWriter(file)?.writer
    if (writer === undefined) continue
    const newest = openFileByWriter.get(writer)
    if (newest === undefined || file > newest) openFileByWriter.set(writer, file)
  }
  const isOpen = (file: string): boolean => {
    const writer = logFileWriter(file)
    return writer !== undefined && openFileByWriter.get(writer.writer) === file && isProcessAlive(Number(writer.pid))
  }
  const entries: LogFileEntry[] = []
  for (const file of jsonl) {
    try {
      const stats = await stat(path.join(dir, file))
      entries.push({ file, mtime: stats.mtimeMs, size: stats.size })
    } catch {
      // Another process's sweep can delete a listed file first.
    }
  }
  const expiredBefore = Date.now() - policy.ageMs
  let bytes = 0
  let files = 0
  const closed: LogFileEntry[] = []
  for (const entry of entries) {
    const open = isOpen(entry.file)
    if (!open && entry.mtime < expiredBefore) {
      await remove(entry.file)
      continue
    }
    bytes += entry.size
    files += 1
    if (!open) closed.push(entry)
  }
  const byAge = (a: LogFileEntry, b: LogFileEntry): number => a.mtime - b.mtime
  const evictionOrder = [
    ...closed.filter((entry) => !entry.file.endsWith(UNEXPECTED_EXIT_SUFFIX)).sort(byAge),
    ...closed.filter((entry) => entry.file.endsWith(UNEXPECTED_EXIT_SUFFIX)).sort(byAge),
  ]
  for (const entry of evictionOrder) {
    if (bytes <= policy.bytes && files <= policy.files) return
    await remove(entry.file)
    bytes -= entry.size
    files -= 1
  }
}

// Namespace singleton for the same reason Log was one over the text stream:
// the diagnostics destination is process-global by definition, and producers
// must be able to record from any module without threading a sink handle
// through constructors. Log's level methods write through this same sink, so
// a thread writes every record to one descriptor, in call order.
export namespace DebugLog {
  // The descriptor of the file this thread writes. Each record is one
  // synchronous write to it, so the record is in the file when record()
  // returns. The kernel then keeps it through any kill of the process, a
  // SIGKILL during a synchronous stall among them; only a host crash or a
  // power loss can lose it. No record is fsynced, because a disk flush for
  // each record would stall the thread that logs.
  let descriptor: number | null = null
  // A thread that owns no log file hands every record to the thread that
  // does, which writes it to its own file (`forward`).
  let forwardRecord: ((input: DebugLogRecordInput) => void) | null = null
  let warned = false
  // Bytes written to the open file. Tracked here rather than stat'd per
  // record: the write is the one syscall a record costs.
  let fileBytes = 0
  let logDirectory: string | null = null
  let maxFileBytes = MAX_FILE_BYTES
  let retention: RetentionPolicy = { ageMs: RETENTION_AGE_MS, bytes: RETENTION_BYTES, files: RETENTION_FILES }
  // The retention sweeps this sink started, one after another. close()
  // awaits them so that no sweep outlives the sink that started it.
  const sweeps = createOrderedLane()
  let highVolumeRecords = HIGH_VOLUME_TYPE_RECORDS
  let verbose = false
  // Records written per type this launch, and the types already reported as
  // high volume, so the report fires once rather than per record.
  let typeCounts = new Map<string, number>()
  let reportedHighVolume = new Set<string>()

  // One warning per launch, straight to stderr: Log writes through this sink,
  // so a broken sink cannot report its own failure through Log. The sink must
  // never throw to a caller.
  const warnOnce = (error: unknown): void => {
    if (warned) return
    warned = true
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(redactSecrets(`debug log write failed: ${message}\n`))
  }

  /** Whether records have a destination: a log directory, open or still to
   *  be opened by the first record, or a thread that writes them. */
  export const isOpen = (): boolean => {
    return logDirectory !== null || forwardRecord !== null
  }

  /** Open a fresh `.jsonl` file and make it the sink, then sweep retention
   *  in the background. The sweep lists and stats the whole directory, so it
   *  never runs on the path that opens the file; it starts after the file
   *  exists, which also puts that file among the ones it spares. A file that
   *  cannot open returns null, and the next record tries again. */
  const openFile = (logDir: string): number | null => {
    const timestamp = launchStamp(new Date())
    const filepath = path.join(logDir, `${timestamp}-${process.pid}-${threadId}-${randomUUID()}.jsonl`)
    try {
      descriptor = openSync(filepath, "wx", PRIVATE_FILE_MODE)
    } catch (error) {
      warnOnce(error)
      return null
    }
    fileBytes = 0
    const policy = retention
    void sweeps.run(() => sweep(logDir, policy)).catch(() => {})
    return descriptor
  }

  /** Close the file this thread writes. Every record is already in it, so
   *  the close has nothing to wait for. */
  const closeFile = (): void => {
    const open = descriptor
    descriptor = null
    if (open === null) return
    try {
      closeSync(open)
    } catch (error) {
      warnOnce(error)
    }
  }

  /** Write one whole line at the file's position, looping on a short write.
   *  A write that fails after part of the line is in the file closes the
   *  file: that part would join the next record into one line that no reader
   *  parses, so the next record opens a fresh file instead. */
  const writeLine = (fd: number, line: string): void => {
    const bytes = Buffer.from(line)
    let written = 0
    try {
      while (written < bytes.length) written += writeSync(fd, bytes, written)
    } catch (error) {
      if (written > 0) closeFile()
      throw error
    } finally {
      fileBytes += written
    }
  }

  /** Make the project log directory this thread's destination. The thread's
   *  `.jsonl` file opens at the first record that passes its tier, and the
   *  retention sweep starts then: a launch that records nothing at its level
   *  leaves no empty file behind, which would count toward the file ceiling
   *  and be read by every sweep and every search. `Log.init` calls this at
   *  boot; every diagnostics producer in the thread then shares the file. A
   *  long launch rolls to further files as each reaches MAX_FILE_BYTES. A
   *  record that arrives while a re-init closes the previous sink goes
   *  where it would after close(), and the new directory replaces that. */
  export const init = async (options: DirectoryOptions): Promise<void> => {
    await close()
    openDirectory(options)
  }

  type DirectoryOptions = {
    dir: string
    maxFileBytes?: number
    highVolumeRecords?: number
    retentionAgeMs?: number
    retentionBytes?: number
    retentionFiles?: number
  }

  /** Make `options.dir` this thread's destination at once, in place of any
   *  other: `Log` calls it inside a record call, which cannot wait. Throws
   *  when the directory cannot be made. */
  export const openDirectory = (options: DirectoryOptions): void => {
    detach()
    warned = false
    maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES
    highVolumeRecords = options.highVolumeRecords ?? HIGH_VOLUME_TYPE_RECORDS
    retention = {
      ageMs: options.retentionAgeMs ?? RETENTION_AGE_MS,
      bytes: options.retentionBytes ?? RETENTION_BYTES,
      files: options.retentionFiles ?? RETENTION_FILES,
    }
    typeCounts = new Map()
    reportedHighVolume = new Set()
    logDirectory = ensurePrivateDirectoryUnder(options.dir, LOG_DIR)
  }

  /** Hand every record to `send` instead of writing it, for a thread that
   *  must open no log file of its own. The receiving thread passes each record
   *  to its own `record`, so the record lands in that thread's file and every
   *  rule of that file (tier, volume, roll) is applied once, where it is written.
   *  The tier is also checked here, so a record the level drops never crosses
   *  the thread boundary. */
  export const forward = async (send: (input: DebugLogRecordInput) => void): Promise<void> => {
    await close()
    detach()
    warned = false
    forwardRecord = send
  }

  /** Whether the verbose diagnostic families are written. `Log.init` ties this
   *  to the DEBUG level, so one control turns on both `log.debug` records and
   *  the per-event fact families rather than two unrelated knobs. */
  export const setVerbose = (enabled: boolean): void => {
    verbose = enabled
  }

  /** Report a family that crossed the high-volume threshold, once per type.
   *  Written through the sink itself so it lands in the same file as the
   *  family it names. */
  const reportHighVolume = (type: string, count: number): void => {
    if (reportedHighVolume.has(type)) return
    reportedHighVolume.add(type)
    record({
      type: "log.warn",
      payload: {
        service: "debug-log",
        message: "high volume diagnostic type at info tier",
        diagnosticType: type,
        records: count,
        hint: "declare this type as debug in diagnostics-registry.ts",
      },
    })
  }

  /** Append one record. The record is in the thread's file when this
   *  returns, in call order with every other record of the thread. With no
   *  destination, or when its file cannot open or its write fails, a record is
   *  dropped: the debug log is a non-durable diagnostics channel and no caller
   *  may depend on a write landing, so the caller never sees a throw.
   *
   *  The type's registered tier decides whether the record is written at all,
   *  so a producer never chooses its own verbosity and an undeclared family
   *  stays quiet. The check runs before serialization: a dropped record costs
   *  a map lookup, not a JSON encode. */
  export const record = (input: DebugLogRecordInput): void => {
    if (!passesTier(input, verbose)) return
    if (forwardRecord) {
      try {
        forwardRecord(input)
      } catch (error) {
        warnOnce(error)
      }
      return
    }
    if (logDirectory === null) return
    const seen = (typeCounts.get(input.type) ?? 0) + 1
    typeCounts.set(input.type, seen)
    const line = formatDebugLogLine(input)
    if (line === null) {
      warnOnce(new Error(`record of type ${input.type} did not serialize`))
      return
    }
    const fd = descriptor ?? openFile(logDirectory)
    if (fd === null) return
    try {
      writeLine(fd, line)
    } catch (error) {
      warnOnce(error)
      return
    }
    // Roll after the write, not before: the cap bounds file size, and a
    // record is never dropped or split to enforce it. The next record opens
    // the next file.
    if (fileBytes >= maxFileBytes) closeFile()
    // Reported after the write so the family's own record lands first, and
    // only for a family the default level writes: a DEBUG family is expected
    // to be voluminous when asked for.
    if (seen === highVolumeRecords && diagnosticTier(input.type) !== "debug") {
      reportHighVolume(input.type, seen)
    }
  }

  /** Marks every `.jsonl` file of `pid` in `logDir`, of every thread, as the
   *  log of a process that exited unexpectedly, so retention keeps it after
   *  ordinary files. The mark is a rename that keeps the launch timestamp,
   *  pid, and thread in front, so search order and the open-file rule read
   *  the file as before. Call it
   *  only once the process is gone. `openedBefore`, in epoch ms, limits the
   *  mark to files opened before it: the kernel can give a gone process's pid
   *  to a later process, whose files the gone one never wrote. Returns the
   *  marked file names, already marked ones included, so the caller's exit
   *  record can name them. A file that cannot be renamed keeps its ordinary
   *  name and is not returned. */
  export const markUnexpectedExit = (logDir: string, pid: number, openedBefore?: number): string[] => {
    let names: string[]
    try {
      names = readdirSync(logDir)
    } catch {
      return []
    }
    // A name starts with its launch timestamp, whose width is fixed, so the
    // names order as the launches do.
    const before = openedBefore === undefined ? undefined : launchStamp(new Date(openedBefore))
    const marked: string[] = []
    for (const file of names) {
      if (!file.endsWith(".jsonl") || logFileWriter(file)?.pid !== String(pid)) continue
      if (before !== undefined && file >= before) continue
      if (file.endsWith(UNEXPECTED_EXIT_SUFFIX)) {
        marked.push(file)
        continue
      }
      const target = `${file.slice(0, -".jsonl".length)}${UNEXPECTED_EXIT_SUFFIX}`
      try {
        renameSync(path.join(logDir, file), path.join(logDir, target))
        marked.push(target)
      } catch {
        // Another process's retention sweep can delete the file first.
      }
    }
    return marked.sort()
  }

  /** End the sink: its file closes at once, and the returned promise settles
   *  when every retention sweep it started has finished, so no sweep outlives
   *  it. Records have no destination until the next init or forward. */
  export const close = async (): Promise<void> => {
    detach()
    await sweeps.settled()
  }

  /** Drop the destination at once. A record can arrive while a re-init waits
   *  for the sweeps of the previous sink, and `Log` then opens its default
   *  sink, so every new destination detaches whatever is there first. */
  const detach = (): void => {
    forwardRecord = null
    logDirectory = null
    closeFile()
  }
}

/** The project debug-log directory for a project root. Reads and writes share
 *  this resolution so the search side always looks where `DebugLog.init` wrote. */
export function resolveDebugLogDirectory(baseDir: string): string {
  return path.join(baseDir, LOG_DIR)
}

/** The `.jsonl` files of one debug-log directory in chronological order.
 *  Filenames begin with the launch ISO timestamp, so lexicographic filename
 *  order is time order. A missing directory is a fresh workspace, not an
 *  error: it lists as empty. */
export function listDebugLogFiles(logDir: string): string[] {
  let names: string[]
  try {
    names = readdirSync(logDir)
  } catch {
    return []
  }
  return names.filter((name) => name.endsWith(".jsonl")).sort().map((name) => path.join(logDir, name))
}

/** Scan `.jsonl` debug-log files with the store's `EventScanFilter` so one
 *  filter type serves both search sources. Log records have no store position,
 *  so `afterPosition`, `positionRange`, and `order` do not apply here; records
 *  yield in file order. A malformed line is skipped, never fatal: the log file
 *  is an external boundary and salvage is skip.
 *  @yields {DebugLogRecord} matching records from each file in path order. */
export function* scanDebugLogFiles(
  filePaths: readonly string[],
  filter: EventScanFilter = {},
): Generator<DebugLogRecord> {
  for (const filePath of filePaths) {
    for (const line of readLogLines(filePath)) {
      const parsed = parseRecordLine(line)
      if (parsed && matchesFilter(parsed, filter)) yield parsed
    }
  }
}

function* readLogLines(filePath: string): Generator<string> {
  let fd: number
  try {
    fd = openSync(filePath, "r")
  } catch {
    // Retention can delete a listed file before it is opened.
    return
  }
  try {
    let remaining: number
    try {
      remaining = fstatSync(fd).size
    } catch {
      return
    }
    // Read the open file's initial extent, not an indefinitely growing sink.
    // Rotation creates a new path; this descriptor continues to own this file.
    const buffer = Buffer.allocUnsafe(64 * 1024)
    const decoder = new StringDecoder("utf8")
    let fragments: string[] = []
    while (remaining > 0) {
      let bytes: number
      try {
        bytes = readSync(fd, buffer, { offset: 0, length: Math.min(buffer.length, remaining), position: null })
      } catch {
        return
      }
      if (bytes === 0) break
      remaining -= bytes
      const text = decoder.write(buffer.subarray(0, bytes))
      let start = 0
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
        fragments.push(text.slice(start, end))
        yield fragments.join("")
        fragments = []
        start = end + 1
      }
      fragments.push(text.slice(start))
    }
    fragments.push(decoder.end())
    yield fragments.join("")
  } finally {
    closeSync(fd)
  }
}

interface JsonObjectFields {
  readonly [key: string]: unknown
}

function isJsonObject(value: unknown): value is JsonObjectFields {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseRecordLine(line: string): DebugLogRecord | null {
  if (line.trim() === "") return null
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return null
  }
  if (!isJsonObject(value)) return null
  const candidate = value
  if (typeof candidate.ts !== "number" || typeof candidate.type !== "string") return null
  const parsed: DebugLogRecord = { ts: candidate.ts, type: candidate.type }
  if (typeof candidate.sessionId === "string") parsed.sessionId = candidate.sessionId
  if (typeof candidate.version === "number" && Number.isInteger(candidate.version) && candidate.version > 0) parsed.version = candidate.version
  if (typeof candidate.actor === "string") parsed.actor = candidate.actor
  if (candidate.payload !== undefined) parsed.payload = candidate.payload
  return parsed
}

function matchesFilter(record: DebugLogRecord, filter: EventScanFilter): boolean {
  if (filter.sessionId && record.sessionId !== filter.sessionId) return false
  if (filter.actor && record.actor !== filter.actor) return false
  if (filter.types && filter.types.length > 0 && !filter.types.includes(record.type)) return false
  if (filter.sinceTimestamp !== undefined && record.ts < filter.sinceTimestamp) return false
  if (filter.untilTimestamp !== undefined && record.ts > filter.untilTimestamp) return false
  return true
}
