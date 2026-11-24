import { Schema } from "effect";
import { LlmToolOutputPartSchema } from "../../infra/llm/tool-output-part-schema.js";
import { MutationEvidenceResultDetailsSchema } from "../../infra/runtime-mutation-evidence.js";
import { TOOL_OUTCOME_VALUES } from "../../infra/tool-outcome.js";

/** Inline mutation evidence written before 2026-10-16 is normalized at the family recovery boundary. Remove this conversion after 2027-04-16. */
export const UnversionedFinalizedToolResultCheckpointSchema = Schema.Struct({
  conversationId: Schema.String,
  toolUseId: Schema.String,
  toolName: Schema.String,
  budgetExempt: Schema.Boolean,
  /** The batch bound in force when the result was finalized. Every current write sets it. */
  turnBudgetChars: Schema.optionalKey(Schema.Number),
  /** Cells written before 2026-10-27 record the context window instead, and
   *  recovery derives the fixed-share bound from it. Remove after 2027-04-27. */
  contextWindowTokens: Schema.optionalKey(Schema.Number),
  registrationOrdinal: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  content: Schema.mutable(Schema.Array(LlmToolOutputPartSchema)).check(Schema.isNonEmpty()),
  outcome: Schema.Literals(TOOL_OUTCOME_VALUES),
  details: Schema.optionalKey(Schema.Unknown),
  modelRequestId: Schema.optionalKey(Schema.String),
  parentToolUseId: Schema.optionalKey(Schema.String),
  contentTruncated: Schema.optionalKey(Schema.Boolean),
  originalContentBytes: Schema.optionalKey(Schema.Number),
  originalContentSha256: Schema.optionalKey(Schema.String),
  fullContentPath: Schema.optionalKey(Schema.String),
  semanticOutputTruncated: Schema.optionalKey(Schema.Boolean),
  byteOutputTruncated: Schema.optionalKey(Schema.Boolean),
  executionOutputTail: Schema.optionalKey(Schema.String),
});

// Field order is the encoded key order of every current write, so the
// bare-key shape is derived by omission rather than by reordering fields.
const { conversationId: _conversationId, toolName: _toolName, budgetExempt: _budgetExempt, turnBudgetChars: _turnBudgetChars, contextWindowTokens: _contextWindowTokens, registrationOrdinal: _registrationOrdinal, ...bareKeyFields } = UnversionedFinalizedToolResultCheckpointSchema.fields;
const BareKeyFinalizedToolResultCheckpointSchema = Schema.Struct(bareKeyFields);

export const FinalizedToolResultCheckpointSchema = Schema.Struct({
  ...UnversionedFinalizedToolResultCheckpointSchema.fields,
  version: Schema.Literal(2),
  details: Schema.optionalKey(MutationEvidenceResultDetailsSchema),
});

export type FinalizedToolResultCheckpoint = typeof FinalizedToolResultCheckpointSchema.Type;
/** A current or supported historical checkpoint. */
export type RecoverableCheckpoint = FinalizedToolResultCheckpoint | typeof UnversionedFinalizedToolResultCheckpointSchema.Type;

/** Reads the pre-conversation checkpoint shape without inventing missing metadata. */
export const decodeLegacyFinalizedToolResultCheckpoint = Schema.decodeUnknownSync(BareKeyFinalizedToolResultCheckpointSchema, { onExcessProperty: "error" });
