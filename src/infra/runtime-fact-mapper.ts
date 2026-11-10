import { Schema } from "effect"
import { assertNever } from "./assert-never.js"
import { contentEvidence, previewText, type ContentEvidence } from "./content-evidence.js"
import { redactDurableToolInput, type DurableToolInput } from "./durable-tool-input.js"
import { InvariantViolation } from "./invariant.js"
import type { LlmToolOutputPart } from "./llm/tool-output-part-schema.js"
import {
  BackgroundCommandRecordSchema,
  type BackgroundCommandRecord,
  type SessionRuntimeFact,
  WorkflowStepStartedDataSchema,
} from "./runtime-fact-types.js"
import { MutationEvidenceResultDetailsSchema, MAX_NESTED_RESULT_CONTENT_BYTES } from "./runtime-mutation-evidence.js"
import {
  AssistantEventDataSchema,
  BudgetStreamCompletedDataSchema,
  CompactionCompletedDataSchema,
  CompactionProgressedDataSchema,
  CompactionStartedDataSchema,
  ContentBlockDeltaDataSchema,
  ContextUpdateEventDataSchema,
  GenericEventDataSchema,
  StreamAbandonedDataSchema,
  RateLimitEventDataSchema,
  ResultEventDataSchema,
  TextCompleteDataSchema,
  TextReconciledDataSchema,
  ToolExecutionOutputDeltaDataSchema,
  ToolExecutionOutputRecordedDataV2Schema,
  ToolFailedValidationDataSchema,
  ToolInputCompleteDataSchema,
  ToolInputDeltaDataSchema,
  ToolPreviewCheckDataSchema,
  ToolResultAckDataSchema,
  ToolResultAvailableDataSchema,
  ToolResultEventDataSchema,
  UsageMeasuredEventDataSchema,
  UserEventDataSchema,
  type AgentErrorEventData,
  type BudgetStreamCompletedEventData,
  type ContextUpdateEventData,
  type RateLimitEventData,
  type RuntimeDataFactEventData,
  type ToolCallEventData,
  type ToolExecutionOutputEventDataV2,
  type ToolFailedValidationEventData,
  type ToolResultAckEventData,
  type ToolResultEventData,
  type TurnResultEventData,
  type UsageMeasuredEventData,
  type WorkflowEventData,
} from "./runtime-event-payload-types.js"
import { toolOutcomeFromProvider } from "./tool-outcome.js"


interface ToolExecutionInput {
  mode: "foreground" | "background"
  trace_kind: "tool" | "subagent"
  child_has_own_viewport?: boolean
}

type MapperEvent<T extends string, D> = { type: T; data: D }

type RuntimeEvent = RuntimeEventFor<typeof RUNTIME_EVENT_DEFINITIONS[number]>

export function mapRuntimeEventToSessionRuntimeFacts(event: RuntimeEvent): SessionRuntimeFact[] {
  return mapThroughChannel(event, runtimeEventDefinitionsByType.get(event.type)?.durable)
}

/** Maps a runtime event to its diagnostic records: the same typed shapes as
 *  the durable mapping, destined for the debug log instead of the store. */
export function mapRuntimeEventToDebugRecords(event: RuntimeEvent): SessionRuntimeFact[] {
  return mapThroughChannel(event, runtimeEventDefinitionsByType.get(event.type)?.debug)
}

function mapThroughChannel(
  event: RuntimeEvent,
  mapper: ((input: never) => SessionRuntimeFact[]) | undefined,
): SessionRuntimeFact[] {
  if (!mapper) return []
  // SAFETY: The indexed mapper is attached to the definition with this event discriminant.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry lookup preserves the event and mapper correlation
  return (mapper as (input: RuntimeEvent) => SessionRuntimeFact[])(event)
}

function mapAgentError(event: MapperEvent<"agent.error.observed", AgentErrorEventData>): SessionRuntimeFact[] {
  return [recordDataFact("agent.error.observed", event.data)]
}

// These workflow facts decode at the writer gate so malformed runtime data cannot enter durable history.
function mapWorkflowStepStarted(event: MapperEvent<"workflow.step.started", WorkflowEventData>): SessionRuntimeFact[] {
  return [{
    type: "workflow.step.started",
    version: 1,
    actor: "workflow",
    payload: { data: Schema.decodeUnknownSync(WorkflowStepStartedDataSchema, { onExcessProperty: "error" })(event.data) },
  }]
}

type DataFactEventType =
  | "agent.workflow_link.published"
  | "agent.waiting_on_subagents.recorded"

function mapRuntimeDataFact<T extends DataFactEventType>(event: MapperEvent<T, RuntimeDataFactEventData>): SessionRuntimeFact[] {
  return [recordDataFact(event.type, event.data)]
}

function mapTurnResult(event: MapperEvent<"model.turn.completed", TurnResultEventData>): SessionRuntimeFact[] {
  return [{
    type: "model.turn.completed",
    version: 1,
    actor: "provider",
    payload: {
      ...(event.data.session_id ? { providerSessionId: event.data.session_id } : {}),
      isError: event.data.is_error === true,
      ...(event.data.subtype ? { subtype: event.data.subtype } : {}),
      ...(event.data.result ? { result: event.data.result } : {}),
      ...(typeof event.data.total_cost_usd === "number" ? { totalCostUsd: event.data.total_cost_usd } : {}),
      ...(typeof event.data.billed_cost_usd === "number" ? { billedCostUsd: event.data.billed_cost_usd } : {}),
      ...(event.data.usage ? { usage: event.data.usage } : {}),
      ...(event.data.modelUsage ? { modelUsage: event.data.modelUsage } : {}),
      ...(event.data.parent_tool_use_id ? { parentToolUseId: event.data.parent_tool_use_id } : {}),
    },
  }]
}

function mapToolCall(event: MapperEvent<"tool.input.completed", ToolCallEventData>): SessionRuntimeFact[] {
  const input = redactDurableToolInput(event.data.tool_use.name, event.data.tool_use.input)
  const inputPolicy = jsonPolicy(input)
  const execution = requireToolExecution(event.data.tool_use.execution, "tool.input.completed", event.data.tool_use.name)
  const modelRequestId = event.data.model_request_id
  const providerCallId = event.data.tool_use.provider_call_id
  const providerToolName = event.data.tool_use.provider_tool_name
  const executableToolName = event.data.tool_use.executable_tool_name
  if (!modelRequestId || !providerCallId || !providerToolName || !executableToolName) {
    throw new InvariantViolation({
      kind: "schema-mismatch",
      eventType: "tool.input.completed",
      eventPosition: -1,
      aggregateId: "",
      detail: "canonical tool input requires request, provider call, provider name, and executable identity",
    })
  }
  return [{
    type: "tool.input.completed",
    version: 2,
    actor: "agent",
    payload: {
      toolUseId: event.data.tool_use.id,
      providerCallId,
      providerToolName,
      toolName: executableToolName,
      modelRequestId,
      input,
      inputBytes: inputPolicy.bytes,
      inputSha256: inputPolicy.sha256,
      inputPreview: inputPolicy.preview,
      executionMode: execution.mode,
      traceKind: execution.trace_kind,
      childHasOwnViewport: execution.child_has_own_viewport === true,
      ...(event.data.parent_tool_use_id ? { parentToolUseId: event.data.parent_tool_use_id } : {}),
    },
  }]
}

function mapToolResult(event: MapperEvent<"tool.result.recorded", ToolResultEventData>): SessionRuntimeFact[] {
  const toolUseId = event.data.tool_use_id
  if (typeof toolUseId !== "string" || toolUseId.length === 0) {
    throw new InvariantViolation({
      kind: "schema-mismatch",
      eventType: "tool.result.recorded",
      eventPosition: -1,
      aggregateId: "",
      detail: `tool.result.recorded event missing tool_use_id (got ${JSON.stringify(toolUseId)})`,
    })
  }
  const serializedContent = toolResultContent(event.data.content)
  // A producer that measured the content in bounded units passes the bytes and
  // the digest together, so this mapper hashes only content nobody measured.
  const measured = event.data.content_bytes !== undefined && event.data.content_sha256 !== undefined
    ? { bytes: event.data.content_bytes, sha256: event.data.content_sha256 }
    : contentEvidence(serializedContent)
  const nestedContent = event.data.parent_tool_use_id ? cappedNestedResultContent(serializedContent, measured.bytes) : undefined
  return [{
    type: "tool.result.recorded",
    version: 3,
    actor: "flywheel",
    payload: {
      toolUseId,
      outcome: event.data.outcome ?? toolOutcomeFromProvider(event.data.is_error, event.data.interrupted),
      contentBytes: measured.bytes,
      contentSha256: measured.sha256,
      contentPreview: previewText(serializedContent),
      // Nested result text has no conversation-tree home. This fact is its sole durable authority, not a cache.
      ...(nestedContent ? { content: nestedContent.content } : {}),
      contentTruncated: (event.data.content_truncated ?? false) || nestedContent?.truncated === true,
      originalContentBytes: event.data.original_content_bytes ?? measured.bytes,
      originalContentSha256: event.data.original_content_sha256 ?? measured.sha256,
      ...(event.data.full_content_path ? { fullContentPath: event.data.full_content_path } : {}),
      ...(event.data.semantic_output_truncated !== undefined ? { semanticOutputTruncated: event.data.semantic_output_truncated } : {}),
      ...(event.data.byte_output_truncated !== undefined ? { byteOutputTruncated: event.data.byte_output_truncated } : {}),
      ...(event.data.model_request_id ? { modelRequestId: event.data.model_request_id } : {}),
      ...(event.data.details != null ? { details: Schema.decodeUnknownSync(MutationEvidenceResultDetailsSchema, { onExcessProperty: "error" })(event.data.details) } : {}),
      ...(event.data.parent_tool_use_id ? { parentToolUseId: event.data.parent_tool_use_id } : {}),
    },
  }]
}

function mapBackgroundCommand(event: MapperEvent<"tool.background_command.recorded", BackgroundCommandRecord>): SessionRuntimeFact[] {
  return [{ type: "tool.background_command.recorded", version: 1, actor: "flywheel", payload: event.data }]
}

function mapToolExecutionOutput(event: MapperEvent<"tool.execution_output.recorded", ToolExecutionOutputEventDataV2>): SessionRuntimeFact[] {
  const toolUseId = event.data.tool_use_id
  if (typeof toolUseId !== "string" || toolUseId.length === 0) {
    throw new InvariantViolation({
      kind: "schema-mismatch",
      eventType: "tool.execution_output.recorded",
      eventPosition: -1,
      aggregateId: "",
      detail: `tool.execution_output.recorded event missing tool_use_id (got ${JSON.stringify(toolUseId)})`,
    })
  }
  return [{
    type: "tool.execution_output.recorded",
    version: 3,
    actor: "flywheel",
    payload: {
      toolUseId,
      output: event.data.output,
      ...(event.data.model_request_id ? { modelRequestId: event.data.model_request_id } : {}),
      ...(event.data.parent_tool_use_id ? { parentToolUseId: event.data.parent_tool_use_id } : {}),
      ...(event.data.mutationEvidence ? { mutationEvidence: event.data.mutationEvidence } : {}),
    },
  }]
}

function mapToolResultAck(event: MapperEvent<"tool.result.acknowledged", ToolResultAckEventData>): SessionRuntimeFact[] {
  return [{
    type: "tool.result.acknowledged",
    version: 1,
    actor: "provider",
    payload: {
      toolUseId: event.data.tool_use_id,
      ...(event.data.model_request_id ? { modelRequestId: event.data.model_request_id } : {}),
      ...(event.data.parent_tool_use_id ? { parentToolUseId: event.data.parent_tool_use_id } : {}),
    },
  }]
}

function mapToolFailedValidation(event: MapperEvent<"tool.validation.failed", ToolFailedValidationEventData>): SessionRuntimeFact[] {
  const input = redactDurableToolInput(event.data.tool_name, event.data.input)
  const inputPolicy = jsonPolicy(input)
  const execution = requireToolExecution(
    event.data.execution,
    "tool.validation.failed",
    event.data.tool_name,
  )
  return [{
    type: "tool.validation.failed",
    version: 1,
    actor: "flywheel",
    payload: {
      toolUseId: event.data.tool_use_id,
      toolName: event.data.tool_name,
      input,
      inputBytes: inputPolicy.bytes,
      inputSha256: inputPolicy.sha256,
      inputPreview: inputPolicy.preview,
      executionMode: execution.mode,
      traceKind: execution.trace_kind,
      childHasOwnViewport: execution.child_has_own_viewport === true,
      reason: event.data.reason,
      ...(event.data.model_request_id ? { modelRequestId: event.data.model_request_id } : {}),
      ...(event.data.parent_tool_use_id ? { parentToolUseId: event.data.parent_tool_use_id } : {}),
    },
  }]
}

function requireToolExecution(
  execution: ToolExecutionInput | undefined,
  factType: "tool.input.completed" | "tool.validation.failed",
  toolName: string,
): ToolExecutionInput {
  if (execution) return execution
  throw new InvariantViolation({
    kind: "schema-mismatch",
    eventType: factType,
    eventPosition: -1,
    aggregateId: "",
    detail: `${factType} for ${toolName} missing runtime execution metadata`,
  })
}

function mapContextUpdate(event: MapperEvent<"model.context.measured", ContextUpdateEventData>): SessionRuntimeFact[] {
  return [{
    type: "model.context.measured",
    version: 1,
    actor: "provider",
    payload: {
      promptTokens: event.data.context_prompt_tokens,
      contextWindow: event.data.context_window,
      ...(event.data.compaction_trigger_tokens === undefined ? {} : { compactionTriggerTokens: event.data.compaction_trigger_tokens }),
      ...(event.data.parent_tool_use_id ? { parentToolUseId: event.data.parent_tool_use_id } : {}),
    },
  }]
}

function mapUsageMeasured(event: MapperEvent<"model.usage.measured", UsageMeasuredEventData>): SessionRuntimeFact[] {
  return [{
    type: "model.usage.measured",
    version: 6,
    actor: "provider",
    payload: {
      ...event.data.usage_entry,
      ...(event.data.parent_tool_use_id ? { parentToolUseId: event.data.parent_tool_use_id } : {}),
      budgetStreamId: event.data.budget_stream_id,
    },
  }]
}

function mapBudgetStreamCompleted(event: MapperEvent<"budget.stream.completed", BudgetStreamCompletedEventData>): SessionRuntimeFact[] {
  if (event.data.budget_stream_id) {
    return [{
      type: "budget.stream.completed",
      version: 2,
      actor: "flywheel",
      payload: { budgetStreamId: event.data.budget_stream_id },
    }]
  }
  const parentToolUseId = event.data.parent_tool_use_id
  if (!parentToolUseId) {
    throw new InvariantViolation({
      kind: "schema-mismatch",
      eventType: "budget.stream.completed",
      eventPosition: -1,
      aggregateId: "",
      detail: "budget.stream.completed missing stream identity",
    })
  }
  return [{
    type: "budget.stream.completed",
    version: 1,
    actor: "flywheel",
    payload: { parentToolUseId },
  }]
}

function jsonPolicy(value: DurableToolInput): ContentEvidence {
  return contentEvidence(JSON.stringify(value) ?? "null")
}

function toolResultContent(parts: LlmToolOutputPart[] | undefined): string {
  return (parts ?? []).map(partToSerialized).join("\n")
}

/** `contentBytes` is the UTF-8 length of `content`, which the caller already measured. */
function cappedNestedResultContent(content: string, contentBytes: number) {
  if (contentBytes <= MAX_NESTED_RESULT_CONTENT_BYTES) return { content, truncated: false }
  // Encode only a tail of the text: a result of several megabytes would
  // otherwise allocate its whole encoding to keep 50 KiB. Each UTF-16 code unit
  // encodes to at least one byte, so the last cap code units hold at least cap
  // bytes, and every byte after the first character of the tail equals the
  // same byte of the whole encoding. A cut surrogate pair encodes to U+FFFD,
  // whose bytes fall before the start below or are skipped as continuation bytes.
  const bytes = Buffer.from(content.slice(-MAX_NESTED_RESULT_CONTENT_BYTES), "utf-8")
  // Advance past UTF-8 continuation bytes (0b10xxxxxx): a slice starting inside
  // a code point decodes to U+FFFD, whose re-encoding can exceed the byte cap.
  let start = bytes.length - MAX_NESTED_RESULT_CONTENT_BYTES
  // SAFETY: start stays within [0, bytes.length) by the loop bound, so the index always yields a byte.
  while (start < bytes.length && (bytes[start]! & 0b1100_0000) === 0b1000_0000) start += 1
  return {
    content: new TextDecoder().decode(bytes.subarray(start)),
    truncated: true,
  }
}

function partToSerialized(part: LlmToolOutputPart): string {
  switch (part.type) {
    case "text": return part.text
    case "image": return `[image ${part.mediaType}]`
    default:
      return assertNever(part)
  }
}


function mapRateLimit(event: MapperEvent<"agent.rate_limit.observed", RateLimitEventData>): SessionRuntimeFact[] {
  return [{
    type: "agent.rate_limit.observed",
    version: 1,
    actor: "provider",
    payload: { ...event.data.rate_limit_info },
  }]
}

function recordDataFact(
  type: Extract<SessionRuntimeFact["type"], "agent.error.observed" | "agent.workflow_link.published" | "agent.waiting_on_subagents.recorded">,
  data: StringMap<unknown>,
): SessionRuntimeFact {
  return {
    type,
    version: 1,
    actor: "flywheel",
    payload: { data },
  }
}
interface StringMap<T> { [key: string]: T }

type RuntimeEventActor = "agent" | "flywheel" | "provider" | "workflow"
interface RuntimeEventDefinition<T extends string, A extends RuntimeEventActor, S extends Schema.Decoder<unknown, never>> {
  readonly type: T
  readonly actor: A
  readonly data: S
  readonly durable?: (event: { type: T; data: S["Type"] }) => SessionRuntimeFact[]
  /** Diagnostic channel: the mapped records go to the debug log, not the
   *  store. A mapper here carries ids and kinds, never message content: the
   *  conversation tree holds the content, and a diagnostic copy of it is what
   *  once made message bodies the largest records in the log. */
  readonly debug?: (event: { type: T; data: S["Type"] }) => SessionRuntimeFact[]
}
function defineRuntimeEvent<const T extends string, const A extends RuntimeEventActor, const S extends Schema.Decoder<unknown, never>>(
  definition: RuntimeEventDefinition<T, A, S>,
): RuntimeEventDefinition<T, A, S> {
  return definition
}
export const RUNTIME_EVENT_DEFINITIONS = [
  defineRuntimeEvent({ type: "model.assistant_message.recorded", actor: "agent", data: AssistantEventDataSchema }),
  defineRuntimeEvent({ type: "tool.result.recorded", actor: "flywheel", data: ToolResultEventDataSchema, durable: mapToolResult }),
  defineRuntimeEvent({ type: "tool.result.available", actor: "flywheel", data: ToolResultAvailableDataSchema }),
  defineRuntimeEvent({ type: "tool.result.acknowledged", actor: "provider", data: ToolResultAckDataSchema, durable: mapToolResultAck }),
  defineRuntimeEvent({ type: "tool.validation.failed", actor: "flywheel", data: ToolFailedValidationDataSchema, durable: mapToolFailedValidation }),
  defineRuntimeEvent({ type: "model.turn.completed", actor: "provider", data: ResultEventDataSchema, durable: mapTurnResult }),
  defineRuntimeEvent({ type: "model.context.measured", actor: "provider", data: ContextUpdateEventDataSchema, durable: mapContextUpdate }),
  defineRuntimeEvent({ type: "model.usage.measured", actor: "provider", data: UsageMeasuredEventDataSchema, durable: mapUsageMeasured }),
  defineRuntimeEvent({ type: "budget.stream.completed", actor: "flywheel", data: BudgetStreamCompletedDataSchema, durable: mapBudgetStreamCompleted }),
  defineRuntimeEvent({ type: "agent.rate_limit.observed", actor: "provider", data: RateLimitEventDataSchema, durable: mapRateLimit }),
  defineRuntimeEvent({ type: "model.content.delta", actor: "agent", data: ContentBlockDeltaDataSchema }),
  defineRuntimeEvent({ type: "model.text.completed", actor: "agent", data: TextCompleteDataSchema }),
  defineRuntimeEvent({ type: "model.text.reconciled", actor: "agent", data: TextReconciledDataSchema }),
  defineRuntimeEvent({ type: "tool.input.delta", actor: "agent", data: ToolInputDeltaDataSchema }),
  defineRuntimeEvent({ type: "tool.preview.check", actor: "flywheel", data: ToolPreviewCheckDataSchema }),
  defineRuntimeEvent({ type: "tool.execution_output.delta", actor: "agent", data: ToolExecutionOutputDeltaDataSchema }),
  defineRuntimeEvent({ type: "tool.execution_output.recorded", actor: "flywheel", data: ToolExecutionOutputRecordedDataV2Schema, durable: mapToolExecutionOutput }),
  defineRuntimeEvent({ type: "tool.background_command.recorded", actor: "flywheel", data: BackgroundCommandRecordSchema, durable: mapBackgroundCommand }),
  defineRuntimeEvent({ type: "tool.input.completed", actor: "agent", data: ToolInputCompleteDataSchema, durable: mapToolCall }),
  defineRuntimeEvent({ type: "model.user_message.recorded", actor: "agent", data: UserEventDataSchema }),
  defineRuntimeEvent({ type: "agent.error.observed", actor: "flywheel", data: GenericEventDataSchema, durable: mapAgentError }),
  defineRuntimeEvent({ type: "agent.compaction.started", actor: "agent", data: CompactionStartedDataSchema }),
  defineRuntimeEvent({ type: "agent.compaction.progressed", actor: "agent", data: CompactionProgressedDataSchema }),
  defineRuntimeEvent({ type: "agent.compaction.completed", actor: "agent", data: CompactionCompletedDataSchema }),
  defineRuntimeEvent({ type: "agent.subagent_model.selected", actor: "flywheel", data: GenericEventDataSchema }),
  defineRuntimeEvent({ type: "agent.workflow_link.published", actor: "flywheel", data: GenericEventDataSchema, debug: mapRuntimeDataFact }),
  defineRuntimeEvent({ type: "agent.subagent.dispatched", actor: "flywheel", data: GenericEventDataSchema }),
  defineRuntimeEvent({ type: "agent.subagent.queued", actor: "flywheel", data: GenericEventDataSchema }),
  // The parent's card learns of a pause from this event; the durable record
  // is the child's own `subagent.paused` fact, so no fact is mapped here.
  defineRuntimeEvent({ type: "agent.subagent.paused", actor: "flywheel", data: GenericEventDataSchema }),
  defineRuntimeEvent({ type: "agent.waiting_on_subagents.recorded", actor: "flywheel", data: GenericEventDataSchema, durable: mapRuntimeDataFact }),
  defineRuntimeEvent({ type: "agent.provider_response.started", actor: "provider", data: GenericEventDataSchema }),
  defineRuntimeEvent({ type: "model.stream.retried", actor: "provider", data: GenericEventDataSchema }),
  defineRuntimeEvent({ type: "model.stream.abandoned", actor: "provider", data: StreamAbandonedDataSchema }),
  defineRuntimeEvent({ type: "workflow.step.started", actor: "workflow", data: GenericEventDataSchema, durable: mapWorkflowStepStarted }),
] as const
type RuntimeEventFor<D extends typeof RUNTIME_EVENT_DEFINITIONS[number]> = D extends RuntimeEventDefinition<infer T, RuntimeEventActor, infer S>
  ? { type: T; data: S["Type"] }
  : never
const runtimeEventDefinitionsByType = new Map(RUNTIME_EVENT_DEFINITIONS.map((definition) => [definition.type, definition]))
