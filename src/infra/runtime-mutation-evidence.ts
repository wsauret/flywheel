import { Schema } from "effect";
import { MutationEvidenceSchema } from "./mutation-evidence-schema.js";
import { TOOL_OUTCOME_VALUES } from "./tool-outcome.js";
import type { ToolContentReference } from "./tool-content.js";

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Per-fact byte cap for persisted nested result content, enforced at the writer gate. */
export const MAX_NESTED_RESULT_CONTENT_BYTES = 50 * 1024;

/** Validate nested result content without hydrating referenced text.
 * Top-level facts carry evidence only; full nested content must fit the byte cap. */
export function nestedContentWithinCap(content: string | ToolContentReference | undefined, parentToolUseId: string | undefined): true | string {
  if (content === undefined) return true;
  if (parentToolUseId === undefined) return "full result content is nested-only; top-level facts stay evidence-only";
  const bytes = typeof content === "string" ? Buffer.byteLength(content, "utf-8") : content.bytes;
  return bytes <= MAX_NESTED_RESULT_CONTENT_BYTES
    || `nested result content exceeds the ${MAX_NESTED_RESULT_CONTENT_BYTES}-byte cap`;
}

/** Inline mutation evidence written before 2026-10-16 is normalized at the family recovery boundary. Remove this conversion after 2027-04-16.
 * Historical versions retain their literal inline payloads until that conversion retires. */
export const MutationEvidenceResultDetailsSchema = Schema.StructWithRest(Schema.Struct({
  mutationEvidence: Schema.optionalKey(MutationEvidenceSchema),
  mutation: Schema.optionalKey(Schema.Never),
  mutationChanges: Schema.optionalKey(Schema.Never),
  conflicts: Schema.optionalKey(Schema.Never),
  conflictMarkers: Schema.optionalKey(Schema.Never),
  notApplied: Schema.optionalKey(Schema.Never),
}), [Schema.Record(Schema.String, Schema.Unknown)]);

/** Define a current tool-result payload with bounded mutation references and the supplied text codec. */
export function evidenceResultPayload<Text extends Schema.Top>(text: Text) {
  return Schema.Struct({
    toolUseId: Schema.NonEmptyString,
    outcome: Schema.Literals(TOOL_OUTCOME_VALUES),
    contentBytes: Schema.optionalKey(NonNegativeInt),
    contentSha256: Schema.optionalKey(Schema.String),
    contentPreview: Schema.optionalKey(Schema.String),
    content: Schema.optionalKey(text),
    contentTruncated: Schema.optionalKey(Schema.Boolean),
    originalContentBytes: Schema.optionalKey(NonNegativeInt),
    originalContentSha256: Schema.optionalKey(Schema.String),
    fullContentPath: Schema.optionalKey(Schema.String),
    semanticOutputTruncated: Schema.optionalKey(Schema.Boolean),
    byteOutputTruncated: Schema.optionalKey(Schema.Boolean),
    modelRequestId: Schema.optionalKey(Schema.String),
    details: Schema.optionalKey(MutationEvidenceResultDetailsSchema),
    parentToolUseId: Schema.optionalKey(Schema.String),
  });
}

/** Define a current command-output payload without permitting historical inline mutation fields. */
export function evidenceOutputPayload<Text extends Schema.Top>(text: Text) {
  return Schema.Struct({
    toolUseId: Schema.NonEmptyString,
    output: text,
    modelRequestId: Schema.optionalKey(Schema.String),
    parentToolUseId: Schema.optionalKey(Schema.String),
    mutationEvidence: Schema.optionalKey(MutationEvidenceSchema),
    mutation: Schema.optionalKey(Schema.Never),
    conflicts: Schema.optionalKey(Schema.Never),
    conflictMarkers: Schema.optionalKey(Schema.Never),
    notApplied: Schema.optionalKey(Schema.Never),
  });
}
