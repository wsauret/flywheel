import { Schema } from "effect"
import { SessionContentManifestReferenceSchema, SessionContentReferenceSchema } from "./session-content-schema.js"

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const Hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/))
const EndpointIdentity = Schema.NullOr(Schema.Struct({ bytes: Count, sha256: Hash }))
const Change = Schema.Literals(["added", "modified", "removed"])
export const MutationFileEvidenceSchema = Schema.Struct({
  version: Schema.Literal(1), mutationId: Schema.NonEmptyString, path: Schema.String, displayPath: Schema.String,
  change: Change, before: EndpointIdentity, after: EndpointIdentity,
  retainedLines: Count, renderedLines: Count, omittedLines: Count, addedLines: Count, removedLines: Count,
  patch: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("retained"), reference: SessionContentReferenceSchema }),
    Schema.Struct({ kind: Schema.Literal("omitted"), reason: Schema.Literals(["sensitive", "target_over_bound", "collection_over_budget", "private_reach"]) }),
    Schema.Struct({ kind: Schema.Literal("unavailable") }),
  ]),
  conflictMarkers: Schema.Boolean,
  action: Schema.optionalKey(Schema.String), reach: Schema.optionalKey(Schema.String), name: Schema.optionalKey(Schema.String),
})
/** Display patches have no endpoint identities and do not authorize Undo. */
export const MutationDisplayFileEvidenceSchema = Schema.Struct({
  ...MutationFileEvidenceSchema.fields, before: Schema.optionalKey(Schema.Never), after: Schema.optionalKey(Schema.Never),
})
const OmissionReason = Schema.Literals(["sensitive", "target_over_bound", "collection_over_budget", "private_reach"])
export const MutationEvidenceEntrySchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("applied"), file: MutationFileEvidenceSchema }),
  Schema.Struct({ kind: Schema.Literal("display"), file: MutationDisplayFileEvidenceSchema }),
  Schema.Struct({
    kind: Schema.Literal("omitted"), path: Schema.String, displayPath: Schema.String, reason: OmissionReason,
    name: Schema.optionalKey(Schema.String), action: Schema.optionalKey(Schema.String), reach: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("not_applied"), path: Schema.String, reason: Schema.String }),
  /** A directory that existed before the command and is absent after it, topmost only, with the number
   *  and total bytes of the files it held. It precedes the file entries it holds, which keep their own entries. */
  Schema.Struct({ kind: Schema.Literal("removed_directory"), path: Schema.String, displayPath: Schema.String, files: Count, bytes: Count }),
])
export const MutationEvidenceSampleSchema = Schema.Struct({
  kind: Schema.Literals(["applied", "omitted", "not_applied", "removed_directory"]), path: Schema.String,
  reason: Schema.optionalKey(Schema.String), conflictMarkers: Schema.optionalKey(Schema.Boolean),
  files: Schema.optionalKey(Count), bytes: Schema.optionalKey(Count),
})
export const MUTATION_EVIDENCE_SUMMARY_BYTES = 4096
export const MutationEvidenceSchema = Schema.Struct({
  version: Schema.Literal(2), manifest: SessionContentManifestReferenceSchema,
  applied: Count, retainedFiles: Count, omissions: Count, unknownChanges: Schema.optionalKey(Count), notApplied: Count,
  added: Count, modified: Count, removed: Count, addedLines: Count, removedLines: Count, conflictMarkers: Count,
  /** Removed directory entries, and the file entries they hold; both absent when the command removed no directory. */
  removedDirectories: Schema.optionalKey(Count), filesInRemovedDirectories: Schema.optionalKey(Count),
  samples: Schema.Array(MutationEvidenceSampleSchema).check(Schema.isMaxLength(3)),
}).check(Schema.makeFilter(value =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength <= MUTATION_EVIDENCE_SUMMARY_BYTES || "Mutation evidence summary exceeds its encoded limit",
))
