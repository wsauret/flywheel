import { Schema } from "effect";

// External boundary (agent/provider runtime streams): `.passthrough()` is the
// contract — provider events carry extra fields we must not reject (ARCH-BOUNDARIES-001).

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);

const ThinkingContentBlockSchema = Schema.StructWithRest(Schema.Struct({
  type: Schema.Literal("thinking"),
  thinking: Schema.String,
  presentation: Schema.optionalKey(Schema.Literal("progress")),
}), [UnknownRecordSchema]);

const TextContentBlockSchema = Schema.StructWithRest(Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
}), [UnknownRecordSchema]);

const ToolUseContentBlockSchema = Schema.StructWithRest(Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.optionalKey(Schema.String),
  name: Schema.String,
  input: Schema.optionalKey(UnknownRecordSchema),
}), [UnknownRecordSchema]);

const ImageContentBlockSchema = Schema.Struct({
  type: Schema.Literal("image"),
  mediaType: Schema.String,
  data: Schema.String,
});
const ReasoningContentBlockSchema = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  encrypted_content: Schema.String,
  summary: Schema.optionalKey(Schema.Array(Schema.Struct({ type: Schema.Literal("summary_text"), text: Schema.String }))),
});
export const ContentBlockSchema = Schema.Union([ThinkingContentBlockSchema, TextContentBlockSchema, ToolUseContentBlockSchema, ImageContentBlockSchema, ReasoningContentBlockSchema]);

export type ContentBlock = typeof ContentBlockSchema.Type;
