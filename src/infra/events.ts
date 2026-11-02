import { Schema } from "effect";
import { RUNTIME_EVENT_DEFINITIONS, RUNTIME_EVENT_TYPES, type RuntimeEvent } from "./runtime-event-types.js";
import { ReferenceReviewNoticeFields, ReviewNoticeMutationSchema } from "./review-notice.js";
import { MessageSenderSchema } from "./output-blocks.js";
import { SESSION_NOTICE_PRESENTATION_IDS } from "./error-presentation.js";
import type { SessionNoticeOperation } from "./session-notice.js";

type EventId = string;
type SessionId = string;

type EventActor = "agent" | "flywheel" | "provider" | "user" | "workflow";

interface EventDefinition<
  T extends string = string,
  S extends { readonly Type: unknown } = { readonly Type: unknown },
> {
  readonly type: T;
  readonly version?: number;
  readonly actor?: EventActor;
  readonly data: S;
}

function defineEvent<const T extends string, const S extends { readonly Type: unknown }>(
  definition: EventDefinition<T, S>,
): EventDefinition<T, S> {
  return definition;
}

type EventCausality = {
  readonly runId?: string;
  readonly parentEventId?: EventId;
  readonly causedByEventId?: EventId;
  readonly traceparent?: string;
  readonly tracestate?: string;
};

type FlywheelEventEnvelope<T extends string, D> = {
  readonly id: EventId;
  readonly type: T;
  readonly version?: number;
  readonly sessionId: SessionId;
  readonly timestamp: number;
  readonly data: D;
  readonly causality?: EventCausality;
};

const EmptyDataSchema = Schema.Struct({});
const OptionalString = Schema.optionalKey(Schema.String);
const SessionNoticeOperationSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("upsert"),
    notice: Schema.Struct({
      id: Schema.String,
      scope: Schema.String,
      presentation: Schema.Literals(SESSION_NOTICE_PRESENTATION_IDS),
      severity: Schema.Union([Schema.Literal("info"), Schema.Literal("warning"), Schema.Literal("error")]),
      title: Schema.String,
      message: Schema.String,
      startedAt: Schema.optionalKey(Schema.Number),
      updatedAt: Schema.optionalKey(Schema.Number),
      retry: Schema.optionalKey(Schema.Struct({
        count: Schema.Number,
        maxRetries: Schema.optionalKey(Schema.Number),
        delayMs: Schema.optionalKey(Schema.Number),
        nextAttemptAt: Schema.optionalKey(Schema.Number),
      })),
      wait: Schema.optionalKey(Schema.Struct({
        agentName: Schema.String,
        continuesAt: Schema.Number,
      })),
      action: Schema.optionalKey(Schema.Struct({
        label: Schema.String,
        command: Schema.optionalKey(Schema.String),
      })),
    }),
  }),
  Schema.Struct({ type: Schema.Literal("resolve"), id: Schema.String }),
  Schema.Struct({ type: Schema.Literal("resolve-scope"), scope: Schema.String }),
]) satisfies { readonly Type: SessionNoticeOperation };

const AgentStarted = defineEvent({
  type: "agent.run.started",
  version: 1,
  actor: "flywheel",
  data: Schema.Struct({ stepIndex: Schema.Number, toolUseIds: Schema.optionalKey(Schema.Array(Schema.String)) }),
});

const AgentTurnParked = defineEvent({
  type: "agent.turn.parked",
  version: 1,
  actor: "agent",
  data: Schema.Struct({ handoffWritten: Schema.Boolean, turnCount: Schema.Number, activeBackgroundCount: Schema.Number, parkedOnBackgroundWork: Schema.Boolean, userResumeRequired: Schema.Boolean, park: Schema.Literals(["idle", "waiting_on_work", "interrupted"]) }),
});

const AgentTurnInterrupted = defineEvent({
  type: "agent.turn.interrupted",
  version: 1,
  actor: "user",
  data: EmptyDataSchema,
});

const AgentTurnResumed = defineEvent({
  type: "agent.turn.resumed",
  version: 1,
  actor: "user",
  data: EmptyDataSchema,
});

const AgentLogicalTurnStarted = defineEvent({
  type: "agent.logical_turn.started",
  version: 1,
  actor: "agent",
  data: Schema.Struct({
    origin: Schema.Union([Schema.Literal("user"), Schema.Literal("system"), Schema.Literal("background")]),
    reason: Schema.Union([Schema.Literal("new_input"), Schema.Literal("queued_input")]),
  }),
});

const AgentLogicalTurnEnded = defineEvent({
  type: "agent.logical_turn.ended",
  version: 1,
  actor: "agent",
  data: Schema.Struct({ status: Schema.Union([Schema.Literal("completed"), Schema.Literal("paused")]) }),
});

const AgentAwaitingUser = defineEvent({
  type: "agent.user_input.awaiting",
  version: 1,
  actor: "agent",
  data: EmptyDataSchema,
});

const AgentResumedFromUser = defineEvent({
  type: "agent.user_input.resumed",
  version: 1,
  actor: "user",
  data: EmptyDataSchema,
});

export const AgentSystemMessageV1DataSchema = Schema.Struct({
  message: Schema.String,
  level: Schema.optionalKey(Schema.Union([Schema.Literal("info"), Schema.Literal("error")])),
  /** Present only on a learning review notice: the skill writes the
   *  message reports, each with the artifact of what it changed. The live
   *  display path reads it so a notice carries the same evidence it does
   *  after a reload from the conversation tree. */
  reviewMutations: Schema.optionalKey(Schema.Array(ReviewNoticeMutationSchema)),
});
const AgentSystemMessage = defineEvent({
  type: "agent.system_message.recorded",
  version: 1,
  actor: "flywheel",
  data: AgentSystemMessageV1DataSchema,
});

/** Current review notices carry one ordered evidence manifest. */
export const AgentSystemMessageV2DataSchema = Schema.Struct({
  message: Schema.String,
  level: Schema.optionalKey(Schema.Union([Schema.Literal("info"), Schema.Literal("error")])),
  ...ReferenceReviewNoticeFields,
});
const AgentSystemMessageV2 = defineEvent({
  type: "agent.system_message.recorded",
  version: 2,
  actor: "flywheel",
  data: AgentSystemMessageV2DataSchema,
});

const AgentNotice = defineEvent({
  type: "agent.notice.changed",
  version: 1,
  actor: "flywheel",
  data: Schema.Struct({ operation: SessionNoticeOperationSchema }),
});

const AgentInjected = defineEvent({
  type: "agent.message.injected",
  version: 1,
  actor: "flywheel",
  data: Schema.Struct({
    message: Schema.String,
    origin: Schema.Union([Schema.Literal("user"), Schema.Literal("system")]),
    pending: Schema.optionalKey(Schema.Boolean),
    /** The identities the sending client shows this message under, so its
     *  local copy retires when this one shows. */
    submissionIds: Schema.optionalKey(Schema.Array(Schema.String)),
    /** Workflow input cells that identify this echo before an agent adopts it. */
    dispatchIds: Schema.optionalKey(Schema.Array(Schema.String)),
    /** The session that sent the message, when one did. */
    from: Schema.optionalKey(MessageSenderSchema),
  }),
});

const BudgetMetricsChanged = defineEvent({
  type: "budget.metrics.changed",
  version: 1,
  actor: "flywheel",
  data: Schema.Struct({ tokens: Schema.Number, cost: Schema.Number, billedCost: Schema.Number, priceUnavailable: Schema.Boolean, contextPercent: Schema.Number, contextPromptTokens: Schema.Number }),
});

const BudgetExhausted = defineEvent({
  type: "budget.exhausted",
  version: 1,
  actor: "flywheel",
  data: Schema.Struct({ reason: Schema.String }),
});

const WorkflowInitialized = defineEvent({
  type: "workflow.run.initialized",
  version: 1,
  actor: "workflow",
  data: Schema.Struct({ attemptIds: Schema.Array(Schema.String) }),
});

const WorkflowCompleted = defineEvent({
  type: "workflow.run.completed",
  version: 1,
  actor: "workflow",
  data: Schema.Struct({
    attemptsCompleted: Schema.Number,
  }),
});

// A pause is non-terminal: the run stopped before finishing (shutdown,
// recoverable error, user interrupt) and is resumable from the paused
// attempt. It is NOT a failure, so it rides its own channel; consumers read
// the event kind, never a finalStatus discriminator inside `failed`.
const WorkflowPaused = defineEvent({
  type: "workflow.run.paused",
  version: 1,
  actor: "workflow",
  data: Schema.Struct({
    reason: Schema.String,
    attemptsCompleted: Schema.Number,
  }),
});

const WorkflowFailed = defineEvent({
  type: "workflow.run.failed",
  version: 1,
  actor: "workflow",
  data: Schema.Struct({
    reason: Schema.String,
    attemptsCompleted: Schema.Number,
  }),
});

const AttemptEventDataSchema = Schema.Struct({ attemptId: Schema.String, agentName: Schema.String });
const AttemptStarted = defineEvent({
  type: "workflow.attempt.started",
  version: 1,
  actor: "workflow",
  data: AttemptEventDataSchema,
});
const AttemptCompleted = defineEvent({
  type: "workflow.attempt.completed",
  version: 1,
  actor: "workflow",
  data: Schema.Struct({ ...AttemptEventDataSchema.fields, resultSummary: Schema.optionalKey(Schema.String) }),
});
const AttemptFailed = defineEvent({
  type: "workflow.attempt.failed",
  version: 1,
  actor: "workflow",
  data: Schema.Struct({ ...AttemptEventDataSchema.fields, reason: Schema.String }),
});
const AttemptInterrupted = defineEvent({
  type: "workflow.attempt.interrupted",
  version: 1,
  actor: "workflow",
  data: Schema.Struct({ ...AttemptEventDataSchema.fields, reason: Schema.String }),
});

const TraceToolIdentitySchema = {
  executionMode: Schema.optionalKey(Schema.Union([Schema.Literal("foreground"), Schema.Literal("background")])),
  traceKind: Schema.optionalKey(Schema.Union([Schema.Literal("tool"), Schema.Literal("subagent")])),
  modelRequestId: OptionalString,
  parentToolUseId: OptionalString,
};

const TraceToolStarted = defineEvent({
  type: "trace.tool.started",
  version: 1,
  actor: "flywheel",
  data: Schema.Struct({
    toolUseId: Schema.String,
    toolName: Schema.String,
    toolInput: Schema.String,
    ...TraceToolIdentitySchema,
  }),
});

const TraceToolCompleted = defineEvent({
  type: "trace.tool.completed",
  version: 1,
  actor: "flywheel",
  data: Schema.Struct({
    toolUseId: Schema.String,
    toolOutput: Schema.String,
    isError: Schema.Boolean,
    ...TraceToolIdentitySchema,
  }),
});

const TraceSubagentStarted = defineEvent({
  type: "trace.subagent.started",
  version: 1,
  actor: "flywheel",
  data: Schema.Struct({
    toolUseId: Schema.String,
    agentType: Schema.String,
    description: Schema.String,
    prompt: Schema.String,
    model: Schema.String,
    ...TraceToolIdentitySchema,
  }),
});

const TraceSubagentCompleted = defineEvent({
  type: "trace.subagent.completed",
  version: 1,
  actor: "flywheel",
  data: Schema.Struct({
    toolUseId: Schema.String,
    result: Schema.String,
    isError: Schema.Boolean,
    ...TraceToolIdentitySchema,
  }),
});

const RuntimeEventDefinitions = RUNTIME_EVENT_DEFINITIONS.map((definition) => ({
  ...definition,
  version: 1,
}));

const FLYWHEEL_EVENT_DEFINITIONS = [
  AgentStarted,
  AgentTurnParked,
  AgentTurnInterrupted,
  AgentTurnResumed,
  AgentLogicalTurnStarted,
  AgentLogicalTurnEnded,
  AgentAwaitingUser,
  AgentResumedFromUser,
  AgentSystemMessage,
  AgentSystemMessageV2,
  AgentNotice,
  AgentInjected,
  BudgetMetricsChanged,
  BudgetExhausted,
  WorkflowInitialized,
  WorkflowCompleted,
  WorkflowPaused,
  WorkflowFailed,
  AttemptStarted,
  AttemptCompleted,
  AttemptFailed,
  AttemptInterrupted,
  TraceToolStarted,
  TraceToolCompleted,
  TraceSubagentStarted,
  TraceSubagentCompleted,
  ...RuntimeEventDefinitions,
] as const;

export type FlywheelEventType = typeof FLYWHEEL_EVENT_DEFINITIONS[number]["type"];
type RuntimeEventType = RuntimeEvent["type"];
type DefinedEventData<T extends FlywheelEventType> = Extract<typeof FLYWHEEL_EVENT_DEFINITIONS[number], { type: T }>["data"]["Type"];
type RuntimeEventData<T extends RuntimeEventType> = Extract<RuntimeEvent, { type: T }>["data"];
export type FlywheelEventFor<T extends FlywheelEventType> = FlywheelEventEnvelope<
  T,
  T extends RuntimeEventType ? RuntimeEventData<T> : DefinedEventData<T>
>;
export type FlywheelEventData<T extends FlywheelEventType> = FlywheelEventFor<T>["data"];
export type FlywheelEvent = { [T in FlywheelEventType]: FlywheelEventFor<T> }[FlywheelEventType];

export const FLYWHEEL_EVENT_TYPES: readonly FlywheelEventType[] = [...new Set(FLYWHEEL_EVENT_DEFINITIONS.map(
  (definition) => definition.type,
))];

const RUNTIME_EVENT_TYPE_SET: ReadonlySet<FlywheelEventType> = new Set(RUNTIME_EVENT_TYPES);

/** Strips a FlywheelEvent envelope of a runtime type down to its RuntimeEvent.
 * Throws on non-runtime types: the substrate wrote a malformed subscription. */
export function toRuntimeEvent(event: Pick<FlywheelEvent, "type" | "data">): RuntimeEvent {
  if (!RUNTIME_EVENT_TYPE_SET.has(event.type)) {
    throw new Error(`toRuntimeEvent received non-runtime event type: ${event.type}`);
  }
  // SAFETY: the guard above admits only RUNTIME_EVENT_TYPES, and each FlywheelEvent
  // of a runtime type is built with `data: RuntimeEventData<T>` (the exact per-type
  // data of the matching RuntimeEvent member), so {type,data} is a valid RuntimeEvent.
  // TS cannot correlate the type/data pair across the pre-unioned event, so the
  // union is reconstructed here.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the runtime type guard preserves the discriminated type and data correlation
  return { type: event.type, data: event.data } as RuntimeEvent;
}
