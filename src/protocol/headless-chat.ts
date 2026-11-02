import { Schema } from "effect"
import { FrontendMutationSchema, RuntimeEventFrameSchema, RuntimeQuerySchema } from "./runtime-protocol-schemas.js"

/** Version 1 JSONL input. Each line is a dispatch or query with a caller-owned
 * correlation id and the existing runtime protocol payload. Session ids in
 * commands are explicit; the ready frame supplies the root chat id.
 * Question answers and cancellations use question.answer and question.cancel.
 * Interrupt uses chat.interrupt; child Stop uses background.terminate.
 * Reattaching a chat does not resume it: use chat.resume or session.send.
 * Blank lines are ignored. Invalid lines return an error and do not dispatch.
 * No command, including EOF, supplies an implicit question answer.
 */
export const HeadlessChatRequestSchema = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1), type: Schema.Literal("dispatch"),
    id: Schema.NonEmptyString, command: FrontendMutationSchema,
  }),
  Schema.Struct({
    version: Schema.Literal(1), type: Schema.Literal("query"),
    id: Schema.NonEmptyString, query: RuntimeQuerySchema,
  }),
]).pipe(Schema.annotate({ parseOptions: { onExcessProperty: "error" } }))

export type HeadlessChatOutcome = "complete" | "input_required" | "incomplete" | "failed"

/** Version 1 JSONL output. Events are unchanged runtime projection patches.
 * Results carry unchanged dispatch/query results; an undefined result is null.
 * Errors carry an id when envelope validation recovered one, otherwise null.
 * Ready precedes commands. One outcome follows EOF, accepted work settlement,
 * and awaited runtime disposal. Complete means no work or question remains,
 * not that a model's task succeeded. Interrupted work ends as incomplete.
 * Failed means a channel or shutdown error. Diagnostics never use stdout.
 * With --one-shot, the first work-submitting dispatch enables automatic return
 * while stdin is still open: when a turn ends and no work the agent owns still
 * runs, the final reply settles durably and the outcome carries it as
 * `handoff.summary`. Queries and settings alone do not submit a turn. A pending
 * question is input_required.
 */
export const HeadlessChatRecordSchema = Schema.Union([
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("ready"), sessionId: Schema.String }),
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("event"), event: RuntimeEventFrameSchema }),
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("result"), id: Schema.String, result: Schema.Unknown }),
  Schema.Struct({ version: Schema.Literal(1), type: Schema.Literal("error"), id: Schema.NullOr(Schema.String), error: Schema.String }),
  Schema.Struct({
    version: Schema.Literal(1), type: Schema.Literal("outcome"), sessionId: Schema.NullOr(Schema.String),
    outcome: Schema.Literals(["complete", "input_required", "incomplete", "failed"]),
    handoff: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
])

export type HeadlessChatRecord = typeof HeadlessChatRecordSchema.Type
