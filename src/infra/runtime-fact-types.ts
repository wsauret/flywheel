import { Schema, SchemaTransformation } from "effect";
import { MutationDiffSchema } from "./mutation-diff.js";
import { ModelUsagePayloadV1, ModelUsagePayloadV2, ModelUsagePayloadV3, ModelUsagePayloadV4, ModelUsagePayloadV5, ModelUsagePayloadV6 } from "./usage-measured-payloads.js";
import { evidenceResultPayload, evidenceOutputPayload, nestedContentWithinCap } from "./runtime-mutation-evidence.js";
import { NotAppliedFilesSchema } from "./not-applied-files.js";
import { ToolContentReferenceSchema, type ToolContentReference } from "./tool-content.js";
import { TOOL_OUTCOME_VALUES } from "./tool-outcome.js";
import { WorkflowLaunchAgentModelsSchema } from "./workflow-types.js";

const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const MessageContentSchema = Schema.optionalKey(Schema.Union([
  Schema.String,
  Schema.Array(Schema.Unknown),
  UnknownRecordSchema,
]));
const ToolExecutionModeSchema = Schema.Union([Schema.Literal("foreground"), Schema.Literal("background")]);
const ToolTraceKindSchema = Schema.Union([Schema.Literal("tool"), Schema.Literal("subagent")]);

export interface RuntimeFactDefinition<
  T extends string = string,
  V extends number = number,
  A extends "agent" | "flywheel" | "provider" | "workflow" = "agent" | "flywheel" | "provider" | "workflow",
  P extends Schema.Decoder<unknown, never> = Schema.Decoder<unknown, never>,
> {
  readonly type: T;
  readonly version: V;
  readonly actor: A;
  readonly payload: P;
}

function defineRuntimeFact<
  const T extends string,
  const V extends number,
  const A extends "agent" | "flywheel" | "provider" | "workflow",
  const P extends Schema.Decoder<unknown, never>,
>(definition: RuntimeFactDefinition<T, V, A, P>): RuntimeFactDefinition<T, V, A, P> {
  return definition;
}

const ModelUserMessageRecorded = defineRuntimeFact({
  type: "model.user_message.recorded",
  version: 1,
  actor: "agent",
  payload: Schema.Struct({
    content: MessageContentSchema,
    origin: Schema.optionalKey(Schema.Union([Schema.Literal("user"), Schema.Literal("system")])),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }),
});

const ModelAssistantMessageRecorded = defineRuntimeFact({
  type: "model.assistant_message.recorded",
  version: 1,
  actor: "agent",
  payload: Schema.Struct({
    content: Schema.Array(Schema.Unknown),
    usage: Schema.optionalKey(UnknownRecordSchema),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }),
});

const ModelTurnCompleted = defineRuntimeFact({
  type: "model.turn.completed",
  version: 1,
  actor: "provider",
  payload: Schema.Struct({
    providerSessionId: Schema.optionalKey(Schema.String),
    isError: Schema.Boolean,
    subtype: Schema.optionalKey(Schema.String),
    result: Schema.optionalKey(Schema.String),
    totalCostUsd: Schema.optionalKey(Schema.Number),
    billedCostUsd: Schema.optionalKey(Schema.Number),
    usage: Schema.optionalKey(UnknownRecordSchema),
    modelUsage: Schema.optionalKey(UnknownRecordSchema),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }),
});

const ToolInputCompletedV1 = defineRuntimeFact({
  type: "tool.input.completed",
  version: 1,
  actor: "agent",
  payload: Schema.Struct({
    toolUseId: Schema.String,
    toolName: Schema.String,
    input: UnknownRecordSchema,
    inputBytes: NonNegativeInt,
    inputSha256: Schema.String,
    inputPreview: Schema.String,
    executionMode: ToolExecutionModeSchema,
    traceKind: ToolTraceKindSchema,
    childHasOwnViewport: Schema.Boolean,
    modelRequestId: Schema.optionalKey(Schema.String),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }),
});

const ToolInputCompletedV2 = defineRuntimeFact({
  type: "tool.input.completed",
  version: 2,
  actor: "agent",
  payload: Schema.Struct({
    toolUseId: Schema.NonEmptyString,
    providerCallId: Schema.NonEmptyString,
    providerToolName: Schema.NonEmptyString,
    toolName: Schema.NonEmptyString,
    modelRequestId: Schema.NonEmptyString,
    input: UnknownRecordSchema,
    inputBytes: NonNegativeInt,
    inputSha256: Schema.String,
    inputPreview: Schema.String,
    executionMode: ToolExecutionModeSchema,
    traceKind: ToolTraceKindSchema,
    childHasOwnViewport: Schema.Boolean,
    parentToolUseId: Schema.optionalKey(Schema.String),
  }),
});

const RuntimeWorkflowLaunchInputFields = {
  workflowDefinitionId: Schema.NonEmptyString,
  summary: Schema.optionalKey(Schema.NonEmptyString),
  description: Schema.NonEmptyString,
  launchCwd: Schema.optionalKey(Schema.NonEmptyString),
};

const RuntimeWorkflowLaunchInputSchema = Schema.Struct({
  ...RuntimeWorkflowLaunchInputFields,
  // Invocations recorded before 2026-10-14 omit agents; they decode unchanged. Remove this note after 2027-04-14.
  agents: Schema.optionalKey(WorkflowLaunchAgentModelsSchema),
});

/** A launch input of version 2, which named the fixed model choices
 *  `steps`. It decodes to the current input. Remove after 2027-04-30. */
const RuntimeWorkflowLaunchInputV2Schema = Schema.Struct({
  ...RuntimeWorkflowLaunchInputFields,
  steps: Schema.optionalKey(WorkflowLaunchAgentModelsSchema),
}).pipe(Schema.decodeTo(RuntimeWorkflowLaunchInputSchema, SchemaTransformation.transform({
  decode: ({ steps, ...input }): typeof RuntimeWorkflowLaunchInputSchema.Type => steps === undefined ? input : { ...input, agents: steps },
  encode: ({ agents, ...input }) => agents === undefined ? input : { ...input, steps: agents },
})));

const RuntimeWorkflowInvocationFields = {
  toolUseId: Schema.NonEmptyString,
  parentConversationId: Schema.NonEmptyString,
  parentEntryId: Schema.NonEmptyString,
};

function launchInvocationSchema<Input extends Schema.Top>(input: Input) {
  return Schema.Struct({
    ...RuntimeWorkflowInvocationFields,
    initiator: Schema.Literals(["person", "headless"]),
    operation: Schema.Struct({
      kind: Schema.Literal("launch"),
      input,
    }),
  });
}

const RuntimeWorkflowLaunchInvocationSchema = launchInvocationSchema(RuntimeWorkflowLaunchInputSchema);
const RuntimeWorkflowLaunchInvocationV2Schema = launchInvocationSchema(RuntimeWorkflowLaunchInputV2Schema);

const RuntimeWorkflowAdoptionInvocationSchema = Schema.Struct({
  ...RuntimeWorkflowInvocationFields,
  initiator: Schema.Literal("migration"),
  operation: Schema.Struct({
    kind: Schema.Literal("adoption"),
    workflowSessionId: Schema.NonEmptyString,
    workflowDefinitionId: Schema.NonEmptyString,
    summary: Schema.optionalKey(Schema.NonEmptyString),
  }),
});

/** A non-model workflow call recorded in the parent's ordinary tool timeline.
 *  The union prevents a migration reference from claiming launch input, and a
 *  direct launch from claiming historical adoption. An adoption records the
 *  words its card shows, the workflow's definition and goal, as a launch
 *  records its input, so every reader of the call input treats both alike. */
export const RuntimeWorkflowInvocationPayloadSchema = Schema.Union([
  RuntimeWorkflowLaunchInvocationSchema,
  RuntimeWorkflowAdoptionInvocationSchema,
]);

/** Historical shape. Its launch is the current launch, and its adoption
 *  records only the workflow id, so that card shows the tool name. Only
 *  unreleased builds after v0.0.12 wrote it. No conversion can add the
 *  words, because they live in the workflow's own metadata and an upgrade
 *  reads one payload. So the version stays readable as it is, and readers
 *  lower an adoption without words to an input that names only the
 *  workflow. Remove this registration after 2027-04-03. */
const ToolRuntimeInvocationRecordedV1 = defineRuntimeFact({
  type: "tool.runtime_invocation.recorded",
  version: 1,
  actor: "flywheel",
  payload: Schema.Union([
    RuntimeWorkflowLaunchInvocationV2Schema,
    Schema.Struct({
      ...RuntimeWorkflowInvocationFields,
      initiator: Schema.Literal("migration"),
      operation: Schema.Struct({
        kind: Schema.Literal("adoption"),
        workflowSessionId: Schema.NonEmptyString,
      }),
    }),
  ]),
});

/** Version 2 named the fixed model choices of a launch `steps`; its codec
 *  reads them as `agents`. Remove this registration after 2027-04-30. */
const ToolRuntimeInvocationRecordedV2 = defineRuntimeFact({
  type: "tool.runtime_invocation.recorded",
  version: 2,
  actor: "flywheel",
  payload: Schema.Union([
    RuntimeWorkflowLaunchInvocationV2Schema,
    RuntimeWorkflowAdoptionInvocationSchema,
  ]),
});

const ToolRuntimeInvocationRecordedV3 = defineRuntimeFact({
  type: "tool.runtime_invocation.recorded",
  version: 3,
  actor: "flywheel",
  payload: RuntimeWorkflowInvocationPayloadSchema,
});

const ToolResultRecorded = defineRuntimeFact({
  type: "tool.result.recorded",
  version: 1,
  actor: "flywheel",
  payload: Schema.Struct({
    toolUseId: Schema.NonEmptyString,
    outcome: Schema.Literals(TOOL_OUTCOME_VALUES),
    contentBytes: Schema.optionalKey(NonNegativeInt),
    contentSha256: Schema.optionalKey(Schema.String),
    contentPreview: Schema.optionalKey(Schema.String),
    /** Full nested-call result text. Nested results have no conversation-tree copy. */
    content: Schema.optionalKey(Schema.String),
    contentTruncated: Schema.optionalKey(Schema.Boolean),
    originalContentBytes: Schema.optionalKey(NonNegativeInt),
    originalContentSha256: Schema.optionalKey(Schema.String),
    fullContentPath: Schema.optionalKey(Schema.String),
    semanticOutputTruncated: Schema.optionalKey(Schema.Boolean),
    byteOutputTruncated: Schema.optionalKey(Schema.Boolean),
    modelRequestId: Schema.optionalKey(Schema.String),
    details: Schema.optionalKey(Schema.Unknown),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }).check(Schema.makeFilter((payload: { readonly content?: string; readonly parentToolUseId?: string }) =>
    nestedContentWithinCap(payload.content, payload.parentToolUseId))),
});

const WorkflowToolResultCorrected = defineRuntimeFact({
  type: "workflow.tool_result.corrected",
  version: 1,
  actor: "flywheel",
  payload: Schema.Struct({
    toolUseId: Schema.NonEmptyString,
    childSessionId: Schema.NonEmptyString,
    workflowDefinitionId: Schema.NonEmptyString,
    description: Schema.String,
    priorResultEventId: Schema.NonEmptyString,
    outcome: Schema.Union([Schema.Literal("ok"), Schema.Literal("error"), Schema.Literal("stopped"), Schema.Literal("cancelled")]),
    bytes: NonNegativeInt,
    sha256: Schema.String,
    preview: Schema.String,
  }),
});

/** The settled record of a command. An `mutates` command that settled after its
 *  result was recorded (a background or transferred command) also carries the
 *  project edits it published at exit; its result has no other place for them.
 *  `conflictMarkers` names the landed files that hold conflict markers, and
 *  `notApplied` the changes kept out of the project. Every field is an
 *  optional addition, so every earlier row still decodes. `conflicts` is
 *  read-only history: no producer writes it, and the mutation evidence recovery
 *  boundary converts it to retained refusal entries. */
const SettledProjectMutationFields = {
  mutation: Schema.optionalKey(MutationDiffSchema),
  conflicts: Schema.optionalKey(Schema.Array(Schema.String)),
  conflictMarkers: Schema.optionalKey(Schema.Array(Schema.String)),
  notApplied: Schema.optionalKey(NotAppliedFilesSchema),
};

const ToolExecutionOutputRecorded = defineRuntimeFact({
  type: "tool.execution_output.recorded",
  version: 1,
  actor: "flywheel",
  payload: Schema.Struct({
    toolUseId: Schema.NonEmptyString,
    output: Schema.String,
    modelRequestId: Schema.optionalKey(Schema.String),
    parentToolUseId: Schema.optionalKey(Schema.String),
    ...SettledProjectMutationFields,
  }),
});

// Tool text that may be stored as a session-scoped content-row reference
// instead of inline (tool output dedup). Inline stays valid at version 2, so a
// hydrated fact re-encodes losslessly as its version-1 inline equivalent.
const ToolContentTextSchema = Schema.Union([Schema.String, ToolContentReferenceSchema]);

/** Version 2 of `tool.result.recorded`: identical to version 1 except that
 *  `content` (and, inside the opaque `details`, `displayContent`) may be a
 *  tool-content reference instead of inline text. */
const ToolResultRecordedV2 = defineRuntimeFact({
  type: "tool.result.recorded",
  version: 2,
  actor: "flywheel",
  payload: Schema.Struct({
    toolUseId: Schema.NonEmptyString,
    outcome: Schema.Literals(TOOL_OUTCOME_VALUES),
    contentBytes: Schema.optionalKey(NonNegativeInt),
    contentSha256: Schema.optionalKey(Schema.String),
    contentPreview: Schema.optionalKey(Schema.String),
    /** Full nested-call result text, inline or referenced. Nested results have
     *  no conversation-tree copy. */
    content: Schema.optionalKey(ToolContentTextSchema),
    contentTruncated: Schema.optionalKey(Schema.Boolean),
    originalContentBytes: Schema.optionalKey(NonNegativeInt),
    originalContentSha256: Schema.optionalKey(Schema.String),
    fullContentPath: Schema.optionalKey(Schema.String),
    semanticOutputTruncated: Schema.optionalKey(Schema.Boolean),
    byteOutputTruncated: Schema.optionalKey(Schema.Boolean),
    modelRequestId: Schema.optionalKey(Schema.String),
    details: Schema.optionalKey(Schema.Unknown),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }).check(Schema.makeFilter((payload: { readonly content?: string | ToolContentReference; readonly parentToolUseId?: string }) =>
    nestedContentWithinCap(payload.content, payload.parentToolUseId))),
});

/** Version 2 of `tool.execution_output.recorded`: `output` may be a
 *  tool-content reference instead of inline text. */
const ToolExecutionOutputRecordedV2 = defineRuntimeFact({
  type: "tool.execution_output.recorded",
  version: 2,
  actor: "flywheel",
  payload: Schema.Struct({
    toolUseId: Schema.NonEmptyString,
    output: ToolContentTextSchema,
    modelRequestId: Schema.optionalKey(Schema.String),
    parentToolUseId: Schema.optionalKey(Schema.String),
    ...SettledProjectMutationFields,
  }),
});

/** Reference-backed mutation evidence with ordinary inline tool text. */
const ToolResultRecordedV3 = defineRuntimeFact({
  type: "tool.result.recorded", version: 3, actor: "flywheel",
  payload: evidenceResultPayload(Schema.String).check(Schema.makeFilter(payload =>
    nestedContentWithinCap(payload.content, payload.parentToolUseId))),
});
const ToolExecutionOutputRecordedV3 = defineRuntimeFact({
  type: "tool.execution_output.recorded", version: 3, actor: "flywheel",
  payload: evidenceOutputPayload(Schema.String),
});

/** The same mutation roots with ordinary tool text allowed to use content rows. */
const ToolResultRecordedV4 = defineRuntimeFact({
  type: "tool.result.recorded", version: 4, actor: "flywheel",
  payload: evidenceResultPayload(ToolContentTextSchema).check(Schema.makeFilter(payload =>
    nestedContentWithinCap(payload.content, payload.parentToolUseId))),
});
const ToolExecutionOutputRecordedV4 = defineRuntimeFact({
  type: "tool.execution_output.recorded", version: 4, actor: "flywheel",
  payload: evidenceOutputPayload(ToolContentTextSchema),
});

/** The reference-capable stored versions of the tool facts. Deliberately kept
 *  out of SESSION_RUNTIME_FACT_DEFINITIONS: projections consume only the
 *  hydrated inline shape (`hydrateToolContentFact` lowers a version-2 row to
 *  its version-1 inline equivalent before any strict projection parse), so
 *  reference-awareness never spreads past the hydration seam. These
 *  definitions are the write gate's and the hydrator's vocabulary for the
 *  stored shape. */
export const TOOL_CONTENT_REFERENCE_FACT_DEFINITIONS = [
  ToolResultRecordedV2,
  ToolExecutionOutputRecordedV2,
  ToolResultRecordedV4,
  ToolExecutionOutputRecordedV4,
] as const;

/** Version-1 inline counterparts of the reference-capable definitions. The
 *  one-time dedup migration decodes stored version-1 rows with these payload
 *  schemas before applying the same extraction the producer path applies at
 *  record(), so the rewrite reuses one field-walking authority. */
export const TOOL_CONTENT_INLINE_FACT_DEFINITIONS = [
  ToolResultRecorded,
  ToolExecutionOutputRecorded,
] as const;

type ToolContentReferenceFactDefinition = typeof TOOL_CONTENT_REFERENCE_FACT_DEFINITIONS[number];

/** Writer-facing type of the reference-capable stored versions. Producers
 *  record these through the session write gate; the type stays out of
 *  SessionRuntimeFact so projection consumers keep an inline-only vocabulary. */
export type ToolContentReferenceFact = ToolContentReferenceFactDefinition extends infer D
  ? D extends RuntimeFactDefinition
    ? {
        readonly type: D["type"];
        readonly version: D["version"];
        readonly actor: D["actor"];
        readonly payload: D["payload"]["Type"];
      }
    : never
  : never;

const ToolResultAcknowledged = defineRuntimeFact({
  type: "tool.result.acknowledged",
  version: 1,
  actor: "provider",
  payload: Schema.Struct({
    toolUseId: Schema.String,
    modelRequestId: Schema.optionalKey(Schema.String),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }),
});

const ToolValidationFailed = defineRuntimeFact({
  type: "tool.validation.failed",
  version: 1,
  actor: "flywheel",
  payload: Schema.Struct({
    toolUseId: Schema.String,
    toolName: Schema.String,
    input: UnknownRecordSchema,
    inputBytes: NonNegativeInt,
    inputSha256: Schema.String,
    inputPreview: Schema.String,
    executionMode: ToolExecutionModeSchema,
    traceKind: ToolTraceKindSchema,
    childHasOwnViewport: Schema.Boolean,
    reason: Schema.String,
    modelRequestId: Schema.optionalKey(Schema.String),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }),
});

const ModelContextMeasured = defineRuntimeFact({
  type: "model.context.measured",
  version: 1,
  actor: "provider",
  payload: Schema.Struct({
    promptTokens: Schema.Number,
    contextWindow: Schema.Number,
    // The context size of the next automatic reset, 0 when none can run. A
    // fact from before 2026-11-10 or from a writer outside the agent loop
    // states none, and a reader then falls back to the configured count.
    compactionTriggerTokens: Schema.optionalKey(Schema.Number),
    parentToolUseId: Schema.optionalKey(Schema.String),
  }),
});

const ModelUsageMeasuredV1 = defineRuntimeFact({
  type: "model.usage.measured",
  version: 1,
  actor: "provider",
  payload: ModelUsagePayloadV1,
});

const ModelUsageMeasuredV2 = defineRuntimeFact({
  type: "model.usage.measured",
  version: 2,
  actor: "provider",
  payload: ModelUsagePayloadV2,
});

const ModelUsageMeasuredV3 = defineRuntimeFact({
  type: "model.usage.measured",
  version: 3,
  actor: "provider",
  payload: ModelUsagePayloadV3,
});

const ModelUsageMeasuredV4 = defineRuntimeFact({
  type: "model.usage.measured",
  version: 4,
  actor: "provider",
  payload: ModelUsagePayloadV4,
});

/** Remove after 2027-04-30. An entry written before coverage existed. */
const ModelUsageMeasuredV5 = defineRuntimeFact({
  type: "model.usage.measured",
  version: 5,
  actor: "provider",
  payload: ModelUsagePayloadV5,
});

const ModelUsageMeasuredV6 = defineRuntimeFact({
  type: "model.usage.measured",
  version: 6,
  actor: "provider",
  payload: ModelUsagePayloadV6,
});

const BudgetStreamCompletedV1 = defineRuntimeFact({
  type: "budget.stream.completed",
  version: 1,
  actor: "flywheel",
  payload: Schema.Struct({ parentToolUseId: Schema.NonEmptyString }),
});

const BudgetStreamCompletedV2 = defineRuntimeFact({
  type: "budget.stream.completed",
  version: 2,
  actor: "flywheel",
  payload: Schema.Struct({ budgetStreamId: Schema.NonEmptyString }),
});

const BudgetProcessStarted = defineRuntimeFact({
  type: "budget.process.started",
  version: 1,
  actor: "flywheel",
  payload: Schema.Struct({ stepIndex: Schema.optionalKey(Schema.Number) }),
});

const BudgetInvocationRecorded = defineRuntimeFact({
  type: "budget.invocation.recorded",
  version: 1,
  actor: "flywheel",
  payload: Schema.Struct({ count: PositiveInt }),
});

const SessionDurationRecorded = defineRuntimeFact({
  type: "session.duration.recorded",
  version: 1,
  actor: "flywheel",
  payload: Schema.Struct({ accumulatedActiveMs: NonNegativeInt }),
});

const AgentRateLimitObserved = defineRuntimeFact({
  type: "agent.rate_limit.observed",
  version: 1,
  actor: "provider",
  payload: Schema.Struct({
    status: Schema.optionalKey(Schema.String),
    rateLimitType: Schema.optionalKey(Schema.String),
    utilization: Schema.optionalKey(Schema.Number),
    surpassedThreshold: Schema.optionalKey(Schema.Number),
    resetsAt: Schema.optionalKey(Schema.Number),
    isUsingOverage: Schema.optionalKey(Schema.Boolean),
  }),
});

const GenericDataFactPayload = Schema.Struct({ data: UnknownRecordSchema });

const DateTimeString = Schema.String.check(
  Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)) || "Expected ISO datetime string"),
);

/** The boundary of an agent's attempt that builds before 2026-10 wrote,
 *  when a workflow still had a transcript. No build writes it now and no
 *  reader reads it, but stored facts of it stay readable (HISTORY
 *  retention). */
const WorkflowWorkerBoundaryDataSchema = Schema.Struct({
  attemptId: Schema.String,
  timestamp: DateTimeString,
});

/** Version 1 of the boundary, which builds before the agent lexicon wrote:
 *  `stepId` held the attempt id. `type` and `sessionId` are decode-only:
 *  NDJSON-era facts echoed the event identity into the payload. Remove after
 *  2027-04-30. */
const WorkflowWorkerBoundaryDataV1Schema = Schema.Struct({
  stepId: Schema.String,
  timestamp: DateTimeString,
  type: Schema.optionalKey(Schema.String),
  sessionId: Schema.optionalKey(Schema.String),
});

/** Historical fact: the retired inline step tool wrote these. Nothing emits
 *  the type today; the registration survives so stored facts keep replaying
 *  their step boundaries into derived transcripts. */
export const WorkflowStepStartedDataSchema = Schema.Struct({
  label: Schema.String,
});

const BackgroundCommandFields = {
  toolUseId: Schema.NonEmptyString,
  processId: Schema.NonEmptyString,
  description: Schema.String,
  startedAtMs: NonNegativeInt,
  modelRequestId: Schema.optionalKey(Schema.String),
  parentToolUseId: Schema.optionalKey(Schema.String),
};

/** One background command of a session, as the background index lists it:
 *  `running` from when its registry tracks it, and `settled` with its
 *  outcome once it ends. `stopped` is a person's Stop and `cancelled` an
 *  agent's. One row remains for each command (`replace-latest-keyed` on the
 *  tool use id), and it carries no command output. */
export const BackgroundCommandRecordSchema = Schema.Union([
  Schema.Struct({ ...BackgroundCommandFields, state: Schema.Literal("running") }),
  Schema.Struct({
    ...BackgroundCommandFields,
    state: Schema.Literal("settled"),
    status: Schema.Literals(["completed", "failed", "stopped", "cancelled"]),
    exitCode: Schema.optionalKey(Schema.Int),
    settledAtMs: NonNegativeInt,
  }),
]);
export type BackgroundCommandRecord = typeof BackgroundCommandRecordSchema.Type;

const ToolBackgroundCommandRecorded = defineRuntimeFact({
  type: "tool.background_command.recorded",
  version: 1,
  actor: "flywheel",
  payload: BackgroundCommandRecordSchema,
});

const AgentErrorObserved = defineRuntimeFact({
  type: "agent.error.observed",
  version: 1,
  actor: "flywheel",
  payload: GenericDataFactPayload,
});

export const SESSION_RUNTIME_FACT_DEFINITIONS = [
  ModelUserMessageRecorded,
  ModelAssistantMessageRecorded,
  ModelTurnCompleted,
  ToolInputCompletedV1,
  ToolInputCompletedV2,
  ToolRuntimeInvocationRecordedV1,
  ToolRuntimeInvocationRecordedV2,
  ToolRuntimeInvocationRecordedV3,
  ToolResultRecorded,
  ToolResultRecordedV3,
  WorkflowToolResultCorrected,
  ToolExecutionOutputRecorded,
  ToolExecutionOutputRecordedV3,
  ToolBackgroundCommandRecorded,
  ToolResultAcknowledged,
  ToolValidationFailed,
  ModelContextMeasured,
  ModelUsageMeasuredV1,
  ModelUsageMeasuredV2,
  ModelUsageMeasuredV3,
  ModelUsageMeasuredV4,
  ModelUsageMeasuredV5,
  ModelUsageMeasuredV6,
  BudgetStreamCompletedV1,
  BudgetStreamCompletedV2,
  BudgetProcessStarted,
  BudgetInvocationRecorded,
  AgentRateLimitObserved,
  AgentErrorObserved,
  defineRuntimeFact({ type: "workflow.worker_boundary.recorded", version: 1, actor: "flywheel", payload: Schema.Struct({ data: WorkflowWorkerBoundaryDataV1Schema }) }),
  defineRuntimeFact({ type: "workflow.worker_boundary.recorded", version: 2, actor: "flywheel", payload: Schema.Struct({ data: WorkflowWorkerBoundaryDataSchema }) }),
  defineRuntimeFact({ type: "workflow.step.started", version: 1, actor: "workflow", payload: Schema.Struct({ data: WorkflowStepStartedDataSchema }) }),
  defineRuntimeFact({ type: "agent.subagent_model.selected", version: 1, actor: "flywheel", payload: GenericDataFactPayload }),
  defineRuntimeFact({ type: "agent.workflow_link.published", version: 1, actor: "flywheel", payload: GenericDataFactPayload }),
  defineRuntimeFact({ type: "agent.subagent.dispatched", version: 1, actor: "flywheel", payload: GenericDataFactPayload }),
  defineRuntimeFact({ type: "agent.subagent.queued", version: 1, actor: "flywheel", payload: GenericDataFactPayload }),
  defineRuntimeFact({ type: "agent.waiting_on_subagents.recorded", version: 1, actor: "flywheel", payload: GenericDataFactPayload }),
  // Historical only: the live wait_placeholder runtime event was retired (wait
  // calls now execute and record ordinary results), but old facts must decode.
  defineRuntimeFact({ type: "agent.wait_placeholder.dropped", version: 1, actor: "flywheel", payload: GenericDataFactPayload }),
  SessionDurationRecorded,
] as const;

type SessionRuntimeFactDefinition = typeof SESSION_RUNTIME_FACT_DEFINITIONS[number];

export type SessionRuntimeFact = SessionRuntimeFactDefinition extends infer D
  ? D extends RuntimeFactDefinition
    ? {
        readonly type: D["type"];
        readonly version: D["version"];
        readonly actor: D["actor"];
        readonly payload: D["payload"]["Type"];
      }
    : never
  : never;

/** The runtime invocation a writer records now. */
export type RuntimeWorkflowInvocationPayload = typeof RuntimeWorkflowInvocationPayloadSchema.Type;

/** A runtime invocation of any recorded version, as readers replay it. */
export type RecordedRuntimeInvocation = Extract<SessionRuntimeFact, { type: "tool.runtime_invocation.recorded" }>["payload"];

/** A `model.usage.measured` fact that carries one settled attempt's entry. */
export type SettledUsageMeasuredFact = Extract<SessionRuntimeFact, { type: "model.usage.measured"; version: 5 | 6 }>;
export type UsageMeasurement = Extract<SessionRuntimeFact, { type: "model.usage.measured"; version: 6 }>["payload"];

/** The current-shape entry of a settled usage fact. Version 5 predates coverage, and every v5 entry held the
 *  provider's final report, so it reads as complete. Remove the v5 conversion after 2027-04-30. */
export function currentUsageMeasurement(fact: SettledUsageMeasuredFact): UsageMeasurement {
  return fact.version === 6 ? fact.payload : { ...fact.payload, coverage: "complete" };
}
