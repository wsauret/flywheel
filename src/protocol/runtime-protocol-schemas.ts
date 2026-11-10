import { Schema } from "effect"
import { CLIENT_IDENTITY_PATTERN } from "./client-identity.js"
import { RuntimeClientDiagnosticSchema } from "./runtime-client-diagnostics.js"
import { RuntimeCursorIdentitySchema } from "./runtime-cursor-schemas.js"
import { ChatInputObjectSchema } from "../infra/chat-input-schema.js"
import { BackgroundWorkRowSchema, SessionBackgroundWorkQuerySchema, SessionBackgroundWorkResultSchema } from "./background-index-protocol-types.js"
import { MutationFilesQuerySchema, MutationFilesResultSchema, MutationPatchWindowQuerySchema, MutationPatchWindowResultSchema } from "./mutation-evidence-protocol-types.js"
import { SessionChangeSummaryQuerySchema, SessionChangeSummaryResultSchema, SessionFileChangeCountsSchema, SessionChangesQuerySchema, SessionChangesResultSchema, SessionChangeDiffQuerySchema, SessionChangeDiffResultSchema, SessionChangesSetViewedSchema, SessionChangesUndoSchema } from "./session-changes-protocol-types.js"
import { Rpc, RpcGroup } from "effect/rpc"
import { InvariantViolation } from "../infra/invariant.js"
import { exactStruct } from "../infra/exact-struct.js"
import { isSessionId } from "../infra/session-id.js"
import { ToolStreamingTextSchema } from "../infra/output-blocks.js"
import { EffortSchema } from "../infra/workflow-types.js"
import { AgentInputAnswerSchema } from "./question-protocol-types.js"
import { ModuleIdSchema } from "./module-ids.js"
import type { FrontendMutation, RuntimeChatDefault, RuntimeEventFrame, RuntimeExecutorState, RuntimeFaultReportOutcome, RuntimeQuery, RuntimeServiceState } from "./app-service-types.js"
import type { BudgetPatchPayload, RuntimeBudgetSnapshotResult } from "./budget-protocol-types.js"
import { CommandCatalogPatchPayloadSchema, RuntimeCommandCatalogResultSchema, RuntimeCommandInvocationSchema } from "./command-catalog-protocol-schemas.js"
import { BinaryModuleIdSchema, MODULE_SETTING_GROUPS, ModulePresetSchema, type ModuleConfigSettingControl, type ModulePatchPayload, type RuntimeModuleSnapshotResult, type RuntimeModulesView } from "./module-protocol-types.js"
import type { RoleAssignmentView, RolePatchPayload, RuntimeRoleSnapshotResult } from "./role-protocol-types.js"
import type { OutputWindowRequest, OutputWindowSnapshot } from "./transcript-protocol-types.js"
import type { QuestionPatchPayload, RuntimeQuestionSnapshotResult } from "./question-protocol-types.js"
import type { RuntimeSessionViewsResult, RuntimeUiDomain, RuntimeUiPatch, RuntimeUiSnapshot } from "./runtime-ui-protocol-types.js"
import type { ActiveBackgroundCommandView, StatusPatchPayload, RuntimeStatusSnapshotResult } from "./status-protocol-types.js"
import type { RuntimeAuthLoginMutation } from "./auth-login-protocol-types.js"
import type { RuntimeAuthProfileDeletionPreview } from "./auth-profile-selection-protocol-types.js"
import { RuntimeAuthProfileDefaultScopeSchema, RuntimeAuthProfileWriteScopeSchema, RuntimeAuthStatusScopeSchema, RuntimeAuthStatusSnapshotResultSchema, RuntimeAuthViewSchema } from "./auth-status-protocol-schemas.js"
import { RuntimeModelRolesResultSchema } from "./model-role-protocol-schemas.js"
import type { RuntimeUpdateSnapshotResult, UpdatePatchPayload, UpdateStatusView } from "./update-protocol-types.js"
import {
  RuntimeEffortOptionRowSchema,
  RuntimeEffortOptionsQuerySchema,
  RuntimeModelAssignmentRowSchema,
  RuntimeModelAssignmentsQuerySchema,
  RuntimeSessionModelPlanQuerySchema,
  RuntimeSessionModelPlanResultSchema,
  RuntimeModelOptionRowSchema,
  RuntimeModelOptionsQuerySchema,
  RuntimeResetModelAssignmentsMutationSchema,
  RuntimeRoleAssignmentEntrySchema,
  RuntimeSaveModelEffortMutationSchema,
} from "./model-assignment-protocol-schemas.js"
import { FrontendOutputBlockSchema, QuestionBlockSchema, HydratedOutputGroupChildrenBatchSchema, HydratedOutputRangeSchema, HydratedOutputBlockBodySchema, OutputGroupChildrenRequestSchema, OutputRangeRequestSchema, OutputBlockBodyRequestSchema, TranscriptSearchRequestSchema, TranscriptSearchResultSchema, ProjectFilesRequestSchema, ProjectFilesResultSchema } from "./transcript-protocol-schemas.js"
import { ProviderModelViewSchema, RuntimeDeselectAllProviderModelsMutationSchema, RuntimeProviderModelsQuerySchema, RuntimeRecheckProviderModelsMutationSchema, RuntimeSetProviderAutoEnableNewModelsMutationSchema, RuntimeSetProviderFreeRoutesMutationSchema, RuntimeSetProviderModelMutationSchema } from "./provider-model-preference-protocol-schemas.js"
import { RuntimeConfigMutationSchema, RuntimeConfigPatchPayloadSchema, RuntimeConfigSnapshotResultSchema } from "./runtime-config-protocol-schemas.js"
import { GitAiAttributionPatchPayloadSchema, RuntimeGitAiAttributionSnapshotResultSchema } from "./git-ai-attribution-protocol-schemas.js"
import { GitPatchPayloadSchema, RuntimeGitSnapshotResultSchema } from "./git-protocol-schemas.js"
import { CommandUsagePatchPayloadSchema, CommandUsageRecordMutationSchema, RuntimeCommandUsageSnapshotResultSchema } from "./command-usage-protocol-schemas.js"
import { PROTOCOL_BACKGROUND_DOMAINS, PROTOCOL_MODULE_DOMAINS, PROTOCOL_MODULE_MUTATION_SCHEMAS, PROTOCOL_MODULE_QUERY_SCHEMAS, PROTOCOL_MODULE_READS } from "./modules.js"
import { protocolQueryTable } from "./protocol-module.js"
import { recursiveUnionMembers } from "./schema-union.js"
import { RecallInputSchema, RecallResultSchema } from "./conversation-recall.js"
import { runtimeSessionDetailResultSchema } from "./session-detail-protocol-schemas.js"
import {
  ActivitySchema,
  RuntimeBackgroundSummaryResultSchema,
  SessionCatalogRowSchema,
  SessionCatalogSnapshotSchema,
  SubagentSessionRowSchema,
  WorkflowAgentSessionRowSchema,
} from "./session-catalog-protocol-schemas.js"
export type { RuntimeBackgroundSummaryResult } from "./session-catalog-protocol-schemas.js"

// Every schema with a hand-written counterpart in a *-protocol-types.ts module
// carries a `Schema.Codec<T>` annotation. The annotation makes the compiler
// the lockstep authority: a tag added to one declaration and not the other, or
// a field shape that drifts, is a type error here at the source rather than a
// latent failure at the wire boundary.
const RuntimePositionSchema = Schema.Number
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ProtocolChatInputSchema = Schema.Union([Schema.String, ChatInputObjectSchema])
export const RuntimeChatDefaultSchema: Schema.Codec<RuntimeChatDefault> = Schema.Union([
  exactStruct(Schema.Struct({ kind: Schema.Literal("pending") })),
  exactStruct(Schema.Struct({ kind: Schema.Literal("none") })),
  exactStruct(Schema.Struct({ kind: Schema.Literal("model"), model: Schema.NonEmptyString, effort: EffortSchema })),
])
const RuntimeFaultReportOutcomeSchema: Schema.Codec<RuntimeFaultReportOutcome> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("sent"), reportId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("failed") }),
  Schema.Struct({ kind: Schema.Literal("not-release") }),
])
const RuntimeExecutorStateSchema: Schema.Codec<RuntimeExecutorState> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("serving") }),
  Schema.Struct({ kind: Schema.Literal("restarting"), since: Schema.Number, cause: Schema.NonEmptyString, report: Schema.optionalKey(RuntimeFaultReportOutcomeSchema) }),
  Schema.Struct({ kind: Schema.Literal("recovery_failed"), cause: Schema.optionalKey(Schema.NonEmptyString), report: Schema.optionalKey(RuntimeFaultReportOutcomeSchema) }),
])
const RuntimeServiceStateSchema: Schema.Codec<RuntimeServiceState> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("serving") }),
  Schema.Struct({ kind: Schema.Literal("crash_loop"), cause: Schema.String, report: Schema.optionalKey(RuntimeFaultReportOutcomeSchema) }),
])

const ConnectionStateSchema = Schema.Union([Schema.Literal("connected"), Schema.Literal("retrying"), Schema.Literal("connecting"), Schema.Literal("reconnecting"), Schema.Literal("down")])
const RuntimeUiSnapshotSchema: Schema.Codec<RuntimeUiSnapshot> = SessionCatalogSnapshotSchema.pipe(Schema.fieldsAssign({ snapshotPosition: RuntimePositionSchema, projectRoot: Schema.String, runtimeVersion: Schema.String, runtimeBuildId: Schema.NullOr(Schema.String), chatDefault: RuntimeChatDefaultSchema, executor: RuntimeExecutorStateSchema, service: RuntimeServiceStateSchema }))
const RuntimeBackgroundSummaryRequestSchema = Schema.Struct({
  projectRoot: Schema.NonEmptyString,
  sessionIds: Schema.Array(Schema.String),
})

// A path step and the JSON value an edit carries. The value is the shape the
// edited entry or block holds at that path; the client checks the edited
// value against its schema before adopting it.
const ValuePathSchema = Schema.Array(Schema.Union([Schema.String, Schema.Number]))
const ValueEditSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("append"), path: ValuePathSchema, offset: NonNegativeInt, text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("window"), path: ValuePathSchema, offset: NonNegativeInt, drop: NonNegativeInt, text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("push"), path: ValuePathSchema, length: NonNegativeInt, items: Schema.Array(Schema.Json) }),
  Schema.Struct({ kind: Schema.Literal("assign"), path: ValuePathSchema, value: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("delete"), path: ValuePathSchema }),
])
const StreamingToolTextOpSchema = Schema.Union([
  Schema.Struct({ toolUseId: Schema.String, kind: Schema.Literal("set"), entry: ToolStreamingTextSchema }),
  Schema.Struct({ toolUseId: Schema.String, kind: Schema.Literal("remove") }),
  Schema.Struct({ toolUseId: Schema.String, kind: Schema.Literal("edit"), edits: Schema.Array(ValueEditSchema) }),
])
const StructuralOutputDeltaSchema = Schema.Struct({
  visibleMessageCount: NonNegativeInt,
  blocks: Schema.Array(Schema.Union([
    Schema.Struct({ kind: Schema.Literal("insert"), index: Schema.Number, blockId: Schema.String, block: FrontendOutputBlockSchema }),
    Schema.Struct({ kind: Schema.Literal("upsert"), index: Schema.Number, blockId: Schema.String, block: FrontendOutputBlockSchema }),
    Schema.Struct({ kind: Schema.Literal("edit"), index: Schema.Number, blockId: Schema.String, edits: Schema.Array(ValueEditSchema) }),
    Schema.Struct({ kind: Schema.Literal("append-content"), index: Schema.Number, blockId: Schema.String, contentOffset: Schema.Number, text: Schema.String }),
  ])),
  truncateTo: Schema.optionalKey(Schema.Number),
  streamingToolTextOps: Schema.optionalKey(Schema.Array(StreamingToolTextOpSchema)),
  streamingOutputChars: Schema.optionalKey(Schema.Number),
})
const StreamingOnlyCoordinatesSchema = {
  blocks: Schema.Array(Schema.Never),
  visibleMessageCount: Schema.optionalKey(Schema.Never),
  truncateTo: Schema.optionalKey(Schema.Never),
}
const OutputDeltaSchema = Schema.Union([
  StructuralOutputDeltaSchema,
  Schema.Struct({ ...StreamingOnlyCoordinatesSchema, streamingToolTextOps: Schema.Array(StreamingToolTextOpSchema), streamingOutputChars: Schema.optionalKey(Schema.Number) }),
  Schema.Struct({ ...StreamingOnlyCoordinatesSchema, streamingToolTextOps: Schema.optionalKey(Schema.Never), streamingOutputChars: Schema.Number }),
])
const OutputPatchPayloadSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("output.delta"), delta: OutputDeltaSchema }),
])
const ActiveBackgroundCommandSchema: Schema.Codec<ActiveBackgroundCommandView> = Schema.Union([
  Schema.Struct({ id: Schema.String, description: Schema.String, toolUseId: Schema.String, startedAtMs: Schema.Number, model: Schema.String, effort: Schema.optionalKey(Schema.String), roleSessionId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ id: Schema.String, description: Schema.String, toolUseId: Schema.String, startedAtMs: Schema.Number }),
])
const StatusViewSchema = Schema.Struct({
  activity: ActivitySchema,
  activityStartedAt: Schema.NullOr(Schema.Number),
  settledOutputPosition: Schema.NullOr(Schema.Union([RuntimePositionSchema, Schema.Struct({ recovery: Schema.String })])),
  connectionState: ConnectionStateSchema,
  activeSubagentCount: Schema.Number,
  activeBackgroundCommands: Schema.Array(ActiveBackgroundCommandSchema),
  activeForegroundBashToolCallIds: Schema.Array(Schema.String),
  processorHeldToolCallIds: Schema.Array(Schema.String),
  waitingOnBackgroundWork: Schema.Boolean,
  replyWaits: Schema.Array(Schema.Struct({ sessionId: Schema.String, name: Schema.String })),
  startedAt: Schema.Number,
  streamingStartedAt: Schema.NullOr(Schema.Number),
  accumulatedActiveMs: Schema.Number,
  compactionStartedAt: Schema.NullOr(Schema.Number),
})
export const StatusPatchPayloadSchema: Schema.Codec<StatusPatchPayload> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("status.updated"), status: StatusViewSchema }),
  Schema.Struct({ kind: Schema.Literal("status.removed") }),
])
/** Every session-scoped domain answers a read for several sessions in one shape. */
function sessionViewsResultSchema<View>(view: Schema.Codec<View>): Schema.Codec<RuntimeSessionViewsResult<View>> {
  return Schema.Struct({ snapshotPosition: RuntimePositionSchema, views: Schema.Array(Schema.Struct({ sessionId: Schema.String, view: Schema.NullOr(view) })) })
}
export const RuntimeStatusSnapshotResultSchema: Schema.Codec<RuntimeStatusSnapshotResult> = sessionViewsResultSchema(StatusViewSchema)

const BudgetViewSchema = Schema.Union([
  Schema.Struct({ totalsLoading: Schema.Literal(true) }),
  Schema.Struct({
    totalsLoading: Schema.Literal(false),
    tokens: Schema.Number,
    cost: Schema.Number,
    billedCost: Schema.Number,
    priceUnavailable: Schema.Boolean,
    contextPercent: Schema.Number,
    contextPromptTokens: Schema.Number,
    compactionTriggerTokens: Schema.optionalKey(Schema.Number),
    averageGenerationTokensPerSecond: Schema.optionalKey(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0))),
  }),
])
export const BudgetPatchPayloadSchema: Schema.Codec<BudgetPatchPayload> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("budget.updated"), budget: BudgetViewSchema }),
  Schema.Struct({ kind: Schema.Literal("budget.removed") }),
])
export const RuntimeBudgetSnapshotResultSchema: Schema.Codec<RuntimeBudgetSnapshotResult> = sessionViewsResultSchema(BudgetViewSchema)
/** Strict per variant: a version exists exactly where one is meant, so no
 *  reader has to decide whether a state without a version is idle, and the
 *  reason a release was not taken travels with the release rather than being
 *  re-derived by whoever renders it. */
const UpdateStatusSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("idle") }),
  Schema.Struct({ kind: Schema.Literal("no-repository") }),
  Schema.Struct({ kind: Schema.Literal("refused"), version: Schema.NonEmptyString, buildId: Schema.optionalKey(Schema.NonEmptyString) }),
  Schema.Struct({ kind: Schema.Literal("source-refused"), refused: Schema.NonEmptyString, running: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("available"), version: Schema.NonEmptyString, blocking: Schema.Literals(["nothing", "auto-install-off", "platform"]) }),
  Schema.Struct({ kind: Schema.Literal("installing"), version: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("installed"), version: Schema.NonEmptyString }),
])
const UpdateAutoInstallSchema = Schema.Struct({ persisted: Schema.Boolean, forcedOff: Schema.Boolean, effective: Schema.Boolean })
const UpdateStatusViewSchema: Schema.Codec<UpdateStatusView> = Schema.Struct({ revision: NonNegativeInt, autoInstall: UpdateAutoInstallSchema, status: UpdateStatusSchema, releaseNotice: Schema.optionalKey(Schema.Struct({ version: Schema.String, message: Schema.String, url: Schema.String })) })
const RuntimeUpdateSnapshotResultSchema: Schema.Codec<RuntimeUpdateSnapshotResult> = Schema.Struct({ snapshotPosition: RuntimePositionSchema, update: UpdateStatusViewSchema })
const UpdatePatchPayloadSchema: Schema.Codec<UpdatePatchPayload> = Schema.Struct({ kind: Schema.Literal("update.changed"), update: UpdateStatusViewSchema })
const WorkflowsModeSchema = Schema.Literals(["off", "ask", "on"])
const ModuleSettingGroupSchema = Schema.Literals(MODULE_SETTING_GROUPS)
const ModuleSettingSchema = Schema.Union([
  Schema.Struct({ control: Schema.Literal("binary"), label: Schema.String, description: Schema.String, group: Schema.optionalKey(ModuleSettingGroupSchema), providerId: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ control: Schema.Literal("workflow-mode"), label: Schema.String, description: Schema.String }),
])
const SettingHostSchema = Schema.optionalKey(Schema.Literals(["terminal", "browser"]))
const ModuleConfigSettingSchema: Schema.Codec<ModuleConfigSettingControl> = Schema.Union([
  Schema.Struct({ control: Schema.Literal("config-boolean"), section: Schema.String, key: Schema.String, defaultValue: Schema.Boolean, label: Schema.String, description: Schema.String, group: Schema.optionalKey(ModuleSettingGroupSchema), host: SettingHostSchema }),
  Schema.Struct({ control: Schema.Literal("config-boolean"), setting: Schema.Literal("notificationsDesktop"), label: Schema.String, description: Schema.String, group: Schema.optionalKey(ModuleSettingGroupSchema), host: SettingHostSchema }),
  Schema.Struct({ control: Schema.Literal("config-number-list"), section: Schema.String, key: Schema.String, defaultValue: Schema.Array(Schema.Int), suffix: Schema.optionalKey(Schema.String), label: Schema.String, description: Schema.String, min: Schema.Number, max: Schema.Number, group: Schema.optionalKey(ModuleSettingGroupSchema), host: SettingHostSchema }),
])
const ModuleProviderSettingSchema = Schema.Struct({ control: Schema.Literal("number"), key: Schema.NonEmptyString, label: Schema.String, description: Schema.String, min: Schema.Number, max: Schema.Number, off: Schema.Number, defaultValue: Schema.Number, group: Schema.optionalKey(Schema.Literal("Model providers")), providerId: Schema.NonEmptyString })
const ModuleProtocolRowSchema = Schema.Struct({
  id: ModuleIdSchema,
  installed: Schema.Boolean,
  effective: Schema.Boolean,
  dependencies: Schema.Array(ModuleIdSchema),
  dependencyError: Schema.optionalKey(Schema.String),
  setting: Schema.optionalKey(ModuleSettingSchema),
  configSettings: Schema.optionalKey(Schema.Array(ModuleConfigSettingSchema)),
  providerSettings: Schema.optionalKey(Schema.Array(ModuleProviderSettingSchema)),
})
const RuntimeModulesViewSchema: Schema.Codec<RuntimeModulesView> = Schema.Struct({
  capabilities: Schema.Array(ModuleIdSchema),
  moduleIds: Schema.Array(ModuleIdSchema),
  descriptorIdentity: Schema.String,
  modules: Schema.Array(ModuleProtocolRowSchema),
  warnings: Schema.Array(Schema.String),
  requireWorkflowConfirmation: Schema.Boolean,
  workflowsMode: WorkflowsModeSchema,
  persistentProcesses: Schema.Struct({ persisted: Schema.Boolean, effective: Schema.Boolean, forcedByCli: Schema.Boolean }),
  error: Schema.optionalKey(Schema.String),
})
const RuntimeModuleSnapshotResultSchema: Schema.Codec<RuntimeModuleSnapshotResult> = Schema.Struct({ snapshotPosition: RuntimePositionSchema, capabilities: RuntimeModulesViewSchema })
const ModulePatchPayloadSchema: Schema.Codec<ModulePatchPayload> = Schema.Struct({ kind: Schema.Literal("modules.changed"), capabilities: RuntimeModulesViewSchema })
export const QuestionPatchPayloadSchema: Schema.Codec<QuestionPatchPayload> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("question.updated"), question: QuestionBlockSchema }),
  Schema.Struct({ kind: Schema.Literal("question.removed") }),
])
export const RuntimeQuestionSnapshotResultSchema: Schema.Codec<RuntimeQuestionSnapshotResult> = sessionViewsResultSchema(QuestionBlockSchema)
const RoleAssignmentViewSchema: Schema.Codec<RoleAssignmentView> = Schema.Struct({
  assignments: Schema.Record(Schema.String, RuntimeRoleAssignmentEntrySchema),
  serving: Schema.optionalKey(Schema.Struct({
    slot: Schema.Struct({ kind: Schema.Literal("role"), roleId: Schema.String }),
    selection: Schema.optionalKey(RuntimeRoleAssignmentEntrySchema),
  })),
})
const RolePatchPayloadSchema: Schema.Codec<RolePatchPayload> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("roles.updated"), roles: RoleAssignmentViewSchema }),
  Schema.Struct({ kind: Schema.Literal("roles.removed") }),
])
const RuntimeRoleSnapshotResultSchema: Schema.Codec<RuntimeRoleSnapshotResult> = sessionViewsResultSchema(RoleAssignmentViewSchema)
export const RuntimeUiPatchPayloadSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("changes.changed") }),
  Schema.Struct({ kind: Schema.Literal("background.row.updated"), row: BackgroundWorkRowSchema }),
  Schema.Struct({ kind: Schema.Literal("background.row.removed"), rowId: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("runtime.invalidate"), reason: Schema.Union([Schema.Literal("overflow"), Schema.Literal("reconnect_required"), Schema.Literal("protocol_violation"), Schema.Literal("rebase")]) }),
  Schema.Struct({ kind: Schema.Literal("session.added"), row: SessionCatalogRowSchema }),
  Schema.Struct({ kind: Schema.Literal("session.updated"), row: SessionCatalogRowSchema }),
  Schema.Struct({ kind: Schema.Literal("session.removed") }),
  Schema.Struct({ kind: Schema.Literal("session_detail.changed"), row: Schema.NullOr(Schema.Union([SessionCatalogRowSchema, SubagentSessionRowSchema, WorkflowAgentSessionRowSchema])) }),
  Schema.Struct({ kind: Schema.Literal("chat_default.changed"), chatDefault: RuntimeChatDefaultSchema }),
  Schema.Struct({ kind: Schema.Literal("executor.changed"), executor: RuntimeExecutorStateSchema }),
  Schema.Struct({ kind: Schema.Literal("service.changed"), service: RuntimeServiceStateSchema }),
  ...recursiveUnionMembers(OutputPatchPayloadSchema),
  ...recursiveUnionMembers(StatusPatchPayloadSchema),
  ...recursiveUnionMembers(BudgetPatchPayloadSchema),
  ...recursiveUnionMembers(QuestionPatchPayloadSchema),
  ...recursiveUnionMembers(RolePatchPayloadSchema),
  Schema.Struct({ kind: Schema.Literal("auth.changed"), auth: RuntimeAuthViewSchema }),
  CommandCatalogPatchPayloadSchema,
  UpdatePatchPayloadSchema,
  ModulePatchPayloadSchema,
  RuntimeConfigPatchPayloadSchema,
  GitAiAttributionPatchPayloadSchema,
  GitPatchPayloadSchema,
  CommandUsagePatchPayloadSchema,
  ...PROTOCOL_MODULE_DOMAINS.flatMap((domain) => recursiveUnionMembers(domain.patch)),
])
export const RuntimeUiPatchSchema: Schema.Codec<RuntimeUiPatch> = Schema.Struct({ cursor: RuntimeCursorIdentitySchema, position: RuntimePositionSchema, prevPosition: RuntimePositionSchema, payload: RuntimeUiPatchPayloadSchema })
const OutputWindowRequestSchema: Schema.Codec<OutputWindowRequest> = Schema.Struct({ range: OutputRangeRequestSchema })
const OutputWindowSnapshotSchema: Schema.Codec<OutputWindowSnapshot> = Schema.Struct({ snapshotPosition: RuntimePositionSchema, totalBlocks: NonNegativeInt, visibleMessageCount: NonNegativeInt, range: HydratedOutputRangeSchema })
export const RuntimeEventFrameSchema: Schema.Codec<RuntimeEventFrame> = Schema.Union([
  Schema.Struct({ type: Schema.Literal("runtime.connected") }),
  Schema.Struct({ type: Schema.Literal("patch"), patch: RuntimeUiPatchSchema }),
  // Liveness traffic for the client silence watchdog; carries no state.
  Schema.Struct({ type: Schema.Literal("runtime.heartbeat") }),
])

/** Wire shapes for mutations that carry secrets. This codec is the declared
 *  serialization boundary of ARCH-BOUNDARIES-009: each value exists
 *  as a plain string only on the wire and inside its transform. Decode wraps
 *  it before any handler, log, or trace can observe the frame. */
type FrontendMutationEncoded =
  | Exclude<FrontendMutation, { type: "auth.login" | "auth.login.complete" }>
  | (Omit<RuntimeAuthLoginMutation, "apiKey"> & { apiKey?: string })
  | { type: "auth.login.complete"; operationId: string; input: string }

const SubscriptionSpendConsentMutationBaseSchema = {
  profileId: Schema.NonEmptyString,
  usageGeneration: NonNegativeInt,
  authorityIncarnation: Schema.NonEmptyString,
  authorityRevision: NonNegativeInt,
  clientSnapshotPosition: RuntimePositionSchema,
  envelopeIds: Schema.Array(Schema.NonEmptyString),
}
const SessionForkMutationSchema = exactStruct(Schema.Struct({
  type: Schema.Literal("session.fork"),
  sessionId: Schema.String,
}))

export const FrontendMutationSchema: Schema.Codec<FrontendMutation, FrontendMutationEncoded> = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session.claim_composer_returns"), sessionId: Schema.String, submissionIds: Schema.Array(Schema.NonEmptyString) }),
  SessionChangesUndoSchema,
  SessionChangesSetViewedSchema,
  // A named chat's id becomes a directory name on the machine, so it must
  // have the shape every session id has.
  Schema.Struct({ type: Schema.Literal("chat.open"), initialMessage: Schema.optional(ProtocolChatInputSchema), sessionId: Schema.optional(Schema.String.check(Schema.makeFilter((value) => isSessionId(value) || "Expected a session id"))) }),
  Schema.Struct({ type: Schema.Literal("session.send"), sessionId: Schema.String, input: ProtocolChatInputSchema, targets: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)) }),
  Schema.Struct({ type: Schema.Literal("chat.compact"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("chat.interrupt"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("chat.resume"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("background.terminate"), sessionId: Schema.String, toolUseId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("bash.detach"), sessionId: Schema.String, toolUseId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("session.activate"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("session.release"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("session_detail.release"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("background.release"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("output.watch"), sessionIds: Schema.Array(Schema.String) }),
  SessionForkMutationSchema,
  Schema.Struct({ type: Schema.Literal("session.close"), sessionId: Schema.String, atRest: Schema.optionalKey(Schema.Literal(true)) }),
  Schema.Struct({ type: Schema.Literal("session.discard_transient"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("session.delete"), sessionId: Schema.String, inactiveBefore: Schema.optionalKey(Schema.Number) }),
  Schema.Struct({ type: Schema.Literal("session.reorder"), sessionId: Schema.String, beforeSessionId: Schema.NullOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("session.dismiss_notice"), sessionId: Schema.String, scope: Schema.String }),
  Schema.Struct({ type: Schema.Literal("session.rename"), sessionId: Schema.String, title: Schema.optionalKey(Schema.String), shortTitle: Schema.optionalKey(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("question.answer"), sessionId: Schema.String, toolUseId: Schema.String, answers: Schema.Record(Schema.String, AgentInputAnswerSchema) }),
  Schema.Struct({ type: Schema.Literal("question.cancel"), sessionId: Schema.String, toolUseId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("auth.refresh"), profileId: Schema.String, operationId: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("auth.catalog.refresh"), scope: Schema.Union([RuntimeAuthStatusScopeSchema, Schema.Struct({ kind: Schema.Literal("profile"), profileId: Schema.NonEmptyString })]) }),
  Schema.Struct({ type: Schema.Literal("auth.login"), providerId: Schema.String, apiKey: Schema.optionalKey(Schema.RedactedFromValue(Schema.String)), instanceId: Schema.optionalKey(Schema.String), loginQuestionId: Schema.optionalKey(Schema.NonEmptyString), profileId: Schema.optionalKey(Schema.NonEmptyString), openBrowser: Schema.optionalKey(Schema.Literal(true)) }),
  Schema.Struct({ type: Schema.Literal("auth.login.answer"), providerId: Schema.String, operationId: Schema.NonEmptyString, answer: Schema.String }),
  Schema.Struct({ type: Schema.Literal("auth.login.complete"), operationId: Schema.NonEmptyString, input: Schema.RedactedFromValue(Schema.NonEmptyString) }),
  Schema.Struct({ type: Schema.Literal("auth.login.cancel"), loginQuestionId: Schema.optionalKey(Schema.NonEmptyString), operationId: Schema.optionalKey(Schema.NonEmptyString) }),
  Schema.Struct({ type: Schema.Literal("auth.login.decline"), providerId: Schema.String, loginQuestionId: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("auth.account.disconnect"), providerId: Schema.String, instanceId: Schema.optionalKey(Schema.String), profileId: Schema.optionalKey(Schema.NonEmptyString) }),
  Schema.Struct({ type: Schema.Literal("auth.account.rename"), providerId: Schema.String, instanceId: Schema.String, label: Schema.optionalKey(Schema.String), profileId: Schema.optionalKey(Schema.NonEmptyString) }),
  Schema.Struct({ type: Schema.Literal("auth.profile.select"), scope: RuntimeAuthProfileWriteScopeSchema, id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("auth.profile.create"), scope: RuntimeAuthProfileWriteScopeSchema, displayName: Schema.String }),
  Schema.Struct({ type: Schema.Literal("auth.profile.rename"), scope: RuntimeAuthProfileDefaultScopeSchema, id: Schema.String, displayName: Schema.String }),
  Schema.Struct({ type: Schema.Literal("auth.profile.delete"), scope: RuntimeAuthProfileDefaultScopeSchema, id: Schema.String, successorId: Schema.NullOr(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("auth.profile.bind_current_project"), scope: RuntimeAuthProfileDefaultScopeSchema, id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("auth.profile.unbind_current_project"), scope: RuntimeAuthProfileDefaultScopeSchema }),
  RuntimeConfigMutationSchema,
  Schema.Struct({ type: Schema.Literal("settings.set_module"), moduleId: BinaryModuleIdSchema, expected: Schema.Boolean, enabled: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("settings.set_modules"), preset: ModulePresetSchema, expected: Schema.Struct({ moduleIds: Schema.Array(BinaryModuleIdSchema), requireWorkflowConfirmation: Schema.Boolean, descriptorIdentity: Schema.String }) }),
  Schema.Struct({ type: Schema.Literal("settings.set_workflow_mode"), expected: WorkflowsModeSchema, mode: WorkflowsModeSchema }),
  Schema.Struct({ type: Schema.Literal("settings.set_persistent_processes"), expected: Schema.Boolean, enabled: Schema.Boolean }),
  Schema.Struct({ type: Schema.Literal("subscription_spend_consent.save"), ...SubscriptionSpendConsentMutationBaseSchema, reviewedEnvelopeIds: Schema.Array(Schema.NonEmptyString), acceptedEnvelopeIds: Schema.Array(Schema.NonEmptyString) }),
  Schema.Struct({ type: Schema.Literal("settings.set_update_auto_install"), expected: Schema.Boolean, value: Schema.Boolean }),
  RuntimeCommandInvocationSchema,
  CommandUsageRecordMutationSchema,
  RuntimeSaveModelEffortMutationSchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("model.save_effort") })),
  RuntimeResetModelAssignmentsMutationSchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("model.reset_assignments") })),
  RuntimeSetProviderModelMutationSchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("provider_model.set") })),
  RuntimeDeselectAllProviderModelsMutationSchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("provider_models.deselect_all") })),
  RuntimeRecheckProviderModelsMutationSchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("provider_models.recheck") })),
  RuntimeSetProviderAutoEnableNewModelsMutationSchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("provider_models.set_auto_enable") })),
  RuntimeSetProviderFreeRoutesMutationSchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("provider_free_routes.set") })),
  Schema.Struct({ type: Schema.Literal("background.warm") }),
  // A module mutation takes the request codec its protocol home declares.
  ...PROTOCOL_MODULE_MUTATION_SCHEMAS,
])
export const RuntimeQuerySchema: Schema.Codec<RuntimeQuery> = Schema.Union([
  SessionChangeSummaryQuerySchema,
  SessionChangesQuerySchema, SessionChangeDiffQuerySchema,
  SessionBackgroundWorkQuerySchema,
  MutationFilesQuerySchema, MutationPatchWindowQuerySchema,
  Schema.Struct({ type: Schema.Literal("snapshot") }),
  Schema.Struct({ type: Schema.Literal("outputWindow"), sessionId: Schema.String, request: OutputWindowRequestSchema }),
  Schema.Struct({ type: Schema.Literal("outputRange"), sessionId: Schema.String, request: OutputRangeRequestSchema }),
  Schema.Struct({ type: Schema.Literal("outputGroupChildren"), sessionId: Schema.String, request: OutputGroupChildrenRequestSchema }),
  Schema.Struct({ type: Schema.Literal("outputBlockBody"), sessionId: Schema.String, request: OutputBlockBodyRequestSchema }),
  Schema.Struct({ type: Schema.Literal("transcriptSearch"), request: TranscriptSearchRequestSchema }),
  Schema.Struct({ type: Schema.Literal("projectFiles"), request: ProjectFilesRequestSchema }),
  Schema.Struct({ type: Schema.Literal("statusSnapshot"), sessionIds: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("budgetSnapshot"), sessionIds: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("questionSnapshot"), sessionIds: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("roleSnapshot"), sessionIds: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("recallQueuedMessage"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("authStatusSnapshot"), scope: RuntimeAuthStatusScopeSchema }),
  Schema.Struct({ type: Schema.Literal("authProfileDeletionPreview"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("updateSnapshot") }),
  Schema.Struct({ type: Schema.Literal("moduleSnapshot") }),
  Schema.Struct({ type: Schema.Literal("configSnapshot") }),
  Schema.Struct({ type: Schema.Literal("gitAiAttributionSnapshot") }),
  Schema.Struct({ type: Schema.Literal("gitSnapshot") }),
  Schema.Struct({ type: Schema.Literal("commandUsageSnapshot") }),
  Schema.Struct({ type: Schema.Literal("commandCatalog") }),
  Schema.Struct({ type: Schema.Literal("modelRoles") }),
  Schema.Struct({ type: Schema.Literal("sessionDetail"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("sessionDetailSnapshot"), sessionIds: Schema.Array(Schema.String) }),
  RuntimeModelAssignmentsQuerySchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("modelAssignments") })),
  RuntimeSessionModelPlanQuerySchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("sessionModelPlan") })),
  RuntimeModelOptionsQuerySchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("modelOptions") })),
  RuntimeEffortOptionsQuerySchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("effortOptions") })),
  RuntimeProviderModelsQuerySchema.pipe(Schema.fieldsAssign({ type: Schema.Literal("provider_models.query") })),
  ...PROTOCOL_MODULE_QUERY_SCHEMAS,
])
const AuthProfileDescriptorSchema = exactStruct(Schema.Struct({ id: Schema.String, displayName: Schema.String }))
const AuthProfileDeletionPreviewSchema: Schema.Codec<RuntimeAuthProfileDeletionPreview> = Schema.Union([
  exactStruct(Schema.Struct({ kind: Schema.Literal("fresh-default"), source: AuthProfileDescriptorSchema })),
  exactStruct(Schema.Struct({ kind: Schema.Literal("automatic"), source: AuthProfileDescriptorSchema, successor: AuthProfileDescriptorSchema })),
  exactStruct(Schema.Struct({ kind: Schema.Literal("choose"), source: AuthProfileDescriptorSchema, candidates: Schema.Array(AuthProfileDescriptorSchema) })),
])
const RuntimeSessionDetailResultSchema = runtimeSessionDetailResultSchema({
  status: StatusViewSchema,
  budget: BudgetViewSchema,
  chatRow: SessionCatalogRowSchema,
  subagentRow: SubagentSessionRowSchema,
  memberRow: WorkflowAgentSessionRowSchema,
})

/** One error type crosses the wire regardless of what actually failed (a
 *  single stringly-typed shape, the blank-toast class): `kind` is the small
 *  discriminant the audit asks for, mapped once at the fromPromise boundary
 *  in runtime-protocol-handlers.ts / runtime-background-worker.ts rather than
 *  splitting every RPC's error channel into its own schema. */
/** `client-mismatch` is the runtime refusing a web client whose bundle is not
 *  the one this build serves; the client answers it by loading itself again
 *  from the runtime, never by retrying the attach. `protocol-mismatch` is the
 *  runtime refusing a client that states another protocol version, or none,
 *  at its event attach; the error then names in `runtime` the release the
 *  runtime runs and the protocol version it speaks. `not-running` is a paused
 *  project declining a call because its executor is not running and nothing
 *  has asked for it (`ExecutorNotRunningError`): the runtime ran nothing, and
 *  the client records it as an expected outcome, never as a failure.
 *  `superseded` is a read whose answer an executor generation change voided
 *  (`ExecutorGenerationChangedError`): the change told every client to read
 *  again, so the client records it as an expected outcome too. */
export type RuntimeProtocolErrorKind = "invariant-violation" | "internal" | "client-mismatch" | "protocol-mismatch" | "not-running" | "superseded"

const ClientIdentitySchema = Schema.String.check(Schema.isPattern(CLIENT_IDENTITY_PATTERN))
/** The release a runtime runs and the protocol version that release speaks,
 *  which its refusal of another protocol version names. */
const RuntimeReleaseSchema = Schema.Struct({ version: Schema.String, protocolVersion: Schema.Number })
export type RuntimeRelease = typeof RuntimeReleaseSchema.Type
/** The event attach is the one message that crosses protocol versions, so
 *  its fields keep their meaning in every version and fields that this build
 *  does not know are ignored: a client of any later version reaches this
 *  build's version check and gets its refusal. Every client states
 *  `protocolVersion`. It is optional only because a web page loaded before
 *  clients stated it can still attach after an update; that page states its
 *  `clientIdentity`, which the runtime refuses first, and the page reloads. */
const RuntimeEventsAttachSchema = Schema.Struct({
  protocolVersion: Schema.optional(Schema.Number.check(Schema.isInt())),
  clientIdentity: Schema.optional(ClientIdentitySchema),
})

export class RuntimeProtocolError extends Schema.TaggedError<RuntimeProtocolError>()("RuntimeProtocolError", {
  message: Schema.String,
  kind: Schema.Union([Schema.Literal("invariant-violation"), Schema.Literal("internal"), Schema.Literal("client-mismatch"), Schema.Literal("protocol-mismatch"), Schema.Literal("not-running"), Schema.Literal("superseded")]),
  /** Set on `protocol-mismatch` alone: the release the refusing runtime runs. */
  runtime: Schema.optional(RuntimeReleaseSchema),
}) {}

/** A paused project's answer to a call that needs its executor while nothing
 *  has asked for execution: an open tab, the runtime's continuation, or a
 *  person's input asks, and other work is declined at once in plain words
 *  that ask for nothing. It crosses the wire as the `not-running` kind. */
export class ExecutorNotRunningError extends Error {
  constructor() {
    super("Flywheel's process for this project is not running now.")
    this.name = "ExecutorNotRunningError"
  }
}

/** A read that an executor generation change spanned: its answer is in the
 *  output coordinates of the generation that ended, which no client can
 *  adopt. The change published an invalidation that asks every client to
 *  read again, so this refusal loses nothing. It crosses the wire as the
 *  `superseded` kind. */
export class ExecutorGenerationChangedError extends Error {
  constructor() {
    super("Executor generation changed during status read")
    this.name = "ExecutorGenerationChangedError"
  }
}

/** Our own InvariantViolation means a Flywheel-owned consistency check
 *  failed - never expected, worth the client treating distinctly from any
 *  other caught error, which collapses to "internal". A paused project's
 *  refusal is the expected `not-running` outcome, and a read a generation
 *  change voided the expected `superseded` outcome. */
export function classifyRuntimeProtocolErrorKind(err: unknown): RuntimeProtocolErrorKind {
  if (err instanceof ExecutorNotRunningError) return "not-running"
  if (err instanceof ExecutorGenerationChangedError) return "superseded"
  return err instanceof InvariantViolation ? "invariant-violation" : "internal"
}

/** The result codec each query discriminant selects. The wire carries a query
 *  result as an opaque value and both ends encode and decode it through this
 *  table, keyed by `type`, never through a structural first match: a union
 *  member whose fields are all optional once decoded a result to `{}` by
 *  matching any object at all. Kernel rows are stated here; module rows come
 *  from the registry. The `satisfies` clause is the completeness gate, so a
 *  query without a result codec fails the build. */
const RUNTIME_QUERY_RESULT_SCHEMAS = {
  sessionChangeSummary: SessionChangeSummaryResultSchema, sessionChanges: SessionChangesResultSchema, sessionChangeDiff: SessionChangeDiffResultSchema,
  sessionBackgroundWork: SessionBackgroundWorkResultSchema,
  mutationFiles: MutationFilesResultSchema, mutationPatchWindow: MutationPatchWindowResultSchema,
  snapshot: RuntimeUiSnapshotSchema, outputWindow: OutputWindowSnapshotSchema, outputRange: HydratedOutputRangeSchema,
  outputGroupChildren: HydratedOutputGroupChildrenBatchSchema, outputBlockBody: HydratedOutputBlockBodySchema,
  transcriptSearch: TranscriptSearchResultSchema, projectFiles: ProjectFilesResultSchema,
  statusSnapshot: RuntimeStatusSnapshotResultSchema, budgetSnapshot: RuntimeBudgetSnapshotResultSchema,
  questionSnapshot: RuntimeQuestionSnapshotResultSchema, roleSnapshot: RuntimeRoleSnapshotResultSchema,
  authStatusSnapshot: RuntimeAuthStatusSnapshotResultSchema,
  authProfileDeletionPreview: AuthProfileDeletionPreviewSchema,
  updateSnapshot: RuntimeUpdateSnapshotResultSchema, moduleSnapshot: RuntimeModuleSnapshotResultSchema, configSnapshot: RuntimeConfigSnapshotResultSchema,
  gitAiAttributionSnapshot: RuntimeGitAiAttributionSnapshotResultSchema, gitSnapshot: RuntimeGitSnapshotResultSchema,
  commandUsageSnapshot: RuntimeCommandUsageSnapshotResultSchema,
  sessionDetail: RuntimeSessionDetailResultSchema, recallQueuedMessage: Schema.NullOr(ProtocolChatInputSchema), commandCatalog: RuntimeCommandCatalogResultSchema,
  sessionDetailSnapshot: Schema.Struct({ snapshotPosition: RuntimePositionSchema, views: Schema.Array(Schema.Struct({ sessionId: Schema.String, view: RuntimeSessionDetailResultSchema.fields.view })) }),
  modelAssignments: Schema.Array(RuntimeModelAssignmentRowSchema), modelOptions: Schema.Array(RuntimeModelOptionRowSchema), effortOptions: Schema.Array(RuntimeEffortOptionRowSchema),
  sessionModelPlan: RuntimeSessionModelPlanResultSchema,
  modelRoles: RuntimeModelRolesResultSchema, "provider_models.query": ProviderModelViewSchema,
  ...protocolQueryTable(PROTOCOL_MODULE_READS, (read) => read.result),
} satisfies { readonly [Type in RuntimeQuery["type"]]: Schema.Codec<unknown> }

export function runtimeQueryResultSchema(type: RuntimeQuery["type"]): Schema.Codec<unknown> {
  return RUNTIME_QUERY_RESULT_SCHEMAS[type]
}

/** The domains whose cursors each query's answer seeds. A read voids the
 *  public bus's last-published baselines for exactly these domains, so a
 *  value a client read and the bus never published is never mistaken for an
 *  unchanged one. Kernel rows are stated here; a module domain's snapshot
 *  query seeds that domain. The `satisfies` clause is the completeness gate. */
export const RUNTIME_READ_DOMAINS = {
  snapshot: ["session", "chat_default", "executor", "service"],
  statusSnapshot: ["status"], budgetSnapshot: ["budget"], questionSnapshot: ["question"], roleSnapshot: ["roles"],
  sessionDetailSnapshot: ["session_detail"], authStatusSnapshot: ["auth"], updateSnapshot: ["updates"], moduleSnapshot: ["modules"], configSnapshot: ["config"],
  gitAiAttributionSnapshot: ["gitAiAttribution"], gitSnapshot: ["git"], commandUsageSnapshot: ["commandUsage"], commandCatalog: ["commands"],
  outputWindow: ["output"], sessionChangeSummary: ["changes"], sessionBackgroundWork: ["background"],
  sessionChanges: [], sessionChangeDiff: [], outputRange: [], outputGroupChildren: [], outputBlockBody: [], transcriptSearch: [], projectFiles: [],
  mutationFiles: [], mutationPatchWindow: [],
  authProfileDeletionPreview: [], sessionDetail: [], recallQueuedMessage: [], modelAssignments: [], modelOptions: [], effortOptions: [], modelRoles: [], "provider_models.query": [],
  sessionModelPlan: [],
  ...protocolQueryTable(PROTOCOL_MODULE_READS, (read) => PROTOCOL_MODULE_DOMAINS.filter((domain) => domain.snapshot.query === read.query).map((domain) => domain.domain)),
} satisfies { readonly [Type in RuntimeQuery["type"]]: readonly RuntimeUiDomain[] }

export const RuntimeProtocolRpc = RpcGroup.make(
  // The result crosses as an opaque value; each end selects its codec by the
  // query's discriminant through `runtimeQueryResultSchema`.
  Rpc.make("RuntimeQuery", { payload: RuntimeQuerySchema, success: Schema.Unknown, error: RuntimeProtocolError }),
  Rpc.make("RuntimeDispatch", { payload: FrontendMutationSchema, success: Schema.Unknown, error: RuntimeProtocolError }),
  // Each event is decoded at the client read boundary, so a future variant
  // cannot reject the entire RPC chunk and interrupt unrelated requests.
  // Every client states the protocol version it speaks, and a web client also
  // states the identity of the bundle it runs. The runtime refuses a bundle
  // that is not its own, and then a protocol version that is not its own.
  Rpc.make("RuntimeEvents", { payload: RuntimeEventsAttachSchema, success: Schema.Unknown, error: RuntimeProtocolError, stream: true }),
  Rpc.make("RuntimeClientDiagnostic", { payload: RuntimeClientDiagnosticSchema, error: RuntimeProtocolError }),
)

// Both ends of the Worker lane run the same build, so the recall and summary
// calls refuse any key their payload or result does not declare, at every depth.
const strictParse = { onExcessProperty: "error" } as const

export const RuntimeBackgroundRpc = RpcGroup.make(
  Rpc.make("RuntimeBackgroundRecall", { payload: Schema.Struct({ projectRoot: Schema.NonEmptyString, conversationId: Schema.NonEmptyString, contract: RecallInputSchema }), success: RecallResultSchema, error: RuntimeProtocolError }).annotate(Rpc.ParseOptions, strictParse),
  Rpc.make("RuntimeBackgroundTranscriptSearch", { payload: Schema.Struct({ projectRoot: Schema.NonEmptyString, request: TranscriptSearchRequestSchema }), success: TranscriptSearchResultSchema, error: RuntimeProtocolError }),
  Rpc.make("RuntimeBackgroundSessionChangeSummary", { payload: Schema.Struct({ projectRoot: Schema.NonEmptyString, sessionId: Schema.NonEmptyString }), success: SessionFileChangeCountsSchema, error: RuntimeProtocolError }),
  Rpc.make("RuntimeBackgroundSnapshot", { payload: Schema.Struct({ projectRoot: Schema.NonEmptyString }), success: RuntimeBackgroundSummaryResultSchema, error: RuntimeProtocolError }).annotate(Rpc.ParseOptions, strictParse),
  Rpc.make("RuntimeBackgroundSessionSummaryImmediate", { payload: RuntimeBackgroundSummaryRequestSchema, success: RuntimeBackgroundSummaryResultSchema, error: RuntimeProtocolError }).annotate(Rpc.ParseOptions, strictParse),
  Rpc.make("RuntimeBackgroundWaitForTotals", { payload: RuntimeBackgroundSummaryRequestSchema, success: RuntimeBackgroundSummaryResultSchema, error: RuntimeProtocolError }).annotate(Rpc.ParseOptions, strictParse),
  Rpc.make("RuntimeBackgroundSessionDetail", { payload: Schema.Struct({ projectRoot: Schema.NonEmptyString, sessionId: Schema.String }), success: RuntimeSessionDetailResultSchema, error: RuntimeProtocolError }),
  // One RPC serves every module domain that declares a background codec; the
  // Worker encodes and the client decodes with `protocolBackgroundSchema(domain)`.
  Rpc.make("RuntimeBackgroundModuleSnapshot", { payload: Schema.Struct({ projectRoot: Schema.NonEmptyString, domain: Schema.Literals(PROTOCOL_BACKGROUND_DOMAINS), sessionId: Schema.String }), success: Schema.Unknown, error: RuntimeProtocolError }),
  Rpc.make("RuntimeBackgroundReleaseProject", { payload: Schema.Struct({ projectRoot: Schema.NonEmptyString }), success: Schema.Void, error: RuntimeProtocolError }),
  Rpc.make("RuntimeBackgroundShutdown", { success: Schema.Void, error: RuntimeProtocolError }),
)
