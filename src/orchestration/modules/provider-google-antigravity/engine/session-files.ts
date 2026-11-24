import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { antigravityHomeLayout } from "../../../../infra/antigravity-engine.js"
import { writeFileAtomic } from "../../../../infra/atomic-write.js"
import { errnoCode } from "../../../../infra/error-message.js"
import { Log } from "../../../../infra/log.js"
import { decodeHolderFields, processHolders, type ProcessHolder } from "../../../../infra/process-holder.js"

// Each engine session leaves files in the login's home: its conversation database, its brain folder (transcripts,
// scratch), and its annotations (agy 1.5.14). They belong to the engine process that opened the session (plan P15),
// and its owner removes them once that process has exited. An owner that crashed cannot, so every launch on the login
// sweeps, under the login's launch lock, the files that no live owner can still use. The owner records what it opened
// in a process record, so the sweep never needs to read a file of a session.

const log = Log.create({ service: "provider-google-antigravity" })

/** An engine session id: agy names each session by a UUID, and no file of the home that is shared by every session
 *  (`builtin/`, `conversation_summaries.db`, the settings, the token) has such a name. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const CONVERSATION_FILE = /^(.+)\.db(?:-wal|-shm)?$/u
const ANNOTATION_FILE = /^(.+)\.pbtxt$/u

function sessionFolders(loginDir: string) {
  const data = join(antigravityHomeLayout(loginDir).geminiHome, "antigravity-cli")
  return { conversations: join(data, "conversations"), brain: join(data, "brain"), annotations: join(data, "annotations") }
}

function recordsFolder(loginDir: string): string {
  return join(loginDir, "processes")
}

/** The transcript in which agy records each step of the session `sessionId`, one JSON line per step. */
export function sessionTranscriptPath(loginDir: string, sessionId: string): string {
  return join(sessionFolders(loginDir).brain, sessionId, ".system_generated", "logs", "transcript_full.jsonl")
}

/** The conversation database in which agy records the model requests of the session `sessionId`. */
export function sessionConversationPath(loginDir: string, sessionId: string): string {
  return join(sessionFolders(loginDir).conversations, `${sessionId}.db`)
}

/** The owner's record of one engine process: the engine sessions it opened, and how many `session/new` requests it
 *  sent that have not answered yet, whose sessions can already have files under an id that the record cannot name. */
export interface ProcessRecord {
  readonly processId: string
  readonly sessions: readonly string[]
  readonly pendingOpens: number
  /** Counts one `session/new` that is about to be sent. Writes the record before it returns. */
  beginOpen(): void
  /** Ends one counted `session/new`, and records the session it opened, when it opened one. */
  endOpen(sessionId: string | undefined): void
  /** Removes the files of every recorded session and then the record. Call it once the engine process has exited. */
  remove(): void
}

/**
 * Writes the record of the engine process `processId` on the login directory `loginDir`, owned by this process, and
 * returns its handle. The record names this process with its holder identity, so a sweep can prove an owner gone.
 * Every change rewrites the whole record atomically (0600), so a reader never sees a partial one.
 */
export function createProcessRecord(loginDir: string, processId: string): ProcessRecord {
  const path = join(recordsFolder(loginDir), `${processId}.json`)
  const sessions: string[] = []
  let pendingOpens = 0
  const write = () => {
    writeFileAtomic(path, `${JSON.stringify({ pid: process.pid, ...processHolders.own(), pendingOpens, sessions })}\n`, { mode: 0o600 })
  }
  mkdirSync(recordsFolder(loginDir), { recursive: true, mode: 0o700 })
  write()
  return {
    processId,
    get sessions() { return sessions },
    get pendingOpens() { return pendingOpens },
    beginOpen() {
      pendingOpens += 1
      write()
    },
    endOpen(sessionId) {
      pendingOpens -= 1
      if (sessionId !== undefined) sessions.push(sessionId)
      write()
    },
    remove() {
      removeSessionFiles(loginDir, sessions)
      rmSync(path, { force: true })
    },
  }
}

/** A record as a sweep reads it. A record that does not decode names no session the sweep may remove, and its owner
 *  counts as live, because nothing proves it gone. */
type ReadRecord =
  | { readonly kind: "record"; readonly name: string; readonly holder: ProcessHolder; readonly pendingOpens: number; readonly sessions: readonly string[] }
  | { readonly kind: "unknown"; readonly name: string }

function readRecord(folder: string, name: string): ReadRecord | undefined {
  let text: string
  try {
    text = readFileSync(join(folder, name), "utf8")
  } catch (error) {
    // A record that its owner removed since the listing.
    if (errnoCode(error) === "ENOENT") return undefined
    return { kind: "unknown", name }
  }
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value === "object" && value !== null && "pid" in value && "pendingOpens" in value && "sessions" in value) {
      const { pid, pendingOpens, sessions } = value
      if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 && typeof pendingOpens === "number" && Array.isArray(sessions) && sessions.every((id) => typeof id === "string")) {
        const fields = new Map<string, unknown>(Object.entries(value))
        const holder = decodeHolderFields(pid, { v: fields.get("v"), start: fields.get("start"), boot: fields.get("boot") })
        return { kind: "record", name, holder, pendingOpens, sessions }
      }
    }
  } catch {
    // Not JSON: an unknown shape, below.
  }
  return { kind: "unknown", name }
}

/** What one sweep of a login did. `in-use`: a live owner that is not this process serves the login (`otherOwners` of
 *  them, also each record of an unknown shape), so the sweep changed nothing. `swept`: what it removed, and whether a
 *  live owner of this process was opening a session, so files that no record names stayed (`deferred`). */
export type LoginSweep =
  | { readonly kind: "in-use"; readonly otherOwners: number }
  | { readonly kind: "swept"; readonly removedRecords: number; readonly removedSessions: number; readonly deferred: boolean }

/**
 * Sweeps the login directory `loginDir`. The caller holds the login's launch lock, so no owner starts an engine or
 * writes a new record meanwhile, but a live owner can still open sessions. When a live owner that is not this process
 * serves the login, or a record has a shape this code does not know, the sweep changes nothing and answers `in-use`.
 * Otherwise each record whose owner is proven gone is removed with the files of its sessions, and then, when no live
 * owner has a `session/new` open, the files of every session that no live record names: an owner that ended between
 * sending `session/new` and its answer left them. The session files are listed before the records are read, and an
 * owner counts a `session/new` in its record before it sends it, so a session that a live owner opens meanwhile is
 * either not listed or counted. The sweep never touches the login's auth state, its shared engine files, or its
 * login-stable files. Records one INFO line when it removed anything, and one WARN line for a record of an unknown
 * shape.
 */
export function sweepLogin(loginDir: string): LoginSweep {
  const listed = [...sessionIdsOnDisk(loginDir)]
  const folder = recordsFolder(loginDir)
  const records = entries(folder).filter((name) => name.endsWith(".json")).map((name) => readRecord(folder, name)).filter((record) => record !== undefined)
  const live: Extract<ReadRecord, { readonly kind: "record" }>[] = []
  const gone: Extract<ReadRecord, { readonly kind: "record" }>[] = []
  let otherOwners = 0
  for (const record of records) {
    if (record.kind === "unknown") {
      log.warn("Google Antigravity engine process record of an unknown shape kept", { record: record.name })
      otherOwners += 1
    } else if (processHolders.state(record.holder).kind === "gone") {
      gone.push(record)
    } else {
      live.push(record)
      if (record.holder.pid !== process.pid) otherOwners += 1
    }
  }
  if (otherOwners > 0) return { kind: "in-use", otherOwners }
  let removedSessions = 0
  for (const record of gone) {
    removedSessions += removeSessionFiles(loginDir, record.sessions)
    rmSync(join(folder, record.name), { force: true })
  }
  const deferred = live.some((record) => record.pendingOpens > 0)
  if (!deferred) {
    const owned = new Set(live.flatMap((record) => record.sessions))
    removedSessions += removeSessionFiles(loginDir, listed.filter((id) => !owned.has(id)))
  }
  if (gone.length + removedSessions > 0) log.info("Google Antigravity login swept", { removedRecords: gone.length, removedSessions, deferred })
  return { kind: "swept", removedRecords: gone.length, removedSessions, deferred }
}

/** Removes the files of each session of `sessionIds` and answers how many sessions had any. */
function removeSessionFiles(loginDir: string, sessionIds: readonly string[]): number {
  if (sessionIds.length === 0) return 0
  const folders = sessionFolders(loginDir)
  const wanted = new Set(sessionIds.filter((id) => SESSION_ID.test(id)))
  const removed = new Set<string>()
  const remove = (path: string, id: string) => {
    rmSync(path, { recursive: true, force: true })
    removed.add(id)
  }
  for (const name of entries(folders.conversations)) {
    const id = CONVERSATION_FILE.exec(name)?.[1]
    if (id !== undefined && wanted.has(id)) remove(join(folders.conversations, name), id)
  }
  for (const name of entries(folders.annotations)) {
    const id = ANNOTATION_FILE.exec(name)?.[1]
    if (id !== undefined && wanted.has(id)) remove(join(folders.annotations, name), id)
  }
  for (const id of entries(folders.brain)) if (wanted.has(id)) remove(join(folders.brain, id), id)
  return removed.size
}

/** The id of every session that has a file in the login's home. */
function sessionIdsOnDisk(loginDir: string): Set<string> {
  const folders = sessionFolders(loginDir)
  const ids = [
    ...entries(folders.conversations).map((name) => CONVERSATION_FILE.exec(name)?.[1]),
    ...entries(folders.annotations).map((name) => ANNOTATION_FILE.exec(name)?.[1]),
    ...entries(folders.brain),
  ]
  return new Set(ids.filter((id): id is string => id !== undefined && SESSION_ID.test(id)))
}

/** The names in `folder`, or none when it does not exist yet. */
function entries(folder: string): string[] {
  try {
    return readdirSync(folder)
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return []
    throw error
  }
}
