import { Schema } from "effect"
import type { RuntimePosition, RuntimeSessionCursorIdentity, RuntimeUiPatchPayload } from "./runtime-ui-protocol-types.js"

/** The background index of one chat: its background commands and every
 *  child it started, with the children of each child nested under it. A
 *  workflow is one row: its agents and the work they start have no rows. */
export const SessionBackgroundWorkQuerySchema = Schema.Struct({ type: Schema.Literal("sessionBackgroundWork"), sessionId: Schema.NonEmptyString })
export type SessionBackgroundWorkQuery = typeof SessionBackgroundWorkQuerySchema.Type

const BACKGROUND_WORK_STATUSES = ["running", "waiting_on_parent", "interrupted", "completed", "partial", "failed", "stopped", "cancelled", "ended"] as const
export type BackgroundWorkStatus = (typeof BACKGROUND_WORK_STATUSES)[number]

const Milliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const BackgroundWorkTargetSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("session"), sessionId: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("workflow"), workflowId: Schema.NonEmptyString }),
])
export type BackgroundWorkTarget = typeof BackgroundWorkTargetSchema.Type

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const BackgroundWorkProgressSchema = Schema.Struct({
  /** Units that finished, of `total`, as the workflow card counts them. */
  done: Count,
  total: Count,
  failed: Count,
  /** Agents that run now. */
  running: Count,
  /** The distinct names of the agents that run now, in plan order. */
  active: Schema.Array(Schema.String),
})
export type BackgroundWorkProgress = typeof BackgroundWorkProgressSchema.Type

export const BackgroundWorkRowSchema = Schema.Struct({
  /** The tool use id of a command, the session id of a child. */
  id: Schema.NonEmptyString,
  kind: Schema.Literals(["command", "subagent", "workflow"]),
  title: Schema.String,
  startedAtMs: Milliseconds,
  /** How long a finished command or subagent ran. A subagent counts the
   *  time of its runs only, not a wait between a run and its resume. */
  durationMs: Schema.optionalKey(Milliseconds),
  /** The exit code of a finished command that reported one. */
  exitCode: Schema.optionalKey(Schema.Int),
  /** The row of the child that started this row. Absent on a top-level row. */
  parentRowId: Schema.optionalKey(Schema.NonEmptyString),
  /** The card in the chat transcript that a click lands on: the row's own
   *  card, or the card of its top-level ancestor for a nested row. */
  cardToolUseId: Schema.NonEmptyString,
  /** The typed place Open displays. A workflow aggregate is never a session. */
  target: Schema.optionalKey(BackgroundWorkTargetSchema),
  status: Schema.Literals(BACKGROUND_WORK_STATUSES),
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  roleSessionId: Schema.optionalKey(Schema.String),
  /** Where a workflow is in its plan, which its row states in place of a
   *  row for each agent. */
  progress: Schema.optionalKey(BackgroundWorkProgressSchema),
  /** The `background.terminate` that stops an active row. Absent when the
   *  runtime admits no Stop for the row. */
  stop: Schema.optionalKey(Schema.Struct({ sessionId: Schema.NonEmptyString, toolUseId: Schema.NonEmptyString })),
})
export type BackgroundWorkRow = typeof BackgroundWorkRowSchema.Type

export interface SessionBackgroundWorkResult {
  /** The position of the last row patch the rows include, so each later patch applies over them. */
  readonly snapshotPosition: RuntimePosition
  /** Every row of the index, in no stated order: a client orders them (`orderBackgroundRows`). */
  readonly rows: readonly BackgroundWorkRow[]
}
export const SessionBackgroundWorkResultSchema: Schema.Codec<SessionBackgroundWorkResult> = Schema.Struct({
  snapshotPosition: Schema.Number,
  rows: Schema.Array(BackgroundWorkRowSchema),
})

/** One row of a held index that changed, whole, or the removal of a row by
 *  its id (ARCH-PROTOCOL-069). */
export type BackgroundPatchPayload =
  | { readonly kind: "background.row.updated"; readonly row: BackgroundWorkRow }
  | { readonly kind: "background.row.removed"; readonly rowId: string }

export function backgroundCursor(sessionId: string): RuntimeSessionCursorIdentity & { readonly domain: "background" } {
  return { scope: "session", domain: "background", sessionId }
}

export function isBackgroundPayload(payload: RuntimeUiPatchPayload): payload is BackgroundPatchPayload {
  return payload.kind === "background.row.updated" || payload.kind === "background.row.removed"
}
