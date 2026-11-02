import { Schema } from "effect"
import { defineFact } from "../../infra/event-registry.js"
import { MutationDiffSchema } from "../../infra/mutation-diff.js"
import { MutationFileEvidenceSchema } from "../../infra/mutation-evidence-schema.js"
import { FileAccessProofSchema } from "./file-mutation-access.js"

const Sha256Schema = Schema.String.check(Schema.isLengthBetween(64, 64))
const ContentPolicySchema = Schema.Struct({
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Sha256Schema,
  preview: Schema.String,
})

const NonNegativeIntegerSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const LineStatsSchema = Schema.Struct({
  added: NonNegativeIntegerSchema,
  modified: NonNegativeIntegerSchema,
  removed: NonNegativeIntegerSchema,
})

const MutationIdSchema = Schema.NonEmptyString
const FileChangeKindSchema = Schema.Union([Schema.Literal("created"), Schema.Literal("modified"), Schema.Literal("deleted")])
const FileMutationOriginSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("tool_call"),
    toolUseId: Schema.NonEmptyString,
    modelRequestId: Schema.optionalKey(Schema.String),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("user_undo"),
    reviewRevision: NonNegativeIntegerSchema,
    // Historical: Undo once carried a session/last-turn scope. Current writers omit it.
    scope: Schema.optionalKey(Schema.Literals(["session", "lastTurn"])),
    fileId: Schema.NonEmptyString,
    sourceMutationIds: Schema.Array(MutationIdSchema),
  }),
])
export type FileMutationOrigin = typeof FileMutationOriginSchema.Type
const FileMutationContentSchema = Schema.Struct({
  mutationId: MutationIdSchema,
  path: Schema.String,
  displayPath: Schema.String,
  changeKind: FileChangeKindSchema,
  before: Schema.NullOr(ContentPolicySchema),
  after: Schema.NullOr(ContentPolicySchema),
  diff: Schema.optionalKey(ContentPolicySchema),
  lineStats: Schema.optionalKey(LineStatsSchema),
})
const FileMutationEvidenceSchema = Schema.Struct({
  ...FileMutationContentSchema.fields,
  toolUseId: Schema.String,
  modelRequestId: Schema.optionalKey(Schema.String),
  parentToolUseId: Schema.optionalKey(Schema.String),
})

const FileChangedFactSchema = defineFact({
  type: "file.changed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    path: Schema.String,
    displayPath: Schema.String,
    changeKind: FileChangeKindSchema,
    before: Schema.NullOr(ContentPolicySchema),
    after: Schema.NullOr(ContentPolicySchema),
    diff: Schema.optionalKey(ContentPolicySchema),
    lineStats: Schema.optionalKey(LineStatsSchema),
    toolUseId: Schema.optionalKey(Schema.String),
    modelRequestId: Schema.optionalKey(Schema.String),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }),
})

const FileChangedCurrentFactSchema = defineFact({
  type: "file.changed",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: FileMutationEvidenceSchema,
})

const FileMutationOriginEvidenceSchema = Schema.Struct({
  ...FileMutationContentSchema.fields,
  operationId: Schema.NonEmptyString,
  origin: FileMutationOriginSchema,
})

const FileChangedOriginFactSchema = defineFact({
  type: "file.changed",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: FileMutationOriginEvidenceSchema,
})

const FileChangedAccessFactSchema = defineFact({
  type: "file.changed",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    ...FileMutationOriginEvidenceSchema.fields,
    beforeAccess: Schema.NullOr(FileAccessProofSchema),
    afterAccess: Schema.NullOr(FileAccessProofSchema),
  }).check(Schema.makeFilter(value =>
    ((value.before === null) === (value.beforeAccess === null) && (value.after === null) === (value.afterAccess === null))
    || "File access evidence must match endpoint presence",
  )),
})

const FileReviewedFactSchema = defineFact({
  type: "file.reviewed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    fileId: Schema.NonEmptyString.check(Schema.isPattern(/^file:.+/)),
    editToken: Schema.Struct({
      position: NonNegativeIntegerSchema,
      eventId: Schema.NonEmptyString,
    }),
    reviewed: Schema.Boolean,
  }),
})

const FileArtifactRecordedFactSchema = defineFact({
  type: "file.artifact.recorded",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    artifactId: Schema.String,
    ownerKind: Schema.Literal("tool_call"),
    ownerId: Schema.String,
    artifactKind: Schema.Literal("file_snapshot"),
    path: Schema.String,
    bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    sha256: Sha256Schema,
    preview: Schema.String,
    metadata: Schema.Struct({
      changeKind: FileChangeKindSchema,
      displayPath: Schema.String,
    }),
  }),
})

const FileArtifactRecordedCurrentFactSchema = defineFact({
  type: "file.artifact.recorded",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    mutationId: MutationIdSchema,
    artifactId: Schema.String,
    ownerKind: Schema.Literal("tool_call"),
    ownerId: Schema.String,
    artifactKind: Schema.Literal("file_snapshot"),
    path: Schema.String,
    bytes: NonNegativeIntegerSchema,
    sha256: Sha256Schema,
    preview: Schema.String,
    metadata: Schema.Struct({
      changeKind: FileChangeKindSchema,
      displayPath: Schema.String,
    }),
  }),
})

const FileMutationPreparedFactSchema = defineFact({
  type: "file.mutation.prepared",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: FileMutationEvidenceSchema,
})

const FileMutationPreparedOriginFactSchema = defineFact({
  type: "file.mutation.prepared",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: FileMutationOriginEvidenceSchema,
})

const FileMutationDiffArtifactFactSchema = defineFact({
  type: "file.artifact.recorded",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    mutationId: MutationIdSchema,
    artifactId: Schema.NonEmptyString,
    ownerKind: Schema.Literal("runtime"),
    ownerId: Schema.NonEmptyString,
    artifactKind: Schema.Literal("mutation_diff"),
    path: Schema.String,
    mutation: MutationDiffSchema,
  }),
})

const FileMutationReferenceArtifactFactSchema = defineFact({
  type: "file.artifact.recorded",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    mutationId: MutationIdSchema,
    artifactId: Schema.NonEmptyString,
    ownerKind: Schema.Literals(["runtime", "tool_call"]),
    ownerId: Schema.NonEmptyString,
    artifactKind: Schema.Literal("mutation_diff"),
    path: Schema.String,
    evidence: MutationFileEvidenceSchema,
  }).check(Schema.makeFilter(value =>
    (value.mutationId === value.evidence.mutationId && value.path === value.evidence.path) || "File artifact evidence identity mismatch",
  )),
})

const FileMutationSettledFactSchema = defineFact({
  type: "file.mutation.settled",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    mutationId: MutationIdSchema,
    outcome: Schema.Union([
      Schema.Literal("applied"),
      Schema.Literal("not_applied"),
      Schema.Literal("indeterminate"),
      Schema.Literal("attributed_after_later_mutation"),
    ]),
  }),
})

const FileMutationRecoveryWarnedFactSchema = defineFact({
  type: "file.mutation.recovery_warned",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    mutationId: MutationIdSchema,
    cellSha256: Sha256Schema,
  }),
})

export const FileMutationFactSchemas = [
  FileChangedFactSchema,
  FileChangedCurrentFactSchema,
  FileChangedOriginFactSchema,
  FileChangedAccessFactSchema,
  FileReviewedFactSchema,
  FileArtifactRecordedFactSchema,
  FileArtifactRecordedCurrentFactSchema,
  FileMutationDiffArtifactFactSchema,
  FileMutationReferenceArtifactFactSchema,
  FileMutationPreparedFactSchema,
  FileMutationPreparedOriginFactSchema,
  FileMutationSettledFactSchema,
  FileMutationRecoveryWarnedFactSchema,
] as const

const FileMutationFactSchema = Schema.Union(FileMutationFactSchemas)

export type FileMutationFact = typeof FileMutationFactSchema.Type

export function parseFileMutationFact(value: unknown): FileMutationFact {
  return Schema.decodeUnknownSync(FileMutationFactSchema, { onExcessProperty: "error" })(value)
}
