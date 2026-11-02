import { Schema } from "effect"
import { diffLines } from "diff"
import { lstatSync } from "node:fs"
import { dirname, join } from "node:path"
import { FLYWHEEL_DIR_NAME } from "../../infra/directory-authorities.js"
import { canonicalMutationPath } from "../../infra/file-mutation-queue.js"
import { isReviewableSessionFile, pathInside } from "../../protocol/client/session-changes-copy.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { buildMutationDiff, mutationDiffLineCounts, type MutationDiffEndpoint } from "../../infra/mutation-diff.js"
import { buildSessionContent } from "../../infra/session-content.js"
import { SESSION_CONTENT_WINDOW_BYTES } from "../../infra/session-content-schema.js"
import { fitMutationEvidenceWindow } from "../../protocol/mutation-evidence-window.js"
import { SessionChangeDiffQuerySchema, SessionChangesQuerySchema, SessionChangesSetViewedSchema, type SessionChangeDiffQuery, type SessionChangeDiffResult, type SessionChangesQuery, type SessionChangesResult, type SessionChangesSetViewed, type SessionChangesSetViewedResult, type SessionChangesUndo, type SessionChangesUndoResult } from "../../protocol/session-changes-protocol-types.js"
import { RetainedFileEditAuthority } from "../file-edits/retained-file-edit-host.js"
import { reconstructOriginal } from "../file-edits/session-file-restoration.js"
import { undoSessionChanges } from "../file-edits/session-undo.js"
import type { SessionManager } from "../session/manager.js"
import { readRecordedExecutionCwd } from "../session/session-execution-directory.js"
import { getSessionChangeReview } from "../session/session-change-review.js"
import { filesAsWritten, isFileAsWritten } from "../session/session-file-changes.js"
import { createSessionFactWriter } from "../session/session-fact-writer.js"

function endpoint(text: string | undefined): MutationDiffEndpoint {
  return text === undefined ? { kind: "absent" } : { kind: "text", text }
}

/** Each removed path under a directory that no longer exists, mapped to the topmost such
 * directory below `projectRoot` and the number of removed paths under it. */
function removedFolders(removed: readonly string[], projectRoot: string): ReadonlyMap<string, { readonly path: string; readonly files: number }> {
  const exists = new Map<string, boolean>()
  const topmost = new Map<string, string>()
  for (const path of removed) {
    const ancestors: string[] = []
    for (let directory = dirname(path); pathInside(directory, projectRoot) !== undefined; directory = dirname(directory)) ancestors.unshift(directory)
    const folder = ancestors.find(directory => {
      let known = exists.get(directory)
      if (known === undefined) exists.set(directory, known = lstatSync(directory, { throwIfNoEntry: false }) !== undefined)
      return !known
    })
    if (folder !== undefined) topmost.set(path, folder)
  }
  const counts = new Map<string, number>()
  for (const folder of topmost.values()) counts.set(folder, (counts.get(folder) ?? 0) + 1)
  return new Map([...topmost].map(([path, folder]) => [path, { path: folder, files: counts.get(folder)! }])) // SAFETY: every folder was counted above.
}

/** Stateless operator API. Construction acquires no history, native authority, runner, or subscription. */
export function createSessionChangesService(deps: { readonly reader: AsyncEventStateReadSurface; readonly projectionReader?: AsyncEventStateReadSurface; readonly writer: AsyncEventWriter; readonly manager: Pick<SessionManager, "read">; readonly projectRoot: string }) {
  const projectionReader = deps.projectionReader ?? deps.reader
  async function requireSession(sessionId: string) {
    const session = await deps.manager.read(sessionId)
    if (!session) throw new Error("Session is unavailable")
    return session
  }
  return {
    async list(input: SessionChangesQuery): Promise<SessionChangesResult> {
      const query = Schema.decodeUnknownSync(SessionChangesQuerySchema, { onExcessProperty: "error" })(input)
      const session = await requireSession(query.sessionId)
      const offset = query.offset ?? 0
      if (offset > 0 && (query.cursor === undefined || query.revision === undefined)) throw new Error("Session changes continuation requires cursor and revision")
      const review = await getSessionChangeReview(projectionReader, query.sessionId)
      // SAFETY: netFiles() keeps only files whose netChange is defined.
      const netFiles = review.netFiles().filter(file => isReviewableSessionFile(file.path, canonicalMutationPath(join(deps.projectRoot, FLYWHEEL_DIR_NAME))))
      const admitted = filesAsWritten(netFiles, deps.projectRoot)
      const revision = review.revision()
      const fingerprint = new Bun.CryptoHasher("sha256").update(JSON.stringify([revision, admitted.map(file => [file.id, review.latestEditToken(file)])])).digest("hex")
      const stale = (query.cursor !== undefined && query.cursor !== fingerprint) || (query.revision !== undefined && query.revision !== revision)
      const folders = removedFolders(admitted.filter(file => review.netChange(file) === "removed").map(file => file.path), deps.projectRoot)
      const files = (stale ? [] : admitted.slice(offset, offset + (query.maxFiles ?? 128))).map(file => {
        const editToken = review.latestEditToken(file)
        if (!editToken) throw new Error(`Changed file ${file.id} has no mutation source`)
        // The sessions the review's session launched that changed the file, in the order of their first change.
        const writers = [...new Set(file.changes.map(change => change.sessionId))].filter(id => id !== query.sessionId)
        const folder = folders.get(file.path)
        // SAFETY: netFiles() keeps only files whose netChange is defined.
        return { fileId: file.id, path: file.path, change: review.netChange(file)!, editToken, review: { status: review.reviewStatus(file) },
          writers: writers.map(sessionId => ({ sessionId, title: review.title(sessionId) })), ...(folder ? { folder } : {}) }
      })
      return fitMutationEvidenceWindow({
        status: stale ? "stale" : "ready", cursor: fingerprint, offset,
        nextOffset: !stale && offset + files.length < admitted.length ? offset + files.length : null,
        totalFiles: admitted.length, revision, unknownFileMutationGaps: review.unknownFileMutationGaps(),
        executionCwd: await readRecordedExecutionCwd(session, deps.projectRoot, projectionReader),
        files, excludedFileCount: netFiles.length - admitted.length,
      }, query.maxBytes ?? SESSION_CONTENT_WINDOW_BYTES, value => Buffer.byteLength(JSON.stringify(value)))
    },
    /** Reconstruct one original against one admitted snapshot. Stage its retained
     * display patch in session content without adding mutation or Undo authority. */
    async diff(input: SessionChangeDiffQuery): Promise<SessionChangeDiffResult> {
      const query = Schema.decodeUnknownSync(SessionChangeDiffQuerySchema, { onExcessProperty: "error" })(input)
      const { sessionId } = query
      await requireSession(sessionId)
      const review = await getSessionChangeReview(projectionReader, sessionId)
      const revision = review.revision()
      const file = review.file(query.fileId)
      if (revision !== query.revision || !file || !isReviewableSessionFile(file.path, canonicalMutationPath(join(deps.projectRoot, FLYWHEEL_DIR_NAME)))) return { status: "stale" }
      if (review.unknownFileMutationGaps() > 0) return { status: "unavailable", revision, reason: "unretained" }
      const authority = RetainedFileEditAuthority.admitWritable(file.path)
      try {
        const reconstruction = await reconstructOriginal(projectionReader, review, file, authority)
        if (reconstruction.kind === "unavailable") return { status: "unavailable", revision, reason: reconstruction.reason }
        const lineCounts = { added: 0, removed: 0 }
        for (const part of diffLines(reconstruction.original ?? "", authority.text ?? "")) {
          if (part.added) lineCounts.added += part.count
          if (part.removed) lineCounts.removed += part.count
        }
        const retained = buildMutationDiff([{ path: file.path, before: endpoint(reconstruction.original), after: endpoint(authority.text) }])
        const change = reconstruction.original === undefined ? "added" : authority.text === undefined ? "removed" : "modified"
        const target = retained.files[0]
        const omission = retained.omissions[0]
        const counts = mutationDiffLineCounts(target?.unifiedDiff ?? "")
        const omittedLines = target?.omittedLines ?? 0
        let patch: Extract<SessionChangeDiffResult, { status: "ready" }>["diff"]["patch"]
        if (target) {
          const stage = deps.writer.stageSessionContentNodes
          if (!stage) throw new Error("Session content staging is unavailable")
          patch = { kind: "retained", reference: await buildSessionContent(target.unifiedDiff, nodes => stage.call(deps.writer, sessionId, nodes)) }
        } else if (omission) patch = { kind: "omitted", reason: omission.reason }
        else return { status: "stale" }
        return {
          status: "ready", revision, lineCounts,
          diff: { path: file.path, change: target?.change ?? change, patch, retainedLines: counts.rendered, renderedLines: counts.rendered + omittedLines, omittedLines },
        }
      } finally { authority.close() }
    },
    async undo(request: SessionChangesUndo, signal: AbortSignal): Promise<SessionChangesUndoResult> {
      const executionCwd = await readRecordedExecutionCwd(await requireSession(request.sessionId), deps.projectRoot, projectionReader)
      return undoSessionChanges({ reader: deps.reader, projectionReader, writer: deps.writer, sessionId: request.sessionId, projectRoot: deps.projectRoot, executionCwd }, request, signal)
    },
    async setViewed(input: SessionChangesSetViewed): Promise<SessionChangesSetViewedResult> {
      const request = Schema.decodeUnknownSync(SessionChangesSetViewedSchema, { onExcessProperty: "error" })(input)
      await requireSession(request.sessionId)
      const writer = createSessionFactWriter({ sessionId: request.sessionId, writer: deps.writer })
      try {
        const expectedSeq = await projectionReader.aggregateSeq(`session:${request.sessionId}`) + 1
        const review = await getSessionChangeReview(projectionReader, request.sessionId)
        const file = review.file(request.fileId)
        const latest = file && isFileAsWritten(file, deps.projectRoot) ? review.latestEditToken(file) : undefined
        if (!latest || latest.position !== request.editToken.position || latest.eventId !== request.editToken.eventId) {
          return { status: "refused", message: "File changed; refresh and try again" }
        }
        const result = await writer.recordGuarded({
          type: "file.reviewed",
          version: 1,
          actor: "flywheel",
          payload: { fileId: request.fileId, editToken: request.editToken, reviewed: request.reviewed },
        }, expectedSeq)
        return result?.kind === "stored"
          ? { status: "completed" }
          : { status: "refused", message: "File changed; refresh and try again" }
      } finally {
        writer.dispose()
      }
    },
  }
}
export type SessionChangesService = ReturnType<typeof createSessionChangesService>
