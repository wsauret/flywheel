import { Schema } from "effect"
import { WorkflowMembershipSchema } from "../infra/session-workflow-membership.js"
import { SESSION_NOTICE_PRESENTATION_IDS } from "../infra/error-presentation.js"
import type { SessionCatalogError, SessionRow } from "./app-service-types.js"

const SessionNoticeSchema = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  presentation: Schema.Literals(SESSION_NOTICE_PRESENTATION_IDS),
  severity: Schema.Union([Schema.Literal("info"), Schema.Literal("warning"), Schema.Literal("error")]),
  title: Schema.String,
  message: Schema.String,
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  retry: Schema.optionalKey(Schema.Struct({ count: Schema.Number, maxRetries: Schema.optionalKey(Schema.Number), delayMs: Schema.optionalKey(Schema.Number), nextAttemptAt: Schema.optionalKey(Schema.Number) })),
  wait: Schema.optionalKey(Schema.Struct({ agentName: Schema.String, continuesAt: Schema.Number })),
  action: Schema.optionalKey(Schema.Struct({ label: Schema.String, command: Schema.optionalKey(Schema.String) })),
})

export const ActivitySchema = Schema.Union([Schema.Literal("absent"), Schema.Literal("idle"), Schema.Literal("awaiting_user"), Schema.Literal("waiting"), Schema.Literal("thinking"), Schema.Literal("generating"), Schema.Literal("executing_tools")])
const SessionDiffStatsSchema = Schema.Struct({ added: Schema.Number, modified: Schema.Number, removed: Schema.Number })
const SessionCatalogRowMetadataSchema = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  shortTitle: Schema.optionalKey(Schema.String),
  lifecycleState: Schema.Union([Schema.Literal("active"), Schema.Literal("inactive")]),
  notices: Schema.Array(SessionNoticeSchema),
  lastUpdated: Schema.String,
  executionCwd: Schema.String,
  createdAt: Schema.optionalKey(Schema.String),
  parentSessionId: Schema.optionalKey(Schema.String),
  parentToolUseId: Schema.optionalKey(Schema.String),
  stoppedBy: Schema.optionalKey(Schema.Literals(["person", "agent"])),
  childSessionIds: Schema.optionalKey(Schema.Array(Schema.String)),
  activity: Schema.optionalKey(ActivitySchema),
  degraded: Schema.optionalKey(Schema.Literal(true)),
  unavailableFields: Schema.optionalKey(Schema.Array(Schema.String)),
})
const SessionCatalogLoadingRowSchema = SessionCatalogRowMetadataSchema.pipe(Schema.fieldsAssign({ totalsLoading: Schema.Literal(true) }))
const SessionCatalogReadyRowSchema = SessionCatalogRowMetadataSchema.pipe(Schema.fieldsAssign({
  totalsLoading: Schema.Literal(false),
  totalCost: Schema.Number,
  totalBilledCost: Schema.Number,
  priceUnavailable: Schema.Boolean,
  totalTokens: Schema.Number,
  contextPercent: Schema.Number,
  contextPromptTokens: Schema.Number,
  compactionTriggerTokens: Schema.optionalKey(Schema.Number),
  durationMs: Schema.Number,
  diffStats: Schema.optionalKey(SessionDiffStatsSchema),
}))
const chatFields = {
  kind: Schema.Literal("chat"),
  inputMode: Schema.Struct({ kind: Schema.Literal("chat") }),
  admittedActions: Schema.optionalKey(Schema.Array(Schema.Literals(["chat.interrupt", "chat.resume", "session.delete"]))),
}
export const SessionCatalogRowSchema = Schema.Union([
  SessionCatalogLoadingRowSchema.pipe(Schema.fieldsAssign(chatFields)),
  SessionCatalogReadyRowSchema.pipe(Schema.fieldsAssign(chatFields)),
])
const subagentFields = {
  kind: Schema.Literal("subagent"),
  runOutcome: Schema.optionalKey(Schema.Literals(["completed", "partial", "failed", "cancelled", "stopped"])),
  inputMode: Schema.Struct({ kind: Schema.Literal("message") }),
  admittedActions: Schema.Array(Schema.Literals(["session.send", "subagent.interrupt", "subagent.resume", "background.terminate", "session.delete"])),
}
export const SubagentSessionRowSchema = Schema.Union([
  SessionCatalogLoadingRowSchema.pipe(Schema.fieldsAssign(subagentFields)),
  SessionCatalogReadyRowSchema.pipe(Schema.fieldsAssign(subagentFields)),
])
const memberFields = {
  kind: Schema.Literal("workflow-agent"),
  inputMode: Schema.Struct({ kind: Schema.Literal("message") }),
  workflowMembership: WorkflowMembershipSchema,
  admittedActions: Schema.Array(Schema.Literals(["session.send", "chat.interrupt", "chat.resume", "session.delete"])),
}
export const WorkflowAgentSessionRowSchema = Schema.Union([
  SessionCatalogLoadingRowSchema.pipe(Schema.fieldsAssign(memberFields)),
  SessionCatalogReadyRowSchema.pipe(Schema.fieldsAssign(memberFields)),
])
const ChildSessionRowSchema = Schema.Union([SubagentSessionRowSchema, WorkflowAgentSessionRowSchema])
const SessionRowSchema = Schema.Union([SessionCatalogRowSchema, ChildSessionRowSchema])
const SessionCatalogErrorSchema = Schema.Struct({
  sessionId: Schema.String,
  scope: Schema.Union([Schema.Literal("metadata"), Schema.Literal("budget"), Schema.Literal("diffStats"), Schema.Literal("duration"), Schema.Literal("fork"), Schema.Literal("output")]),
  reason: Schema.String,
})
export const SessionCatalogSnapshotSchema = Schema.Struct({
  rows: Schema.Array(SessionCatalogRowSchema),
  activeRuntimeCount: Schema.Number,
  errors: Schema.Array(SessionCatalogErrorSchema),
})

/** Totals for the requested sessions, listed or child alike: the summary
 *  projection reads them by id and never lists them. */
export interface RuntimeBackgroundSummaryResult {
  readonly rows: readonly SessionRow[]
  readonly errors: readonly SessionCatalogError[]
  readonly totalsLoading: boolean
  /** Each row's own average generation speed in tokens per second, by
   *  session id. A session without a measured speed has no entry. */
  readonly generationSpeeds: { readonly [sessionId: string]: number }
}

export const RuntimeBackgroundSummaryResultSchema: Schema.Codec<RuntimeBackgroundSummaryResult> = Schema.Struct({
  rows: Schema.Array(SessionRowSchema),
  errors: Schema.Array(SessionCatalogErrorSchema),
  totalsLoading: Schema.Boolean,
  generationSpeeds: Schema.Record(Schema.String, Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
})
