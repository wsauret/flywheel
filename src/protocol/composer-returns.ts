import { Schema } from "effect"
import { ChatInputObjectSchema } from "../infra/chat-input-schema.js"

/** Stable transcript identity for input a child finished without reading. */
export function returnedInputNoticeId(sourceSessionId: string, inputKey: string): string {
  return `returned-input:${sourceSessionId}:${inputKey}`
}
export function isReturnedInputNotice(id: string): boolean {
  return id.startsWith("returned-input:")
}
/** Correlation for a returned identified send, independent of its draft claim. */
export function returnedInputSubmissionId(id: string): string | undefined {
  if (!isReturnedInputNotice(id)) return undefined
  const start = id.indexOf(":person:")
  return start === -1 ? undefined : id.slice(start + ":person:".length)
}
export const ComposerReturnSchema = Schema.Struct({
  noticeId: Schema.NonEmptyString,
  sourceSessionId: Schema.NonEmptyString,
  sourceName: Schema.String,
  input: ChatInputObjectSchema,
})
export type ComposerReturn = typeof ComposerReturnSchema.Type
export const ClaimComposerReturnsResultSchema = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), kind: Schema.Literal("claimed"), items: Schema.Array(ComposerReturnSchema) }),
  Schema.Struct({ ok: Schema.Literal(true), kind: Schema.Literals(["empty", "no_match"]) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])
export type ClaimComposerReturnsResult = typeof ClaimComposerReturnsResultSchema.Type
