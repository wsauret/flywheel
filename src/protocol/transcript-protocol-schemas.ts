import { Schema } from "effect"
import { MutationEvidenceSchema } from "../infra/mutation-evidence-schema.js"
import { AgentFailureDisplaySchema, ContainerKindSchema, DegradedBlockSchema, DiffOmissionSchema, MessageSenderSchema, ProvisionalDiffSchema, ToolPresentationSchema, ToolStreamingTextSchema, UserMessageImageSchema, WorkflowCardSchema } from "../infra/output-blocks.js"
import { ToolActionSchema } from "../infra/workflow-types.js"
import { ToolResultActionSchema } from "../infra/tool-result-action.js"
import type {
  HydratedOutputBlockBody,
  HydratedOutputGroupChildrenBatch,
  HydratedOutputGroupChildren,
  HydratedOutputRange,
  OutputBlockBodyRequest,
  OutputGroupChildrenRequest,
  OutputRangeRequest,
  TranscriptSearchRequest,
  TranscriptSearchResult,
  ProjectFilesRequest,
  ProjectFilesResult,
} from "./transcript-protocol-types.js"

// Every exported schema is pinned to its in-process type with a Codec
// annotation (the lockstep pattern runtime-protocol-schemas.ts documents), so
// a shape that drifts between the pair is a type error here at the source.

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))



const RuntimeTranscriptWindowSchema = Schema.Struct({
  startBlockIndex: Schema.NullOr(NonNegativeInt),
  endBlockIndex: Schema.NullOr(NonNegativeInt),
  hasBefore: Schema.Boolean,
  hasAfter: Schema.Boolean,
  contentBytes: NonNegativeInt,
})

const TranscriptUnavailableSchema = Schema.Struct({
  title: Schema.String,
  message: Schema.String,
  diagnostic: Schema.String,
})



const OutputRangeAnchorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("tail") }),
  Schema.Struct({ kind: Schema.Literal("beforeBlock"), blockId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("afterBlock"), blockId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("around"), entryId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("residentSpan"), blockIds: Schema.Array(Schema.String).check(Schema.isNonEmpty()), candidates: Schema.Array(Schema.String).check(Schema.isMaxLength(8)) }),
])

export const OutputRangeRequestSchema: Schema.Codec<OutputRangeRequest> = Schema.Struct({
  anchor: OutputRangeAnchorSchema,
  maxBlocks: PositiveInt,
  maxBytes: PositiveInt,
  includeThinkingContent: Schema.optionalKey(Schema.Boolean),
})

const ToolEntryBaseSchema = Schema.Struct({
  kind: Schema.Literal("tool"),
  id: Schema.String,
  name: Schema.String,
  presentation: ToolPresentationSchema,
  sentence: Schema.optionalKey(ToolPresentationSchema),
  action: Schema.optionalKey(ToolActionSchema),
  timestamp: Schema.Number,
  runCategoryOverride: Schema.optionalKey(Schema.Literal("execute")),
  invocationBody: Schema.optionalKey(Schema.Struct({ content: Schema.String, filetype: Schema.String, presentation: Schema.optionalKey(Schema.Literal("disclosure")) })),
  linkUri: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  filetype: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  resultAction: Schema.optionalKey(ToolResultActionSchema),
  fileChangeKind: Schema.optionalKey(Schema.Literals(["create", "replace", "patch"])),
  declaresMutation: Schema.optionalKey(Schema.Literal(true)),
  proposedDiff: Schema.optionalKey(ProvisionalDiffSchema),
  mutationEvidence: Schema.optionalKey(MutationEvidenceSchema),
  background: Schema.optionalKey(Schema.Boolean),
  endedAt: Schema.optionalKey(Schema.Number),
  diffOmission: Schema.optionalKey(DiffOmissionSchema),
  invocationBodyOmittedBytes: Schema.optionalKey(Schema.Number),
  contentOmittedLines: Schema.optionalKey(Schema.Number),
})
const ToolEntrySchema = Schema.Union([
  ToolEntryBaseSchema.pipe(Schema.fieldsAssign({ status: Schema.Union([Schema.Literal("pending"), Schema.Literal("streaming"), Schema.Literal("completed"), Schema.Literal("interrupted")]) })),
  ToolEntryBaseSchema.pipe(Schema.fieldsAssign({ status: Schema.Literal("error"), errorMessage: Schema.String })),
  ToolEntryBaseSchema.pipe(Schema.fieldsAssign({ status: Schema.Literal("blocked"), statusMessage: Schema.String })),
])

const QuestionChoiceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("option"), choiceId: Schema.optionalKey(Schema.String), label: Schema.String, description: Schema.optionalKey(Schema.String), recommended: Schema.optionalKey(Schema.Boolean), requiresText: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ kind: Schema.Literal("freeform"), label: Schema.String, placeholder: Schema.optionalKey(Schema.String) }),
])
const QuestionEntrySchema = Schema.Struct({ question: Schema.String, header: Schema.optionalKey(Schema.String), choices: Schema.mutable(Schema.Array(QuestionChoiceSchema)), multiSelect: Schema.Boolean })
export const QuestionBlockSchema = Schema.Struct({
  kind: Schema.Literal("question"),
  toolUseId: Schema.String,
  sentence: Schema.optionalKey(ToolPresentationSchema),
  questions: Schema.mutable(Schema.Array(QuestionEntrySchema)),
  answers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  cancelled: Schema.optionalKey(Schema.Boolean),
  timestamp: Schema.Number,
})

/** Shared wire rows for live patches and historical ranges. Image bytes travel only in body reads. */
export const FrontendOutputBlockSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("text"), id: Schema.String, content: Schema.String, timestamp: Schema.Number }),
  ToolEntrySchema,
  Schema.Struct({
    kind: Schema.Literal("agentGroup"), containerKind: ContainerKindSchema, id: Schema.String,
    label: Schema.String, description: Schema.String, agentType: Schema.optionalKey(Schema.String),
    status: Schema.Union([Schema.Literal("pending"), Schema.Literal("queued"), Schema.Literal("active"), Schema.Literal("completed"), Schema.Literal("partial"), Schema.Literal("cancelled"), Schema.Literal("stopped"), Schema.Literal("interrupted")]),
    activity: Schema.optionalKey(ToolPresentationSchema), summary: Schema.optionalKey(Schema.String),
    children: Schema.mutable(Schema.Array(ToolEntrySchema)), totalToolCount: NonNegativeInt,
    // Optional, because a version-23 runtime never sent the open episode: a
    // client then reads a stopped clock and shows the settled active time.
    latestChild: Schema.optionalKey(Schema.String), duration: Schema.optionalKey(Schema.Number), activeStartedAt: Schema.optionalKey(Schema.Number), totalTokens: Schema.optionalKey(Schema.Number),
    timestamp: Schema.Number, model: Schema.optionalKey(Schema.String),
    linkUri: Schema.optionalKey(Schema.String), toolUseId: Schema.String, card: Schema.optionalKey(WorkflowCardSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("agentGroup"), containerKind: ContainerKindSchema, id: Schema.String,
    label: Schema.String, description: Schema.String, agentType: Schema.optionalKey(Schema.String),
    status: Schema.Literal("paused"), pausedBy: Schema.Literals(["person", "agent", "runtime"]),
    activity: Schema.optionalKey(ToolPresentationSchema), summary: Schema.optionalKey(Schema.String),
    children: Schema.mutable(Schema.Array(ToolEntrySchema)), totalToolCount: NonNegativeInt,
    latestChild: Schema.optionalKey(Schema.String), duration: Schema.optionalKey(Schema.Number), totalTokens: Schema.optionalKey(Schema.Number),
    timestamp: Schema.Number, model: Schema.optionalKey(Schema.String),
    linkUri: Schema.optionalKey(Schema.String), toolUseId: Schema.String, card: Schema.optionalKey(WorkflowCardSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("agentGroup"), containerKind: ContainerKindSchema, id: Schema.String,
    label: Schema.String, description: Schema.String, agentType: Schema.optionalKey(Schema.String),
    status: Schema.Literal("error"), failure: AgentFailureDisplaySchema,
    activity: Schema.optionalKey(ToolPresentationSchema), summary: Schema.optionalKey(Schema.String),
    children: Schema.mutable(Schema.Array(ToolEntrySchema)), totalToolCount: NonNegativeInt,
    latestChild: Schema.optionalKey(Schema.String), duration: Schema.optionalKey(Schema.Number), totalTokens: Schema.optionalKey(Schema.Number),
    timestamp: Schema.Number, model: Schema.optionalKey(Schema.String),
    linkUri: Schema.optionalKey(Schema.String), toolUseId: Schema.String, card: Schema.optionalKey(WorkflowCardSchema),
  }),
  Schema.Struct({
    kind: Schema.Literal("system"),
    id: Schema.String,
    message: Schema.String,
    level: Schema.optionalKey(Schema.Union([Schema.Literal("info"), Schema.Literal("error")])),
    mutationEvidence: Schema.optionalKey(MutationEvidenceSchema),
    diffOmission: Schema.optionalKey(DiffOmissionSchema),
    timestamp: Schema.Number,
  }),
  Schema.Struct({ kind: Schema.Literal("thinking"), id: Schema.String, content: Schema.String, status: Schema.Union([Schema.Literal("streaming"), Schema.Literal("completed")]), timestamp: Schema.Number, completedAt: Schema.optionalKey(Schema.Number) }),
  Schema.Struct({ kind: Schema.Literal("divider"), id: Schema.String, label: Schema.String, timestamp: Schema.Number }),
  Schema.Struct({ kind: Schema.Literal("userMessage"), id: Schema.String, content: Schema.String, timestamp: Schema.Number, pending: Schema.Boolean, injected: Schema.Boolean, submissionIds: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)), imageCount: Schema.optionalKey(PositiveInt), from: Schema.optionalKey(MessageSenderSchema) }),
  QuestionBlockSchema,
  DegradedBlockSchema,
])

export const HydratedOutputRangeSchema: Schema.Codec<HydratedOutputRange> = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ok"),
    consistencyToken: Schema.String,
    anchor: OutputRangeAnchorSchema,
    window: RuntimeTranscriptWindowSchema,
    blocks: Schema.Array(FrontendOutputBlockSchema),
    streamingToolText: Schema.Record(Schema.String, ToolStreamingTextSchema),
    streamingOutputChars: Schema.Number,
    membership: Schema.optionalKey(Schema.Array(Schema.Struct({ blockId: Schema.String, index: Schema.Union([NonNegativeInt, Schema.Null]) }))),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    consistencyToken: Schema.Null,
    anchor: OutputRangeAnchorSchema,
    window: RuntimeTranscriptWindowSchema,
    unavailable: TranscriptUnavailableSchema,
  }),
])

const OutputGroupChildrenCursorSchema = Schema.Struct({
  groupBlockId: Schema.String,
  childIndex: NonNegativeInt,
})

export const OutputGroupChildrenRequestSchema: Schema.Codec<OutputGroupChildrenRequest> = Schema.Struct({
  groupBlockIds: Schema.Array(Schema.String).check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
  maxBytes: PositiveInt,
  cursor: Schema.optionalKey(OutputGroupChildrenCursorSchema),
})

export const HydratedOutputGroupChildrenSchema: Schema.Codec<HydratedOutputGroupChildren> = Schema.Struct({
  groupBlockId: Schema.String,
  totalChildren: NonNegativeInt,
  contentBytes: NonNegativeInt,
  children: Schema.Array(ToolEntrySchema),
})

export const HydratedOutputGroupChildrenBatchSchema: Schema.Codec<HydratedOutputGroupChildrenBatch> = Schema.Struct({
  groups: Schema.Array(HydratedOutputGroupChildrenSchema),
  contentBytes: NonNegativeInt,
  nextCursor: Schema.optionalKey(OutputGroupChildrenCursorSchema),
})

export const OutputBlockBodyRequestSchema: Schema.Codec<OutputBlockBodyRequest> = Schema.Struct({
  blockId: Schema.String,
})

export const HydratedOutputBlockBodySchema: Schema.Codec<HydratedOutputBlockBody> = Schema.Struct({
  blockId: Schema.String,
  missing: Schema.optionalKey(Schema.Literal(true)),
  invocationBody: Schema.optionalKey(Schema.Struct({ content: Schema.String, filetype: Schema.String, presentation: Schema.optionalKey(Schema.Literal("disclosure")) })),
  diff: Schema.optionalKey(Schema.String),
  content: Schema.optionalKey(Schema.String),
  filetype: Schema.optionalKey(Schema.String),
  mutationEvidence: Schema.optionalKey(MutationEvidenceSchema),
  proposedDiff: Schema.optionalKey(ProvisionalDiffSchema),
  images: Schema.optionalKey(Schema.Array(UserMessageImageSchema)),
})

export const TranscriptSearchRequestSchema: Schema.Codec<TranscriptSearchRequest> = Schema.Struct({
  query: Schema.String,
  sessionId: Schema.optional(Schema.String),
  page: PositiveInt,
})

export const TranscriptSearchResultSchema: Schema.Codec<TranscriptSearchResult> = Schema.Struct({
  hits: Schema.Array(Schema.Struct({
    sessionId: Schema.String,
    sessionTitle: Schema.optional(Schema.String),
    entryId: Schema.String,
    role: Schema.Literals(["user", "assistant", "tool", "summary"]),
    snippet: Schema.String,
  })),
  total: Schema.Number,
  page: Schema.Number,
  pageSize: Schema.Number,
})

export const ProjectFilesRequestSchema: Schema.Codec<ProjectFilesRequest> = Schema.Struct({ query: Schema.String, limit: PositiveInt })

export const ProjectFilesResultSchema: Schema.Codec<ProjectFilesResult> = Schema.Struct({
  entries: Schema.Array(Schema.Struct({ path: Schema.String, directory: Schema.Boolean })),
  total: Schema.Number,
})
