import { Schema } from "effect";
import { UsageEntrySchema } from "./llm/usage-entry.js";
import { LlmToolOutputPartSchema } from "./llm/tool-output-part-schema.js";
import { ContentBlockSchema } from "./runtime-content-blocks.js";
import { TOOL_OUTCOME_VALUES } from "./tool-outcome.js";
import { MutationEvidenceSchema } from "./mutation-evidence-schema.js";
import { MutationEvidenceResultDetailsSchema } from "./runtime-mutation-evidence.js";
// External boundary (agent/provider runtime streams): `.passthrough()` is the contract —
// provider events carry extra fields we must not reject (ARCH-BOUNDARIES-001). Each payload type is the
// schema's inferred `.Type`, so the schema is the single source of truth for both shape and parse.
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown);
const ToolInputExecutionSchema = Schema.Struct({
  mode: Schema.Union([Schema.Literal("foreground"), Schema.Literal("background")]),
  trace_kind: Schema.Union([Schema.Literal("tool"), Schema.Literal("subagent")]),
  child_has_own_viewport: Schema.optionalKey(Schema.Boolean),
});
const UsageSchema = Schema.StructWithRest(Schema.Struct({
  input_tokens: Schema.optionalKey(Schema.Number),
  output_tokens: Schema.optionalKey(Schema.Number),
  cache_read_input_tokens: Schema.optionalKey(Schema.Number),
  cache_creation_input_tokens: Schema.optionalKey(Schema.Number),
  reasoning_tokens: Schema.optionalKey(Schema.Number),
}), [UnknownRecordSchema]);
// Producers emit usage by name (emit.ts): the open index signature lives here,
// at the schema, so emitters need no defensive copy to satisfy the decoded shape.
export type UsageData = typeof UsageSchema.Type;
export const AssistantEventDataSchema = Schema.StructWithRest(Schema.Struct({
  entry_id: Schema.optionalKey(Schema.String),
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.optionalKey(Schema.StructWithRest(Schema.Struct({
    content: Schema.optionalKey(Schema.mutable(Schema.Array(ContentBlockSchema))),
    usage: Schema.optionalKey(UsageSchema),
  }), [UnknownRecordSchema])),
}), [UnknownRecordSchema]);
export type AssistantEventData = typeof AssistantEventDataSchema.Type;
const ToolResultFields = {
  tool_use_id: Schema.optionalKey(Schema.String),
  is_error: Schema.optionalKey(Schema.Boolean),
  interrupted: Schema.optionalKey(Schema.Boolean),
  // Flywheel's own emitters set the full in-process outcome ("blocked" is not
  // representable as is_error/interrupted); external SDK-shaped streams omit it.
  outcome: Schema.optionalKey(Schema.Literals(TOOL_OUTCOME_VALUES)),
  content: Schema.optionalKey(Schema.mutable(Schema.Array(LlmToolOutputPartSchema)).check(Schema.isNonEmpty())),
  details: Schema.optionalKey(Schema.Unknown),
  model_request_id: Schema.optionalKey(Schema.String),
  content_bytes: Schema.optionalKey(Schema.Number),
  content_sha256: Schema.optionalKey(Schema.String),
  content_truncated: Schema.optionalKey(Schema.Boolean),
  original_content_bytes: Schema.optionalKey(Schema.Number),
  original_content_sha256: Schema.optionalKey(Schema.String),
  full_content_path: Schema.optionalKey(Schema.String),
  semantic_output_truncated: Schema.optionalKey(Schema.Boolean),
  byte_output_truncated: Schema.optionalKey(Schema.Boolean),
};
const UserEventToolResultSchema = Schema.StructWithRest(Schema.Struct({
  type: Schema.Literal("tool.result.recorded"),
  ...ToolResultFields,
}), [UnknownRecordSchema]);
export const ToolResultEventDataSchema = Schema.StructWithRest(Schema.Struct({
  ...ToolResultFields,
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [UnknownRecordSchema]);

/** Current mutation result boundary. Earlier streams keep the literal schema above. */
export const ToolResultEventDataV2Schema = Schema.StructWithRest(Schema.Struct({
  ...ToolResultFields,
  details: Schema.optionalKey(MutationEvidenceResultDetailsSchema),
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [UnknownRecordSchema]);
export const ToolResultAckDataSchema = Schema.StructWithRest(Schema.Struct({
  tool_use_id: Schema.String,
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model_request_id: Schema.optionalKey(Schema.String),
}), [UnknownRecordSchema]);
export const ToolResultAvailableDataSchema = Schema.Struct({
  tool_use_id: Schema.String,
  content: Schema.mutable(Schema.Array(LlmToolOutputPartSchema)).check(Schema.isNonEmpty()),
  outcome: Schema.Literals(TOOL_OUTCOME_VALUES),
  details: Schema.optionalKey(Schema.Unknown),
  content_truncated: Schema.optionalKey(Schema.Boolean),
  original_content_bytes: Schema.optionalKey(Schema.Number),
  original_content_sha256: Schema.optionalKey(Schema.String),
  full_content_path: Schema.optionalKey(Schema.String),
  semantic_output_truncated: Schema.optionalKey(Schema.Boolean),
  byte_output_truncated: Schema.optionalKey(Schema.Boolean),
  execution_output_tail: Schema.optionalKey(Schema.String),
});
export const ToolFailedValidationDataSchema = Schema.StructWithRest(Schema.Struct({
  tool_use_id: Schema.String,
  tool_name: Schema.String,
  input: UnknownRecordSchema,
  reason: Schema.String,
  execution: Schema.optionalKey(ToolInputExecutionSchema),
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model_request_id: Schema.optionalKey(Schema.String),
}), [UnknownRecordSchema]);
export const ResultEventDataSchema = Schema.StructWithRest(Schema.Struct({
  session_id: Schema.optionalKey(Schema.String),
  is_error: Schema.optionalKey(Schema.Boolean),
  subtype: Schema.optionalKey(Schema.String),
  result: Schema.optionalKey(Schema.String),
  total_cost_usd: Schema.optionalKey(Schema.Number),
  billed_cost_usd: Schema.optionalKey(Schema.Number),
  usage: Schema.optionalKey(UsageSchema),
  modelUsage: Schema.optionalKey(Schema.Record(Schema.String, Schema.StructWithRest(Schema.Struct({
    contextWindow: Schema.optionalKey(Schema.Number),
  }), [UnknownRecordSchema]))),
  parent_tool_use_id: Schema.optionalKey(Schema.String),
}), [UnknownRecordSchema]);
export const ContextUpdateEventDataSchema = Schema.StructWithRest(Schema.Struct({
  context_prompt_tokens: Schema.Number,
  context_window: Schema.Number,
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [UnknownRecordSchema]);
// Internal Flywheel-produced mirror of one committed canonical usage entry.
export const UsageMeasuredEventDataSchema = Schema.Struct({
  usage_entry: UsageEntrySchema,
  parent_tool_use_id: Schema.optionalKey(Schema.String),
  budget_stream_id: Schema.NonEmptyString,
});
export const RateLimitEventDataSchema = Schema.StructWithRest(Schema.Struct({
  rate_limit_info: Schema.optionalKey(Schema.StructWithRest(Schema.Struct({
    status: Schema.optionalKey(Schema.String),
    rateLimitType: Schema.optionalKey(Schema.String),
    utilization: Schema.optionalKey(Schema.Number),
    surpassedThreshold: Schema.optionalKey(Schema.Number),
    resetsAt: Schema.optionalKey(Schema.Number),
    isUsingOverage: Schema.optionalKey(Schema.Boolean),
  }), [UnknownRecordSchema])),
}), [UnknownRecordSchema]);
export type RateLimitEventData = typeof RateLimitEventDataSchema.Type;
export const ContentBlockDeltaDataSchema = Schema.StructWithRest(Schema.Struct({
  delta: Schema.optionalKey(Schema.StructWithRest(Schema.Struct({
    type: Schema.String,
    thinking: Schema.optionalKey(Schema.String),
    presentation: Schema.optionalKey(Schema.Literal("progress")),
    text: Schema.optionalKey(Schema.String),
    estimated_tokens: Schema.optionalKey(Schema.Number),
    provisional_block_key: Schema.optionalKey(Schema.String),
  }), [UnknownRecordSchema])),
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  block_key: Schema.optionalKey(Schema.String),
}), [UnknownRecordSchema]);
export const TextReconciledDataSchema = Schema.StructWithRest(Schema.Struct({
  content: Schema.String,
  provisional_block_key: Schema.optionalKey(Schema.String),
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  block_key: Schema.String,
}), [UnknownRecordSchema]);
export const TextCompleteDataSchema = Schema.StructWithRest(Schema.Struct({
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  block_key: Schema.optionalKey(Schema.String),
}), [UnknownRecordSchema]);
export const ToolInputDeltaDataSchema = Schema.StructWithRest(Schema.Struct({
  tool_use_id: Schema.String,
  partial_json: Schema.String,
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model_request_id: Schema.optionalKey(Schema.String),
}), [UnknownRecordSchema]);
export const ToolPreviewCheckDataSchema = Schema.Struct({
  tool_use_id: Schema.String,
  operation: Schema.Union([
    Schema.Struct({ type: Schema.Literal("set"), advice: Schema.String }),
    Schema.Struct({ type: Schema.Literal("clear") }),
  ]),
});
export const ToolExecutionOutputDeltaDataSchema = Schema.StructWithRest(Schema.Struct({
  tool_use_id: Schema.String,
  output: Schema.String,
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model_request_id: Schema.optionalKey(Schema.String),
}), [UnknownRecordSchema]);
export const ToolExecutionOutputRecordedDataV2Schema = Schema.StructWithRest(Schema.Struct({
  tool_use_id: Schema.String,
  output: Schema.String,
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model_request_id: Schema.optionalKey(Schema.String),
  mutationEvidence: Schema.optionalKey(MutationEvidenceSchema),
  mutation: Schema.optionalKey(Schema.Never),
  conflict_markers: Schema.optionalKey(Schema.Never),
  not_applied: Schema.optionalKey(Schema.Never),
}), [UnknownRecordSchema]);
export type ToolExecutionOutputEventDataV2 = typeof ToolExecutionOutputRecordedDataV2Schema.Type;
export const ToolInputCompleteDataSchema = Schema.StructWithRest(Schema.Struct({
  tool_use: Schema.StructWithRest(Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    input: UnknownRecordSchema,
    execution: Schema.optionalKey(ToolInputExecutionSchema),
    provider_call_id: Schema.optionalKey(Schema.String),
    provider_tool_name: Schema.optionalKey(Schema.String),
    executable_tool_name: Schema.optionalKey(Schema.String),
  }), [UnknownRecordSchema]),
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  model_request_id: Schema.optionalKey(Schema.String),
}), [UnknownRecordSchema]);
export const UserEventDataSchema = Schema.StructWithRest(Schema.Struct({
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.optionalKey(Schema.StructWithRest(Schema.Struct({
    content: Schema.optionalKey(Schema.Union([
      Schema.Array(Schema.Union([UserEventToolResultSchema, UnknownRecordSchema])),
      Schema.String,
    ])),
    origin: Schema.optionalKey(Schema.Union([Schema.Literal("user"), Schema.Literal("system")])),
    submissionIds: Schema.optionalKey(Schema.Array(Schema.String)),
    dispatchIds: Schema.optionalKey(Schema.Array(Schema.String)),
  }), [UnknownRecordSchema])),
}), [UnknownRecordSchema]);
export const GenericEventDataSchema = UnknownRecordSchema;
export const StreamAbandonedDataSchema = Schema.StructWithRest(Schema.Struct({
  reason: Schema.Literals(["failed", "interrupted", "retry"]),
  parent_tool_use_id: Schema.optionalKey(Schema.String),
}), [UnknownRecordSchema]);
export type GenericEventData = typeof GenericEventDataSchema.Type;
export const CompactionStartedDataSchema = Schema.StructWithRest(Schema.Struct({
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [UnknownRecordSchema]);
export const CompactionProgressedDataSchema = Schema.StructWithRest(Schema.Struct({
  output_chars: Schema.Number,
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [UnknownRecordSchema]);
export const CompactionCompletedDataSchema = Schema.StructWithRest(Schema.Struct({
  status: Schema.Union([Schema.Literal("completed"), Schema.Literal("failed")]),
  duration_ms: Schema.optionalKey(Schema.Number),
  output_chars: Schema.optionalKey(Schema.Number),
  tokens_before: Schema.optionalKey(Schema.Number),
  tokens_after: Schema.optionalKey(Schema.Number),
  parent_tool_use_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
}), [UnknownRecordSchema]);
export const BudgetStreamCompletedDataSchema = Schema.Struct({
  parent_tool_use_id: Schema.optionalKey(Schema.NonEmptyString),
  budget_stream_id: Schema.optionalKey(Schema.NonEmptyString),
}).check(Schema.makeFilter((payload) =>
  Number(payload.parent_tool_use_id !== undefined) + Number(payload.budget_stream_id !== undefined) === 1
  || "exactly one budget stream identity is required"));

export type AgentErrorEventData = typeof GenericEventDataSchema.Type;
export type BudgetStreamCompletedEventData = typeof BudgetStreamCompletedDataSchema.Type;
export type ContextUpdateEventData = typeof ContextUpdateEventDataSchema.Type;
export type RuntimeDataFactEventData = typeof GenericEventDataSchema.Type;
export type ToolCallEventData = typeof ToolInputCompleteDataSchema.Type;
export type ToolFailedValidationEventData = typeof ToolFailedValidationDataSchema.Type;
export type ToolResultEventData = typeof ToolResultEventDataSchema.Type;
export type ToolResultAckEventData = typeof ToolResultAckDataSchema.Type;
export type TurnResultEventData = typeof ResultEventDataSchema.Type;
export type UsageMeasuredEventData = typeof UsageMeasuredEventDataSchema.Type;
export type WorkflowEventData = typeof GenericEventDataSchema.Type;
