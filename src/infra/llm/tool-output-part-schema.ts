import { Schema } from "effect";
import { assertNever } from "../assert-never.js";

// ~28M base64 chars ≈ 20MB binary, mirroring the readImage pre-base64 cap so
// external producers (subagents, replayed history) can't push oversized
// image payloads through runtime events / SQLite.
const MAX_IMAGE_BASE64_CHARS = 28_000_000;

export const LlmToolOutputPartSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image"),
    mediaType: Schema.String,
    data: Schema.String.check(Schema.isMaxLength(MAX_IMAGE_BASE64_CHARS)),
  }),
]);

export type LlmToolOutputPart = typeof LlmToolOutputPartSchema.Type;

type ImagePart = Extract<LlmToolOutputPart, { type: "image" }>;

export function toTextParts(text: string): LlmToolOutputPart[] {
  return [{ type: "text", text }];
}

export function imageOmittedPlaceholder(mediaType: string): string {
  return `[image: ${mediaType}, omitted (model does not support images)]`;
}

export function splitToolOutputParts(
  parts: ReadonlyArray<LlmToolOutputPart>,
  supportsImages: boolean,
) {
  const textChunks: string[] = [];
  const images: ImagePart[] = [];
  const omittedImagePlaceholders: string[] = [];
  for (const part of parts) {
    switch (part.type) {
      case "text":
        textChunks.push(part.text);
        break;
      case "image":
        if (supportsImages) images.push(part);
        else omittedImagePlaceholders.push(imageOmittedPlaceholder(part.mediaType));
        break;
      default:
        return assertNever(part);
    }
  }
  return { text: textChunks.join("\n"), images, omittedImagePlaceholders };
}
