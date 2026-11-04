import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { FLYWHEEL_DIR_NAME } from "../../infra/directory-authorities.js"
import { CorruptEventRowError, type AsyncEventStateReadSurface, type StoredFact } from "../../infra/event-store-types.js"
import { canonicalMutationPath } from "../../infra/file-mutation-queue.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import { heldProjection } from "../../infra/projection-registry.js"
import type { SessionFileChangeCounts } from "../../protocol/session-changes-protocol-types.js"
import { isReviewableSessionFile } from "../../protocol/client/session-changes-copy.js"
import type { FileMutationFact } from "./file-mutation-facts.js"
import { readChangeFact } from "./session-change-sources.js"
import { createSubtreeFold } from "./session-subtree.js"

export interface FileEditToken {
  readonly position: number
  readonly eventId: string
}
export interface Endpoint { readonly bytes: number; readonly sha256: string }
export interface Change {
  /** The session that recorded the change: the reviewed session or one it launched. */
  readonly sessionId: string
  readonly source: FileEditToken
  readonly mutationId?: string
  readonly toolUseId?: string
  /** The container call of a nested tool call, which is the call its conversation records. */
  readonly parentToolUseId?: string
  readonly displayPath: string
  readonly before: Endpoint | null
  readonly after: Endpoint | null
}
export interface FileRow {
  id: string
  readonly path: string
  readonly changes: Change[]
}
export type NetChange = "added" | "modified" | "removed"

function sourceOf(event: StoredFact | CorruptEventRowError): FileEditToken {
  return Object.freeze({ position: event.position, eventId: event instanceof CorruptEventRowError ? event.eventId : event.id })
}
function endpointOf(value: Endpoint | null): Endpoint | null {
  return value === null ? null : Object.freeze({ bytes: value.bytes, sha256: value.sha256 })
}
function sameEndpoint(left: Endpoint | null, right: Endpoint | null): boolean {
  if (left === null || right === null) return left === right
  return left.bytes === right.bytes && left.sha256 === right.sha256
}

/** Whether bytes are exactly one recorded endpoint; a null endpoint means no file. */
export function matchesEndpoint(bytes: Uint8Array | undefined, endpoint: Endpoint | null): boolean {
  if (endpoint === null) return bytes === undefined
  return bytes !== undefined && bytes.byteLength === endpoint.bytes && createHash("sha256").update(bytes).digest("hex") === endpoint.sha256
}

/** Whether the file on disk is still this session's last recorded write. The size is
 * compared before any bytes are read, so a file that grew or shrank costs one stat. */
export function isFileAsWritten(file: FileRow, projectRoot: string): boolean {
  if (!isReviewableSessionFile(file.path, canonicalMutationPath(join(projectRoot, FLYWHEEL_DIR_NAME)))) return false
  const after = file.changes[file.changes.length - 1]?.after ?? null
  const stat = statSync(file.path, { throwIfNoEntry: false })
  if (after === null || stat === undefined) return after === null && stat === undefined
  return stat.isFile() && stat.size === after.bytes && matchesEndpoint(readFileSync(file.path), after)
}

/** The files this session's history still describes: net-changed files whose bytes on
 * disk are the session's last write, excluding Flywheel-owned project state. A file
 * something else edited since is neither shown nor counted, because its diff would
 * no longer be this session's work. */
export function filesAsWritten(files: readonly FileRow[], projectRoot: string): readonly FileRow[] {
  return files.filter(file => isFileAsWritten(file, projectRoot))
}

/** The prompt-bar count and the list share this membership, so they always agree. */
export function sessionChangeCounts(lane: Pick<FileLane, "netFiles" | "gaps">, projectRoot: string): SessionFileChangeCounts {
  return { fileCount: filesAsWritten(lane.netFiles(), projectRoot).length, unknownFileMutationGaps: lane.gaps.size }
}

/** The file's first recorded `before` against its last recorded `after`.
 * Undefined means the session left no net change, including after an Undo. */
export function netChange(file: FileRow): NetChange | undefined {
  const first = file.changes[0]
  const last = file.changes.at(-1)
  if (!first || !last || sameEndpoint(first.before, last.after)) return undefined
  return first.before === null ? "added" : last.after === null ? "removed" : "modified"
}

/** The exact latest mutation event for stale-safe review writes. */
export function latestFileEditToken(file: FileRow): FileEditToken | undefined {
  return file.changes.at(-1)?.source
}

/** The changed files of one session subtree, in memory. A fold feeds it each
 * `file.changed` row once, in any order across sessions: each file keeps its
 * changes in workspace position order, which orders the facts of every
 * session, so the edits of a launched session interleave with its parent's. */
export function createFileLane() {
  const byPath = new Map<string, FileRow>()
  const byFileId = new Map<string, FileRow>()
  const files: FileRow[] = []
  const gaps = new Map<number, FileEditToken & { readonly sessionId: string }>()
  const consumed = new Set<number>()
  let revision = 0
  let net: { revision: number; files: readonly FileRow[] } | undefined

  function addChange(event: StoredFact, fact: Extract<FileMutationFact, { type: "file.changed" }>): void {
    const payload = fact.payload
    const origin = "origin" in payload ? payload.origin : undefined
    const toolUseId = origin?.kind === "tool_call" ? origin.toolUseId : "toolUseId" in payload ? payload.toolUseId : undefined
    const parentToolUseId = origin?.kind === "tool_call" ? origin.parentToolUseId : "parentToolUseId" in payload ? payload.parentToolUseId : undefined
    const change: Change = Object.freeze({
      sessionId: event.sessionId, source: sourceOf(event), displayPath: payload.displayPath,
      before: endpointOf(payload.before), after: endpointOf(payload.after),
      ...("mutationId" in payload ? { mutationId: payload.mutationId } : {}),
      ...(toolUseId !== undefined ? { toolUseId } : {}),
      ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
    })
    let file = byPath.get(payload.path)
    if (!file) {
      file = { id: `file:${event.id}`, path: payload.path, changes: [] }
      byPath.set(file.path, file)
      byFileId.set(file.id, file)
      files.push(file)
    }
    let index = file.changes.length
    while ((file.changes[index - 1]?.source.position ?? 0) > event.position) index--
    file.changes.splice(index, 0, change)
    // The file's identity is its first change, so a fold from scratch names
    // it as an incremental one did.
    if (index === 0 && file.changes.length > 1) {
      byFileId.delete(file.id)
      file.id = `file:${event.id}`
      byFileId.set(file.id, file)
    }
  }

  /** Folds one row once; a row seen again, as a retried read delivers it, changes nothing. */
  function consume(event: StoredFact | CorruptEventRowError): void {
    if (consumed.has(event.position)) return
    consumed.add(event.position)
    if (event instanceof CorruptEventRowError) {
      gaps.set(event.position, { ...sourceOf(event), sessionId: event.sessionId })
    } else {
      let fact: ReturnType<typeof readChangeFact> | undefined
      try { fact = readChangeFact(event) } catch { gaps.set(event.position, { ...sourceOf(event), sessionId: event.sessionId }) }
      if (fact?.type === "file.changed") addChange(event, fact)
    }
    revision++
  }

  /** Files with a net change in path order, computed once per revision. */
  function netFiles(): readonly FileRow[] {
    if (net?.revision !== revision) {
      net = { revision, files: Object.freeze(files.filter(file => netChange(file) !== undefined).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) }
    }
    return net.files
  }
  return Object.freeze({
    files, gaps, consume, netFiles,
    file: (fileId: string) => byFileId.get(fileId),
    revision: () => revision,
  })
}
export type FileLane = ReturnType<typeof createFileLane>

/** Fold only the file facts of this session and every session it launched,
 * in bounded chunks. No diff, content, or filesystem read is acquired. Store
 * failures propagate. */
export function getSessionFileChanges(reader: AsyncEventStateReadSurface, sessionId: string): Promise<FileLane> {
  return heldProjection(reader, `session-file-changes:${sessionId}`, () => {
    const lane = createFileLane()
    const fold = createSubtreeFold(reader, sessionId, { types: ["file.changed"], content: "deferred", consume: ({ fact }) => lane.consume(fact) })
    const lanes = createOrderedLane()
    return { read: () => lanes.run(async () => { await fold.advance(); return lane }) }
  }).read()
}
