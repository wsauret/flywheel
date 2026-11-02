import { Schema } from "effect"
import { MutationDisplayFileEvidenceSchema, MutationEvidenceEntrySchema, MutationFileEvidenceSchema } from "../infra/mutation-evidence-schema.js"
import { SESSION_CONTENT_WINDOW_BYTES, SessionContentManifestReferenceSchema, SessionContentReferenceSchema } from "../infra/session-content-schema.js"

const Offset = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const WindowBytes = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(SESSION_CONTENT_WINDOW_BYTES))
const SessionId = Schema.NonEmptyString
const UnavailableReason = Schema.Literals(["missing", "corrupt"])
const Continuation = Schema.NullOr(Offset)
const strict = { parseOptions: { onExcessProperty: "error" as const } }

/** Read file descriptors by ordinal from one immutable manifest.
 * maxBytes bounds the complete encoded response; maxFiles bounds their count.
 * Display paths are derived by the service from the session's execution directory.
 * `previews` asks for each retained file's collapsed preview text in the page. */
export const MutationFilesQuerySchema = Schema.Struct({
  type: Schema.Literal("mutationFiles"),
  sessionId: SessionId,
  manifest: SessionContentManifestReferenceSchema,
  offset: Offset,
  maxFiles: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(128)),
  maxBytes: WindowBytes,
  previews: Schema.optionalKey(Schema.Boolean),
}).pipe(Schema.annotate(strict))
export type MutationFilesQuery = typeof MutationFilesQuerySchema.Type

/** maxBytes bounds the complete encoded response, not raw patch bytes.
 * Read exact patch bytes, not characters. The client must join adjacent byte
 * windows before UTF-8 decoding, then verify the reference's byte length and hash. */
export const MutationPatchWindowQuerySchema = Schema.Struct({
  type: Schema.Literal("mutationPatchWindow"),
  sessionId: SessionId,
  reference: SessionContentReferenceSchema,
  offset: Offset,
  maxBytes: WindowBytes,
}).pipe(Schema.annotate(strict))
export type MutationPatchWindowQuery = typeof MutationPatchWindowQuerySchema.Type

/** The encoded byte bound of one file preview. A page window holds the largest preview
 * beside its descriptor, so a page always carries at least one file. */
export const MUTATION_FILE_PREVIEW_BYTES = 16 * 1024
const encodedPreviewBytes = (preview: string): number => new TextEncoder().encode(JSON.stringify(preview)).byteLength
const Preview = Schema.String.check(Schema.makeFilter(preview =>
  encodedPreviewBytes(preview) <= MUTATION_FILE_PREVIEW_BYTES || "File preview exceeds its byte bound"))
const OmittedEntry = MutationEvidenceEntrySchema.members[2]
const NotAppliedEntry = MutationEvidenceEntrySchema.members[3]
const RemovedDirectoryEntry = MutationEvidenceEntrySchema.members[4]

/** A stored evidence entry as a files page serves it. The preview is derived at read time from
 * the stored patch: the patch from its first hunk, cut to the collapsed line budget. It is never
 * stored. Only a query that asks for previews receives them, and only for retained patches. */
const MutationFilesEntrySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("applied"), file: MutationFileEvidenceSchema, preview: Schema.optionalKey(Preview) }),
  Schema.Struct({ kind: Schema.Literal("display"), file: MutationDisplayFileEvidenceSchema, preview: Schema.optionalKey(Preview) }),
  OmittedEntry,
  NotAppliedEntry,
  RemovedDirectoryEntry,
])
export type MutationFilesEntry = typeof MutationFilesEntrySchema.Type

const Files = Schema.Array(MutationFilesEntrySchema).check(
  Schema.isMaxLength(128),
  Schema.makeFilter((files) => new TextEncoder().encode(JSON.stringify(files)).byteLength <= SESSION_CONTENT_WINDOW_BYTES || "File descriptors exceed the byte window"),
)

/** Immutable identity and requested coordinates survive an unavailable read.
 * An available page states the served ordinal and the first unserved ordinal.
 * totalBytes measures manifest records, not rendered patch bytes. */
export const MutationFilesResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"), sessionId: SessionId, manifest: SessionContentManifestReferenceSchema,
    requestedOffset: Offset, offset: Offset, totalFiles: Offset, totalBytes: Offset,
    files: Files, nextOffset: Continuation,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"), sessionId: SessionId, manifest: SessionContentManifestReferenceSchema,
    requestedOffset: Offset, reason: UnavailableReason,
  }),
]).pipe(Schema.annotate(strict))
export type MutationFilesResult = typeof MutationFilesResultSchema.Type

/** Full-content proof stays in reference; base64 carries only servedBytes.
 * A missing or corrupt root never appears as an empty successful window. */
export const MutationPatchWindowResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"), sessionId: SessionId, reference: SessionContentReferenceSchema,
    requestedOffset: Offset, offset: Offset, totalBytes: Offset,
    servedBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(SESSION_CONTENT_WINDOW_BYTES)),
    base64: Schema.String.check(Schema.isMaxLength(Math.ceil(SESSION_CONTENT_WINDOW_BYTES / 3) * 4), Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)),
    nextOffset: Continuation,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"), sessionId: SessionId, reference: SessionContentReferenceSchema,
    requestedOffset: Offset, reason: UnavailableReason,
  }),
]).pipe(Schema.annotate(strict))
export type MutationPatchWindowResult = typeof MutationPatchWindowResultSchema.Type
