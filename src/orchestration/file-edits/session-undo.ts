import { Schema } from "effect"
import { join } from "node:path"
import { FLYWHEEL_DIR_NAME } from "../../infra/directory-authorities.js"
import { isReviewableSessionFile } from "../../protocol/client/session-changes-copy.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { canonicalMutationPath, withMutationQueueKeys } from "../../infra/file-mutation-queue.js"
import { redactSecrets } from "../../infra/redact-secrets.js"
import { sanitizeExternalText } from "../../infra/control-characters.js"
import { SessionChangesUndoSchema, type SessionChangesUndo, type SessionChangesUndoResult } from "../../protocol/session-changes-protocol-types.js"
import { fileAccessProof } from "../session/file-mutation-access.js"
import { loadSessionPendingFileMutations } from "../session/file-mutation-recovery.js"
import type { PreparedFileMutation } from "../session/file-mutation-fact-writers.js"
import { getSessionChangeReview } from "../session/session-change-review.js"
import type { FileRow } from "../session/session-file-changes.js"
import { createSessionFactWriter } from "../session/session-fact-writer.js"
import { FileEditRefusal, publishFileEdits, type FileEditAuthority } from "./file-edit-operation.js"
import { RetainedFileEditAuthority } from "./retained-file-edit-host.js"
import { accessMetadata, reconstructOriginal, sameAccess, type Reconstruction } from "./session-file-restoration.js"

/** The session is proven to exist by the service boundary that builds this context. */
interface SessionUndoContext {
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly sessionId: string
  readonly projectRoot: string
  readonly executionCwd: string
  readonly admit?: (path: string) => FileEditAuthority
}

const UNAVAILABLE_MESSAGE = {
  drifted: "Changed outside this session since its last recorded write; Undo unavailable",
  unretained: "Diff not retained; Undo unavailable",
} satisfies { readonly [Reason in Extract<Reconstruction, { kind: "unavailable" }>["reason"]]: string }

function safeError(error: unknown): string {
  return redactSecrets(sanitizeExternalText(error instanceof Error ? error.message : String(error))).slice(0, 1024)
}
function requireProof(condition: unknown, message: string): asserts condition {
  if (!condition) throw new FileEditRefusal(message)
}
/** Refuses while a pending operation of a session whose recorded changes the
 * Undo reverses still overlaps the file: its recovery would write again
 * after the Undo. The prepared operation is the Undo's own. */
async function checkPending(context: SessionUndoContext, file: FileRow, prepared?: PreparedFileMutation): Promise<void> {
  const writers = [...new Set([context.sessionId, ...file.changes.map(change => change.sessionId)])]
  // One person's Undo reads the few sessions that wrote this one file.
  const all = await Promise.all(writers.map(async sessionId => ({ sessionId, pending: await loadSessionPendingFileMutations(context.projectionReader, sessionId) })))
  const key = canonicalMutationPath(file.path)
  for (const { sessionId, pending } of all) {
    requireProof(pending.unreadableCells.length === 0, "Unreadable pending file mutations prevent Undo")
    const own = prepared && sessionId === context.sessionId ? pending.operations.find(operation => operation.key === prepared.operationId) : undefined
    if (prepared && sessionId === context.sessionId) {
      const expected = prepared.state.header
      requireProof(expected && expected.operationId === prepared.operationId && prepared.state.items[expected.cursor]?.evidence.mutationId === prepared.mutationId, "Prepared operation identity is unavailable")
      requireProof(own && own.cell.operationId === prepared.operationId && own.raw === JSON.stringify(prepared.state.header), "The prepared operation is missing or changed")
    }
    for (const operation of pending.operations) {
      if (operation === own) continue
      for (const item of operation.cell.items.slice(operation.cell.cursor)) {
        requireProof(canonicalMutationPath(item.evidence.path) !== key, "A pending file mutation overlaps this file")
      }
    }
    const ownIds = new Set(own?.cell.items.map(item => item.evidence.mutationId))
    for (const fact of pending.pending) {
      if (own && "operationId" in fact.payload && fact.payload.operationId === own.cell.operationId && ownIds.has(fact.payload.mutationId)) continue
      requireProof(canonicalMutationPath(fact.payload.path) !== key, "A pending file mutation overlaps this file")
    }
  }
}
/** Re-reads the review and proves the request still names the same file at the same revision. */
async function currentFile(context: SessionUndoContext, request: SessionChangesUndo): Promise<FileRow> {
  const review = await getSessionChangeReview(context.projectionReader, context.sessionId)
  const file = review.file(request.fileId)
  requireProof(file, "Unknown or foreign file ID")
  requireProof(isReviewableSessionFile(file.path, canonicalMutationPath(join(context.projectRoot, FLYWHEEL_DIR_NAME))), "Unknown or foreign file ID")
  requireProof(review.revision() === request.revision, "Changes have moved on; refresh and try again")
  requireProof(review.unknownFileMutationGaps() === 0, "Unknown file-mutation gaps prevent Undo")
  return file
}
async function reconstruct(context: SessionUndoContext, file: FileRow, authority: FileEditAuthority) {
  const review = await getSessionChangeReview(context.projectionReader, context.sessionId)
  const reconstruction = await reconstructOriginal(context.projectionReader, review, file, authority)
  if (reconstruction.kind === "unavailable") throw new FileEditRefusal(UNAVAILABLE_MESSAGE[reconstruction.reason])
  const { kind: _kind, ...fingerprint } = reconstruction
  return { ...reconstruction, fingerprint: JSON.stringify(fingerprint) }
}

/** The publisher outcome fields the user-facing result reads. */
export type UndoPublicationOutcome =
  | { readonly status: "completed" }
  | { readonly status: "uncertain"; readonly error: unknown }
  | { readonly status: "not_applied"; readonly reason: "cancelled" | "preflight" | "publication"; readonly error?: unknown; readonly retirementError?: unknown }

/** One publisher outcome becomes one user-facing result. `not_applied` wrote nothing. */
export function undoResultOf(outcome: UndoPublicationOutcome): SessionChangesUndoResult {
  if (outcome.status === "completed") return { status: "completed" }
  if (outcome.status === "uncertain") return { status: "uncertain", message: safeError(outcome.error) }
  if (outcome.reason === "cancelled") return { status: "refused", message: "Undo was cancelled before it wrote" }
  const message = outcome.error === undefined ? "Undo did not apply" : safeError(outcome.error)
  return { status: "refused", message: outcome.retirementError === undefined ? message : `${message}; retirement failed: ${safeError(outcome.retirementError)}` }
}

/** Restores one file to its bytes before the session or a session it launched
 * first touched it. The restoring write belongs to the reviewing session. Every proof runs before admission,
 * then again under the mutation queue after durable preparation, so a refusal
 * wrote nothing. An uncertain outcome may have written; it is reported as
 * unproven with the publisher's message and is never retried here. */
export async function undoSessionChanges(context: SessionUndoContext, input: SessionChangesUndo, signal: AbortSignal): Promise<SessionChangesUndoResult> {
  let untransferred: FileEditAuthority | undefined
  let writer: ReturnType<typeof createSessionFactWriter> | undefined
  try {
    const request = Schema.decodeUnknownSync(SessionChangesUndoSchema, { onExcessProperty: "error" })(input)
    const file = await currentFile(context, request)
    await checkPending(context, file)
    signal.throwIfAborted()
    const authority = (context.admit ?? RetainedFileEditAuthority.admitWritable)(file.path)
    untransferred = authority
    const { original, originalAccess, sourceMutationIds, fingerprint } = await reconstruct(context, file, authority)
    const recheck = async (prepared?: PreparedFileMutation) => {
      signal.throwIfAborted()
      const fresh = await currentFile(context, request)
      requireProof(fresh.path === file.path, "Changes have moved on; refresh and try again")
      requireProof((await reconstruct(context, fresh, authority)).fingerprint === fingerprint, "Retained evidence has changed")
      await checkPending(context, fresh, prepared)
      authority.verifyPrecondition()
    }
    const currentAccess = authority.snapshot ? fileAccessProof(authority.snapshot.metadata) : null
    if (original === authority.text && sameAccess(originalAccess, currentAccess)) {
      return await withMutationQueueKeys([file.path], async () => {
        await recheck()
        return { status: "completed" }
      })
    }
    const origin = { kind: "user_undo", reviewRevision: request.revision, fileId: file.id, sourceMutationIds } as const
    writer = createSessionFactWriter({ writer: context.writer, sessionId: request.sessionId })
    const outcome = await publishFileEdits({ executionCwd: context.executionCwd, signal, sessionEventWriter: writer, origin }, {
      paths: [file.path],
      admit(path) {
        requireProof(untransferred && path === file.path, "Missing retained authority")
        untransferred = undefined
        return authority
      },
      plan: () => [{ admitted: { path: file.path, resolvedPath: file.path, authority }, after: original, metadata: accessMetadata(originalAccess), origin }],
      withQueues: (_keys, run) => withMutationQueueKeys([file.path], run),
      preflight: async publications => {
        const prepared = publications[0]?.mutation
        requireProof(prepared && publications.length === 1, "Prepared operation identity is unavailable")
        await recheck(prepared)
      },
    })
    return undoResultOf(outcome)
  } catch (error) {
    return { status: "refused", message: safeError(error) }
  } finally {
    untransferred?.close()
    writer?.dispose()
  }
}
