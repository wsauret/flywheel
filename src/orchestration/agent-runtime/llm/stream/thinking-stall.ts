import { Schema } from "effect";

export class ThinkingStallError extends Schema.TaggedError<ThinkingStallError>()("ThinkingStall", {
  blockKey: Schema.optionalKey(Schema.String),
  elapsedMs: Schema.Number,
  message: Schema.String,
}) {
  constructor(input: { blockKey?: string; elapsedMs: number }) {
    super({ ...input, message: `thinking block stalled after ${Math.round(input.elapsedMs)}ms` });
    this.name = "ThinkingStallError";
  }
}
