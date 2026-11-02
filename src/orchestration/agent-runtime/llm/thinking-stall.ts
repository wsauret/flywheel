import { Schema } from "effect";

export class ThinkingStallError extends Schema.TaggedErrorClass<ThinkingStallError>()("ThinkingStall", {
  blockKey: Schema.optionalKey(Schema.String),
  elapsedMs: Schema.Number,
  summary: Schema.String,
  message: Schema.String,
}) {
  constructor(input: { blockKey?: string; elapsedMs: number; summary: string }) {
    super({ ...input, message: `thinking block stalled after ${Math.round(input.elapsedMs)}ms` });
    this.name = "ThinkingStallError";
  }
}