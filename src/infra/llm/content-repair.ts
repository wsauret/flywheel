import { Schema } from "effect";

/** The canonical `LlmToolOutputPart` types that a provider can refuse. */
export const RefusedPartKindSchema = Schema.Literals(["text", "image"]);

/** A recorded decision that repairs conversation content a provider refused. It holds identities only: the
 *  decision note is the one home of the provider's reason. `withhold` replaces one tool result part; `remove`
 *  drops the tool calls of one assistant message and their results. */
export const ContentRepairSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("withhold"), toolUseId: Schema.NonEmptyString, partIndex: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)), partKind: RefusedPartKindSchema }),
  Schema.Struct({ kind: Schema.Literal("remove"), toolUseIds: Schema.Array(Schema.NonEmptyString).check(Schema.isNonEmpty()) }),
]);
export type ContentRepair = typeof ContentRepairSchema.Type;

/** The canonical tool result part that a provider refusal names. */
export interface RefusedPart { readonly toolUseId: string; readonly partIndex: number; readonly kind: "text" | "image" }
