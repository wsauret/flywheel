import { Schema } from "effect"

export type RecallScope = "lineage" | "all"

export const RECALL_PAGE_SIZE = 5
export const RECALL_EXPAND_MAX = 5
export const RECALL_READ_DEFAULT_LIMIT = 2_000
export const RECALL_READ_MAX_LIMIT = 8_000

export type RecallEntryReference = number | string

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))
const RecallEntryReferenceSchema = Schema.Union([NonNegativeInteger, Schema.NonEmptyString])
const RecallExpandSchema = Schema.Array(RecallEntryReferenceSchema).check(
  Schema.isMaxLength(RECALL_EXPAND_MAX),
)

export interface RecallHit {
  index: number
  entryId: string
  role: string
  summary?: string
  snippet?: string
  text?: string
  offset?: number
  totalLength?: number
  nextOffset?: number
  files?: readonly string[]
}

export interface RecallInput {
  scope: RecallScope
  query?: string
  expand?: readonly RecallEntryReference[]
  offset?: number
  limit?: number
  page?: number
}

export interface RecallResult {
  hits: readonly RecallHit[]
  totalMatches?: number
  invalidExpand?: readonly RecallEntryReference[]
}

export const RecallInputSchema: Schema.Codec<RecallInput> = Schema.Struct({
  scope: Schema.Literals(["lineage", "all"]),
  query: Schema.optionalKey(Schema.String),
  expand: Schema.optionalKey(RecallExpandSchema),
  offset: Schema.optionalKey(NonNegativeInteger),
  limit: Schema.optionalKey(PositiveInteger.check(Schema.isLessThanOrEqualTo(RECALL_READ_MAX_LIMIT))),
  page: Schema.optionalKey(PositiveInteger),
}).pipe(Schema.annotate({ parseOptions: { onExcessProperty: "error" } }))

const RecallHitSchema: Schema.Codec<RecallHit> = Schema.Struct({
  index: NonNegativeInteger,
  entryId: Schema.NonEmptyString,
  role: Schema.NonEmptyString,
  summary: Schema.optionalKey(Schema.String),
  snippet: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  offset: Schema.optionalKey(NonNegativeInteger),
  totalLength: Schema.optionalKey(NonNegativeInteger),
  nextOffset: Schema.optionalKey(NonNegativeInteger),
  files: Schema.optionalKey(Schema.Array(Schema.String)),
}).pipe(Schema.annotate({ parseOptions: { onExcessProperty: "error" } }))

export const RecallResultSchema: Schema.Codec<RecallResult> = Schema.Struct({
  hits: Schema.Array(RecallHitSchema),
  totalMatches: Schema.optionalKey(NonNegativeInteger),
  invalidExpand: Schema.optionalKey(Schema.Array(RecallEntryReferenceSchema)),
}).pipe(Schema.annotate({ parseOptions: { onExcessProperty: "error" } }))

export type RecallPort = (input: RecallInput) => Promise<RecallResult>
