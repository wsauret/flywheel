import { Schema } from "effect"
import { ReadingStateSchema } from "../../../src/protocol/client/reading-state.js"
import { attachmentKind } from "../../../src/protocol/client/attachments.js"
import type { UnsentChatSubmission } from "../../../src/protocol/client/chat-submissions.js"

const Attachment = Schema.Struct({
  marker: Schema.String, mediaType: Schema.String, data: Schema.String,
  name: Schema.optional(Schema.String),
}).check(Schema.makeFilter((attachment) => attachmentKind(attachment.mediaType, attachment.name ?? "") !== undefined || "Unsupported prepared attachment"))
const Draft = Schema.Struct({ text: Schema.String, attachments: Schema.Array(Attachment) })
const Question = Schema.Struct({
  chosen: Schema.Record(Schema.String, Schema.Struct({ ids: Schema.Array(Schema.String), text: Schema.Record(Schema.String, Schema.String) })),
  freeform: Schema.Record(Schema.String, Schema.String),
  otherOpen: Schema.Record(Schema.String, Schema.Boolean),
  collapsed: Schema.Boolean,
})
export const ComposerCheckpoint = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  active: Draft,
  newChat: Schema.optional(Draft),
  drafts: Schema.Record(Schema.String, Draft),
  questions: Schema.Record(Schema.String, Question),
})
export type ComposerCheckpoint = typeof ComposerCheckpoint.Type
const Focus = Schema.Struct({
  key: Schema.String,
  start: Schema.optional(Schema.Number), end: Schema.optional(Schema.Number),
  direction: Schema.optional(Schema.Literals(["forward", "backward", "none"])),
  scrollTop: Schema.Number, scrollLeft: Schema.Number,
})
/** One message the page sent that the runtime had not answered, with the
 *  submission identity the next page sends it again under. */
const Unsent = Schema.Struct({
  sessionId: Schema.String,
  id: Schema.String,
  input: Schema.Struct({
    text: Schema.String,
    attachments: Schema.optional(Schema.Array(Attachment)),
    invocation: Schema.optional(Schema.Struct({ label: Schema.String, args: Schema.optional(Schema.String) })),
    submissionIds: Schema.Array(Schema.String),
  }),
  timestamp: Schema.Number,
})
/** Transfer artifact only. Live input remains in the surface owners until
 *  replacement. Between replacements the store holds only the outbox, which
 *  the mount keeps current, so any end of the page hands it on. */
export const InputReloadCheckpoint = Schema.Struct({
  version: Schema.Literal(1),
  scope: Schema.String,
  composer: Schema.optional(ComposerCheckpoint),
  reading: Schema.optional(ReadingStateSchema),
  focus: Schema.optional(Focus),
  /** The messages on their way or waiting for the connection, which the
   *  next page shows queued and sends again on its first lane. A page omits
   *  the field when nothing waits, so an older page still reads it. */
  outbox: Schema.optional(Schema.Array(Unsent)),
})
export type InputReloadCheckpoint = typeof InputReloadCheckpoint.Type

/** The messages a checkpoint hands over unanswered, none when the field is
 *  absent. This reads the shape that pages before 2026-10-22 save, which
 *  has no `outbox` field. After 2027-04-22 no page reads a checkpoint of
 *  such a page; absence then means only that nothing waited, and the
 *  older-shape test in `input-reload.test.ts` can go. */
export function checkpointOutbox(checkpoint: InputReloadCheckpoint): readonly UnsentChatSubmission[] {
  return checkpoint.outbox ?? []
}

/** Storage retains unknown bytes until a successor has adopted a validated checkpoint. */
export interface InputReloadStorage {
  load(): Promise<InputReloadCheckpoint | undefined>
  save(checkpoint: InputReloadCheckpoint): Promise<void>
  consume(): Promise<void>
}

export function decodeInputReloadCheckpoint(bytes: unknown, scope: string): InputReloadCheckpoint | undefined {
  if (bytes === undefined) return undefined
  const checkpoint = Schema.decodeUnknownSync(InputReloadCheckpoint)(bytes)
  return checkpoint.scope === scope ? checkpoint : undefined
}
