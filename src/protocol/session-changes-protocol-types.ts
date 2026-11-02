import { Schema } from "effect"
import { MutationFileEvidenceSchema } from "../infra/mutation-evidence-schema.js"
import { SESSION_CONTENT_WINDOW_BYTES } from "../infra/session-content-schema.js"
import type { RuntimePosition, RuntimeSessionCursorIdentity } from "./runtime-ui-protocol-types.js"

const Index = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const SessionChangeSummaryQuerySchema = Schema.Struct({ type: Schema.Literal("sessionChangeSummary"), sessionId: Schema.NonEmptyString })
export type SessionChangeSummaryQuery = typeof SessionChangeSummaryQuerySchema.Type
export const SessionFileChangeCountsSchema = Schema.Struct({ fileCount: Index, unknownFileMutationGaps: Index })
export type SessionFileChangeCounts = typeof SessionFileChangeCountsSchema.Type
export interface SessionChangeSummaryResult extends SessionFileChangeCounts {
  readonly snapshotPosition: RuntimePosition
}
export const SessionChangeSummaryResultSchema: Schema.Codec<SessionChangeSummaryResult> = SessionFileChangeCountsSchema.pipe(Schema.fieldsAssign({ snapshotPosition: Schema.Number }))
export interface ChangesPatchPayload { readonly kind: "changes.changed" }
export function changesCursor(sessionId: string): RuntimeSessionCursorIdentity {
  return { scope: "session", domain: "changes", sessionId }
}

const FileId = Schema.NonEmptyString.check(Schema.isPattern(/^file:.+/))
const ErrorText = Schema.String.check(Schema.isMaxLength(1024))
/** The review projection's monotonic counter; it bumps on every folded file change or gap. */
const Revision = Index
const FileEditTokenSchema = Schema.Struct({ position: Index, eventId: Schema.NonEmptyString })
export type FileEditToken = typeof FileEditTokenSchema.Type
const SessionChangeReviewSchema = Schema.Struct({ status: Schema.Literals(["viewed", "unviewed", "unknown"]) })

const Cursor = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
export const SessionChangesQuerySchema = Schema.Struct({
  type: Schema.Literal("sessionChanges"), sessionId: Schema.NonEmptyString,
  offset: Index, cursor: Schema.optionalKey(Cursor), revision: Schema.optionalKey(Revision),
  maxFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(128)),
  maxBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(SESSION_CONTENT_WINDOW_BYTES)),
})
export type SessionChangesQuery = typeof SessionChangesQuerySchema.Type
const SessionChangeFileSchema = Schema.Struct({
  fileId: FileId,
  path: Schema.String,
  change: Schema.Literals(["added", "modified", "removed"]),
  editToken: FileEditTokenSchema,
  review: SessionChangeReviewSchema,
  /** The sessions that the reviewed session launched, at any depth, whose
   *  recorded changes make up this file's diff, each with the title its
   *  catalog row shows, in the order of their first change. The reviewed
   *  session's own changes name no writer. */
  writers: Schema.Array(Schema.Struct({ sessionId: Schema.NonEmptyString, title: Schema.String })),
  /** For a removed file under a directory that no longer exists: the topmost such directory, and
   *  the number of listed files under it across every page. Derived when the list is read. */
  folder: Schema.optionalKey(Schema.Struct({ path: Schema.String, files: Index })),
})
export type SessionChangeFile = typeof SessionChangeFileSchema.Type
/** A bounded path-ordered page. Continuations must repeat cursor and revision.
 * A stale response contains no files and must replace, never extend, the client's snapshot. */
export const SessionChangesResultSchema = Schema.Struct({
  status: Schema.Literals(["ready", "stale"]),
  cursor: Cursor, offset: Index, nextOffset: Schema.NullOr(Index), totalFiles: Index,
  revision: Revision, unknownFileMutationGaps: Index, executionCwd: Schema.String, files: Schema.Array(SessionChangeFileSchema).check(Schema.isMaxLength(128)),
  /** Project files that no longer match their last recorded write. */
  excludedFileCount: Index,
})
export type SessionChangesResult = typeof SessionChangesResultSchema.Type

export const SessionChangeDiffQuerySchema = Schema.Struct({ type: Schema.Literal("sessionChangeDiff"), sessionId: Schema.NonEmptyString, fileId: FileId, revision: Revision })
export type SessionChangeDiffQuery = typeof SessionChangeDiffQuerySchema.Type
/** Derived display evidence has no mutation identity and grants no Undo authority. */
const SessionChangeDiffDescriptorSchema = Schema.Struct({
  path: Schema.String, change: MutationFileEvidenceSchema.fields.change,
  retainedLines: Index, renderedLines: Index, omittedLines: Index,
  patch: MutationFileEvidenceSchema.fields.patch,
})
/** `ready` references one retained net patch, never the current file or an inline patch. */
export const SessionChangeDiffResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), revision: Revision, diff: SessionChangeDiffDescriptorSchema, lineCounts: Schema.Struct({ added: Index, removed: Index }) }),
  Schema.Struct({ status: Schema.Literal("unavailable"), revision: Revision, reason: Schema.Literals(["drifted", "unretained"]) }),
  Schema.Struct({ status: Schema.Literal("stale") }),
])
export type SessionChangeDiffResult = typeof SessionChangeDiffResultSchema.Type

export const SessionChangesUndoSchema = Schema.Struct({ type: Schema.Literal("session.changes.undo"), sessionId: Schema.NonEmptyString, fileId: FileId, revision: Revision })
export type SessionChangesUndo = typeof SessionChangesUndoSchema.Type
/** `refused` wrote nothing; `uncertain` started publication without proving settlement. */
export const SessionChangesUndoResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed") }),
  Schema.Struct({ status: Schema.Literal("refused"), message: ErrorText }),
  Schema.Struct({ status: Schema.Literal("uncertain"), message: ErrorText }),
])
export type SessionChangesUndoResult = typeof SessionChangesUndoResultSchema.Type

export const SessionChangesSetViewedSchema = Schema.Struct({
  type: Schema.Literal("session.changes.set_viewed"),
  sessionId: Schema.NonEmptyString,
  fileId: FileId,
  editToken: FileEditTokenSchema,
  reviewed: Schema.Boolean,
})
export type SessionChangesSetViewed = typeof SessionChangesSetViewedSchema.Type
export const SessionChangesSetViewedResultSchema = Schema.Union([
  Schema.Struct({ status: Schema.Literal("completed") }),
  Schema.Struct({ status: Schema.Literal("refused"), message: ErrorText }),
])
export type SessionChangesSetViewedResult = typeof SessionChangesSetViewedResultSchema.Type
