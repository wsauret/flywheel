import { createEventProjection, parseProjectionFact, type EventProjection, reduceEvents } from "../../infra/event-projection.js"
import { heldProjection } from "../../infra/projection-registry.js"
import type { AsyncEventReadSurface, AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js"
import { InvariantViolation } from "../../infra/invariant.js"
import { emptyPrefixView, prefixAppend, prefixGet, type PrefixView } from "../../infra/prefix-view.js"
import { installedRuntimeInvocationTool } from "../module-catalog.js"
import { storedToolCallIdentity } from "../../infra/tool-content-hydration.js"
import { workflowCallLaunched } from "../../infra/tools/workflow-call-source.js"
import type { ToolOutcome } from "../../infra/tool-outcome.js"
import { parseSessionRuntimeFact, parseStoredSessionRuntimeFact, type SessionRuntimeFact, type ToolContentReferenceFact } from "./session-runtime-event-types.js"
import type { ToolExecutionEntry, ToolExecutionState, ToolExecutionStatus } from "./tool-execution-types.js"

/** The name a tool carries when only its follow-up facts survived. */
const UNRECORDED_TOOL_NAME = "unrecorded"

export const TOOL_EXECUTION_FACT_TYPES = [
  "tool.input.completed",
  "tool.runtime_invocation.recorded",
  "tool.result.recorded",
  "workflow.tool_result.corrected",
  "tool.execution_output.recorded",
  "tool.result.acknowledged",
  "tool.validation.failed",
] as const

interface ToolExecutionProjectionState extends ToolExecutionState {
  providerAliasByIdentity: Map<string, string>
  activeSubagentToolUseIds: Set<string>
}

export function createToolExecutionProjection(
  reader: AsyncEventReadSurface,
  sessionId: string,
): EventProjection<ToolExecutionState> {
  return heldProjection(reader, `tool-execution:${sessionId}`, () => createEventProjection<ToolExecutionProjectionState>(reader, {
    aggregateId: `session:${sessionId}`,
    factTypes: TOOL_EXECUTION_FACT_TYPES,
    initialState,
    reduce: reduceToolExecutionEvent,
  }))
}

/** The calls of one session that `reduceToolExecutionEvent` holds, and how
 *  many of them no other call dispatched, folded without any tool content.
 *  The reducer creates a call's entry at the call's first fact: its input,
 *  its runtime invocation, its validation failure, or a follow-up that
 *  salvages a lost input. The entry keeps the parent and model request that
 *  fact names, since identity parity refuses a later fact that names another.
 *  So a call counts once, at its first fact. With `identityParity`, the count
 *  applies that same refusal to a call's later follow-ups; the session's
 *  tool-execution projection owns every other check of the same history.
 *  A copy of a count shares its calls' index, so a fold can publish each
 *  state as a shallow copy that keeps its count while the fold counts on. */
export interface ToolCallCount {
  /** The identity that each call's first fact names, by call id. */
  calls: PrefixView<ToolCallIdentity>
  topLevel: number
  readonly identityParity: boolean
}

/** The parent call and model request that a tool fact names. */
interface ToolCallIdentity {
  readonly parentToolUseId?: string
  readonly modelRequestId?: string
}

interface ToolCallFact extends ToolCallIdentity {
  readonly toolUseId: string
  /** An input or a runtime invocation, which opens a call rather than following one. */
  readonly opens: boolean
}

export function initialToolCallCount(options: { readonly identityParity?: boolean } = {}): ToolCallCount {
  return { calls: emptyPrefixView(), topLevel: 0, identityParity: options.identityParity ?? false }
}

/** Folds one tool-execution fact into `count`. The fact is read before the
 *  count changes, so a fact that cannot be read leaves the count as it was.
 *  Throws the reducer's InvariantViolation for a fact that cannot be read
 *  and, with `identityParity`, for a follow-up whose identity conflicts with
 *  its call's first fact. */
export function countToolCall(count: ToolCallCount, stored: StoredFact): void {
  const call = toolCallOf(stored)
  if (call === undefined) return
  const first = prefixGet(count.calls, call.toolUseId)
  if (first === undefined) {
    count.calls = prefixAppend(count.calls, call.toolUseId, {
      ...(call.parentToolUseId ? { parentToolUseId: call.parentToolUseId } : {}),
      ...(call.modelRequestId ? { modelRequestId: call.modelRequestId } : {}),
    })
    // The reducer reads an empty parent as no parent.
    if (!call.parentToolUseId) count.topLevel += 1
    return
  }
  if (!count.identityParity || call.opens) return
  const asserted = stored.type === "tool.execution_output.recorded" ? withoutForeignDispatchParent((toolUseId) => prefixGet(count.calls, toolUseId) !== undefined, first, call) : call
  requireIdentityParity(first, asserted, stored)
}

function toolCallOf(stored: StoredFact): ToolCallFact | undefined {
  const referenced = storedToolCallIdentity(stored)
  if (referenced) return { ...referenced, opens: false }
  const fact = parseProjectionFact(stored, parseSessionRuntimeFact)
  switch (fact.type) {
    case "tool.input.completed":
    case "tool.validation.failed":
    case "tool.result.recorded":
    case "tool.execution_output.recorded":
    case "tool.result.acknowledged":
      return {
        toolUseId: fact.payload.toolUseId,
        opens: fact.type === "tool.input.completed",
        ...(fact.payload.parentToolUseId === undefined ? {} : { parentToolUseId: fact.payload.parentToolUseId }),
        ...(fact.payload.modelRequestId === undefined ? {} : { modelRequestId: fact.payload.modelRequestId }),
      }
    case "tool.runtime_invocation.recorded":
      return { toolUseId: fact.payload.toolUseId, opens: true }
    default:
      // A correction names a call that already has its entry.
      return undefined
  }
}

/** What one call's entry in `reduceToolExecutionEvent` says about how the
 *  call went: its name, its terminal outcome, whether its validation failed,
 *  and whether its input was never recorded. */
export interface ToolCallOutcome {
  readonly toolName: string
  readonly outcome?: ToolOutcome
  readonly validationFailed?: true
  readonly inputUnrecorded?: true
}

const UNRECORDED_CALL: ToolCallOutcome = { toolName: UNRECORDED_TOOL_NAME, inputUnrecorded: true }

/** Folds one tool-execution fact into `calls`, keyed by call id, as the
 *  reducer changes the call's entry, but without any tool content. A follow-up
 *  whose input was lost opens the same unrecorded entry, a later result
 *  replaces an interrupted guess, and a correction replaces the outcome it
 *  corrects. The fact is read before `calls` changes, so a fact that cannot
 *  be read throws the reducer's InvariantViolation and leaves `calls` as it
 *  was. The session's tool-execution projection owns every other check of
 *  the same history. */
export function recordToolCallOutcome(calls: Map<string, ToolCallOutcome>, stored: StoredFact): void {
  const referenced = storedToolCallIdentity(stored)
  if (referenced) {
    const call = calls.get(referenced.toolUseId) ?? UNRECORDED_CALL
    calls.set(referenced.toolUseId, referenced.outcome === undefined ? call : { ...call, outcome: referenced.outcome })
    return
  }
  const fact = parseProjectionFact(stored, parseSessionRuntimeFact)
  switch (fact.type) {
    case "tool.input.completed":
      if (!calls.has(fact.payload.toolUseId)) calls.set(fact.payload.toolUseId, { toolName: fact.payload.toolName })
      return
    case "tool.runtime_invocation.recorded":
      if (!calls.has(fact.payload.toolUseId)) calls.set(fact.payload.toolUseId, { toolName: installedRuntimeInvocationTool().name })
      return
    case "tool.validation.failed":
      calls.set(fact.payload.toolUseId, { ...calls.get(fact.payload.toolUseId), toolName: fact.payload.toolName, validationFailed: true })
      return
    case "tool.result.recorded":
    case "workflow.tool_result.corrected":
      calls.set(fact.payload.toolUseId, { ...calls.get(fact.payload.toolUseId) ?? UNRECORDED_CALL, outcome: fact.payload.outcome })
      return
    case "tool.execution_output.recorded":
    case "tool.result.acknowledged":
      if (!calls.has(fact.payload.toolUseId)) calls.set(fact.payload.toolUseId, UNRECORDED_CALL)
      return
    default:
      return
  }
}

/** Reads one canonical tool call without replaying unrelated calls in its session. */
export function readToolExecution(
  store: AsyncEventStateReadSurface,
  sessionId: string,
  toolUseId: string,
): Promise<ToolExecutionEntry | undefined> {
  return readToolExecutions(store, sessionId, [toolUseId]).then((tools) => tools.get(toolUseId))
}

/** Reads canonical tool calls by id, keyed by id, without replaying unrelated calls in their session. */
export async function readToolExecutions(
  store: AsyncEventStateReadSurface,
  sessionId: string,
  toolUseIds: readonly string[],
): Promise<ReadonlyMap<string, ToolExecutionEntry>> {
  const slice = await store.readSlice({ aggregateId: `session:${sessionId}`, types: TOOL_EXECUTION_FACT_TYPES, toolUseIds })
  const events = slice.facts.filter((fact): fact is StoredFact => !(fact instanceof Error))
  return new Map(loadToolExecutionTimelineFromEvents(events).map((tool) => [tool.toolUseId, tool]))
}

/** Whether a call's result is the `interrupted` guess that crash recovery
 *  writes (`repairInterruptedToolExecutions`). A guess is not an outcome:
 *  the call can still end, and its real outcome replaces the guess. */
export function holdsInterruptedGuess(tool: Pick<ToolExecutionEntry, "resultOutcome" | "validationEventId">): boolean {
  return tool.validationEventId === undefined && tool.resultOutcome === "interrupted"
}

// Derived at the read boundary: `tools` preserves first-seen insertion order,
// so a stable sort by first activity reproduces the event timeline.
export function toolExecutionTimelineFromProjection(state: ToolExecutionState): ToolExecutionEntry[] {
  return Object.values(state.tools)
    .map((entry) => ({ ...entry }))
    .sort((a, b) => firstTimestamp(a) - firstTimestamp(b))
}

/** Tool-use ids of in-flight child agents whose only viewport is this session.
 *  Excludes inline tools, completed/failed entries, and workflow launches
 *  (their persisted `childHasOwnViewport` flag exempts them; the user has a
 *  separate tab). The
 *  set is the projection-derived source of truth for the parent's "busy"
 *  signal: when it is non-empty the parent tab is doing externally invisible
 *  child work. */
export function activeSubagentIds(state: ToolExecutionState): ReadonlySet<string> {
  return new Set(state.activeSubagentToolUseIds)
}

export function loadToolExecutionTimelineFromEvents(events: readonly StoredFact[]): ToolExecutionEntry[] {
  return toolExecutionTimelineFromProjection(reduceEvents(events, {
    initialState,
    reduce: reduceToolExecutionEvent,
    factTypes: TOOL_EXECUTION_FACT_TYPES,
  }))
}

function initialState(): ToolExecutionProjectionState {
  return {
    toolCount: 0,
    completedCount: 0,
    failedCount: 0,
    validationFailureCount: 0,
    tools: {},
    providerAliasByIdentity: new Map(),
    activeSubagentToolUseIds: new Set(),
    activeSubagentRevision: 0,
  }
}

/** Reads each fact in its stored version and resolves no tool content: no
 *  entry field holds tool text, so a referenced result or output row is never
 *  loaded, and a missing or corrupt content row fails only the reader that
 *  displays that text. */
function reduceToolExecutionEvent(state: ToolExecutionProjectionState, event: StoredFact): ToolExecutionProjectionState {
  const fact = parseProjectionFact(event, parseStoredSessionRuntimeFact)

  switch (fact.type) {
    case "tool.input.completed":
      return recordToolInputCompleted(state, event, fact.payload)
    case "tool.runtime_invocation.recorded":
      return recordRuntimeWorkflowInvocation(state, event, fact.payload)
    case "tool.result.recorded":
      return recordToolResultRecorded(state, event, fact.payload)
    case "workflow.tool_result.corrected":
      return recordWorkflowToolResultCorrection(state, event, fact.payload)
    case "tool.execution_output.recorded":
      return recordToolExecutionOutput(state, event, fact.payload)
    case "tool.result.acknowledged":
      return recordToolAck(state, event, fact.payload)
    case "tool.validation.failed":
      return recordToolValidationFailure(state, event, fact.payload)
    default:
      return state
  }
}

function recordWorkflowToolResultCorrection(
  state: ToolExecutionProjectionState,
  event: StoredFact,
  payload: ToolFactPayload<"workflow.tool_result.corrected">,
): ToolExecutionProjectionState {
  const input = requireTool(state, payload.toolUseId, event)
  if (input.resultEventId !== payload.priorResultEventId) throwIdentityConflict(event, `workflow correction expected result ${payload.priorResultEventId}, found ${input.resultEventId ?? "none"}`)
  if (!callsRuntimeInvocationTool(input)
    || !workflowCallLaunched(input.input, { workflowDefinitionId: payload.workflowDefinitionId, description: correctedCallDescription(input, payload.description) })) {
    throwIdentityConflict(event, `workflow correction provenance does not match tool ${payload.toolUseId}`)
  }
  const status = payload.outcome === "ok" ? "completed" : "failed"
  return upsertTool(state, payload.toolUseId, status, {
    ...clearedResultContent(),
    resultOutcome: payload.outcome,
    completedAt: event.timestamp,
    resultEventId: event.id,
    contentBytes: payload.bytes,
    contentSha256: payload.sha256,
    contentPreview: payload.preview,
  }, {
    completedCount: 0,
    failedCount: (payload.outcome === "error" ? 1 : 0) - (input.resultOutcome === "error" || input.resultOutcome === "blocked" ? 1 : 0),
  })
}

/** The call description that a correction names. A Stop recorded before
 *  2026-10-25 stored the description with each line break changed to a space
 *  and the ends trimmed, so that form also names the call. Without this, such
 *  a row stops every read of its session's tool history. Remove after
 *  2027-04-30. */
function correctedCallDescription(tool: ToolExecutionEntry, recorded: string): string {
  const launched = tool.input?.description
  return typeof launched === "string" && launched.replace(/\n/g, " ").trim() === recorded ? launched : recorded
}

/** True for a call of the runtime invocation tool with that tool's own
 *  execution, whether a model or the runtime made it. */
export function callsRuntimeInvocationTool(tool: Pick<ToolExecutionEntry, "toolName" | "executionMode" | "traceKind" | "childHasOwnViewport">): boolean {
  const { name, execution } = installedRuntimeInvocationTool()
  return tool.toolName === name
    && tool.executionMode === execution.mode
    && tool.traceKind === execution.traceKind
    && tool.childHasOwnViewport === execution.childHasOwnViewport
}

type StoredToolFact = SessionRuntimeFact | ToolContentReferenceFact

type ToolFactPayload<T extends StoredToolFact["type"]> = Extract<StoredToolFact, { type: T }>["payload"]

function recordToolInputCompleted(
  state: ToolExecutionProjectionState,
  event: StoredFact,
  payload: ToolFactPayload<"tool.input.completed">,
): ToolExecutionProjectionState {
  if (state.tools[payload.toolUseId]) throwIdentityConflict(event, `canonical toolUseId ${payload.toolUseId} is duplicated`)
  if ("providerCallId" in payload) {
    const identity = providerAliasIdentity(payload.modelRequestId, payload.providerCallId)
    const alias = state.providerAliasByIdentity.get(identity)
    if (alias) throwIdentityConflict(event, `provider call ${payload.providerCallId} in request ${payload.modelRequestId} aliases both ${alias} and ${payload.toolUseId}`)
    state.providerAliasByIdentity.set(identity, payload.toolUseId)
  }
  return upsertTool(state, payload.toolUseId, "called", {
    toolName: payload.toolName,
    calledAt: event.timestamp,
    callEventId: event.id,
    input: payload.input,
    inputBytes: payload.inputBytes,
    inputSha256: payload.inputSha256,
    inputPreview: payload.inputPreview,
    executionMode: payload.executionMode,
    traceKind: payload.traceKind,
    childHasOwnViewport: payload.childHasOwnViewport,
    ...("providerCallId" in payload ? {
      providerCallId: payload.providerCallId,
      providerToolName: payload.providerToolName,
    } : {}),
    ...(payload.modelRequestId ? { modelRequestId: payload.modelRequestId } : {}),
    ...(payload.parentToolUseId ? { parentToolUseId: payload.parentToolUseId } : {}),
  }, { toolCount: 1 })
}

function recordRuntimeWorkflowInvocation(
  state: ToolExecutionProjectionState,
  event: StoredFact,
  payload: ToolFactPayload<"tool.runtime_invocation.recorded">,
): ToolExecutionProjectionState {
  if (state.tools[payload.toolUseId]) throwIdentityConflict(event, `canonical toolUseId ${payload.toolUseId} is duplicated`)
  const tool = installedRuntimeInvocationTool()
  const runtimeOrigin = {
    initiator: payload.initiator,
    parentConversationId: payload.parentConversationId,
    parentEntryId: payload.parentEntryId,
    operation: payload.operation,
  }
  return upsertTool(state, payload.toolUseId, "called", {
    toolName: tool.name,
    calledAt: event.timestamp,
    callEventId: event.id,
    input: tool.input(payload.operation),
    executionMode: tool.execution.mode,
    traceKind: tool.execution.traceKind,
    childHasOwnViewport: tool.execution.childHasOwnViewport,
    runtimeOrigin,
  }, { toolCount: 1 })
}

function recordToolResultRecorded(
  state: ToolExecutionProjectionState,
  event: StoredFact,
  payload: ToolFactPayload<"tool.result.recorded">,
): ToolExecutionProjectionState {
  const salvaged = salvageUnrecordedInput(state, payload, event)
  const input = requireTool(salvaged, payload.toolUseId, event)
  requireIdentityParity(input, payload, event)
  // Reviewed salvage (ARCH-SUBSTRATE-012): a second recording of the same outcome is a
  // repeat, not a contradiction. Two writers once each recorded one finished
  // call (crash recovery ran over a live turn on 2026-09-05), and a history
  // that agrees with itself must never keep the session from opening. The
  // first recording stays the entry's evidence.
  if (input.resultEventId !== undefined && input.resultOutcome === payload.outcome) return salvaged
  // Reviewed salvage (ARCH-SUBSTRATE-012): an "interrupted" result is a guess, not an
  // observation. Crash recovery (repairInterruptedToolExecutions) writes it
  // when it believes that no writer will finish the call. A real outcome that
  // arrives later proves the guess wrong, so the later fact becomes the
  // entry's terminal evidence and the guess leaves no trace. Two runtimes on
  // one store wrote exactly this pair on 2026-09-08 (positions 12120352 and
  // 12120793 for call_uIVf6OTZ9iBOxo8dhAwLjEvG). A repeat after a real
  // outcome, and a result after a validation failure, are still corruption.
  const replacesInterruptedGuess = holdsInterruptedGuess(input)
  if (!replacesInterruptedGuess) requireNoTerminal(input, event)
  const status = payload.outcome === "ok" ? "completed" : payload.outcome === "interrupted" ? "interrupted" : "failed"
  return upsertTool(salvaged, payload.toolUseId, status, {
    ...(replacesInterruptedGuess ? clearedResultContent() : {}),
    resultOutcome: payload.outcome,
    completedAt: event.timestamp,
    resultEventId: event.id,
    ...(payload.contentBytes !== undefined ? { contentBytes: payload.contentBytes } : {}),
    ...(payload.contentSha256 ? { contentSha256: payload.contentSha256 } : {}),
    ...(payload.contentPreview !== undefined ? { contentPreview: payload.contentPreview } : {}),
    ...(payload.contentTruncated !== undefined ? { contentTruncated: payload.contentTruncated } : {}),
    ...(payload.originalContentBytes !== undefined ? { originalContentBytes: payload.originalContentBytes } : {}),
    ...(payload.originalContentSha256 ? { originalContentSha256: payload.originalContentSha256 } : {}),
    ...(payload.fullContentPath ? { fullContentPath: payload.fullContentPath } : {}),
    ...(payload.semanticOutputTruncated !== undefined ? { semanticOutputTruncated: payload.semanticOutputTruncated } : {}),
    ...(payload.byteOutputTruncated !== undefined ? { byteOutputTruncated: payload.byteOutputTruncated } : {}),
    ...(payload.modelRequestId ? { modelRequestId: payload.modelRequestId } : {}),
    ...(payload.parentToolUseId ? { parentToolUseId: payload.parentToolUseId } : {}),
  }, {
    // A replacement keeps the totals a single recording of the final outcome
    // would produce: the interrupted guess already counted one completion.
    completedCount: replacesInterruptedGuess ? 0 : 1,
    failedCount: payload.outcome === "error" || payload.outcome === "blocked" ? 1 : 0,
  })
}

/** The content fields one `tool.result.recorded` fact owns, cleared. A
 *  replacement starts from these, so the entry never mixes fields written by
 *  the interrupted guess with fields written by the real outcome. */
function clearedResultContent(): Partial<ToolExecutionEntry> {
  return {
    contentBytes: undefined,
    contentSha256: undefined,
    contentPreview: undefined,
    contentTruncated: undefined,
    originalContentBytes: undefined,
    originalContentSha256: undefined,
    fullContentPath: undefined,
    semanticOutputTruncated: undefined,
    byteOutputTruncated: undefined,
  }
}

function recordToolAck(
  state: ToolExecutionProjectionState,
  event: StoredFact,
  payload: ToolFactPayload<"tool.result.acknowledged">,
): ToolExecutionProjectionState {
  const salvaged = salvageUnrecordedInput(state, payload, event)
  const input = requireTool(salvaged, payload.toolUseId, event)
  requireIdentityParity(input, payload, event)
  return upsertTool(salvaged, payload.toolUseId, input.status, {
    acknowledgedAt: event.timestamp,
    ackEventId: event.id,
  })
}

function recordToolExecutionOutput(
  state: ToolExecutionProjectionState,
  event: StoredFact,
  payload: ToolFactPayload<"tool.execution_output.recorded">,
): ToolExecutionProjectionState {
  const salvaged = salvageUnrecordedInput(state, payload, event)
  const input = requireTool(salvaged, payload.toolUseId, event)
  requireIdentityParity(input, withoutForeignDispatchParent((toolUseId) => salvaged.tools[toolUseId] !== undefined, input, payload), event)
  return salvaged
}

/** Reviewed recovery salvage: before the fix of 2026-10-01, a child session's
 *  kept command recorded its output under the parent session's dispatch id.
 *  That id names no tool in the child's aggregate, while a nested tool's parent
 *  always does, so only that legacy shape is read under the input's identity.
 *  Remove after 2027-04-01. */
function withoutForeignDispatchParent(
  knowsCall: (toolUseId: string) => boolean,
  input: ToolCallIdentity,
  payload: ToolCallIdentity,
): ToolCallIdentity {
  if (input.parentToolUseId !== undefined || payload.parentToolUseId === undefined || knowsCall(payload.parentToolUseId)) return payload
  const { parentToolUseId: _foreign, ...rest } = payload
  return rest
}

/** Reviewed salvage (ARCH-SUBSTRATE-012): a follow-up fact whose `tool.input.completed`
 *  never landed is a crash shape, not a contradiction. The input fact is
 *  written when the call's arguments finish streaming and its follow-ups only
 *  after execution, so the only way a result can exist without its input is
 *  the write of the input being lost when the runtime died (the executor of
 *  2026-09-17 lost three this way in one session). The follow-up carries the
 *  outcome the user's work produced; the entry is rebuilt from it and marked
 *  as a typed degraded gap, so the session opens and the gap stays visible. */
function salvageUnrecordedInput(
  state: ToolExecutionProjectionState,
  payload: { toolUseId: string; parentToolUseId?: string; modelRequestId?: string },
  event: StoredFact,
): ToolExecutionProjectionState {
  if (state.tools[payload.toolUseId]) return state
  return upsertTool(state, payload.toolUseId, "called", {
    toolName: UNRECORDED_TOOL_NAME,
    inputUnrecorded: true,
    calledAt: event.timestamp,
    executionMode: "foreground",
    traceKind: "tool",
    childHasOwnViewport: false,
    ...(payload.modelRequestId ? { modelRequestId: payload.modelRequestId } : {}),
    ...(payload.parentToolUseId ? { parentToolUseId: payload.parentToolUseId } : {}),
  }, { toolCount: 1 })
}

function requireTool(state: ToolExecutionState, toolUseId: string, event: StoredFact): ToolExecutionEntry {
  const entry = state.tools[toolUseId]
  if (entry) return entry
  throw new InvariantViolation({
    kind: "orphan-event",
    eventType: event.type,
    eventPosition: event.position,
    aggregateId: event.aggregateId,
    detail: `tool.input.completed has not been observed for toolUseId ${toolUseId}`,
  })
}

/** A follow-up fact that asserts an identity field must agree with the input
 *  fact; one that omits a field asserts nothing. Omission is tolerated, never
 *  required to be absent: durable ledgers exist whose follow-up facts were
 *  written without modelRequestId, and a reader that throws on them loses the
 *  session, which the substrate forbids. Conflicting asserted values remain a
 *  hard corruption signal. */
function requireIdentityParity(
  input: ToolCallIdentity,
  fact: ToolCallIdentity,
  event: StoredFact,
): void {
  for (const field of ["parentToolUseId", "modelRequestId"] as const) {
    if (fact[field] === undefined) continue
    if (fact[field] === input[field]) continue
    throwIdentityConflict(event, `${event.type} at position ${event.position} has ${field} ${fact[field] ?? "none"}; input has ${input[field] ?? "none"}`)
  }
}

function throwIdentityConflict(event: StoredFact, detail: string): never {
  throw new InvariantViolation({
    kind: "schema-mismatch",
    eventType: event.type,
    eventPosition: event.position,
    aggregateId: event.aggregateId,
    detail,
  })
}

function requireNoTerminal(input: ToolExecutionEntry, event: StoredFact): void {
  if (!input.resultEventId && !input.validationEventId) return
  throw new InvariantViolation({
    kind: "schema-mismatch",
    eventType: event.type,
    eventPosition: event.position,
    aggregateId: event.aggregateId,
    detail: `${event.type} at position ${event.position} duplicates terminal evidence for toolUseId ${input.toolUseId}`,
  })
}

function recordToolValidationFailure(
  state: ToolExecutionProjectionState,
  event: StoredFact,
  payload: ToolFactPayload<"tool.validation.failed">,
): ToolExecutionProjectionState {
  const current = state.tools[payload.toolUseId]
  if (current) {
    requireIdentityParity(current, payload, event)
    requireNoTerminal(current, event)
  }
  return upsertTool(state, payload.toolUseId, "validation_failed", {
    toolName: payload.toolName,
    validationFailedAt: event.timestamp,
    validationEventId: event.id,
    input: payload.input,
    inputBytes: payload.inputBytes,
    inputSha256: payload.inputSha256,
    inputPreview: payload.inputPreview,
    executionMode: payload.executionMode,
    traceKind: payload.traceKind,
    childHasOwnViewport: payload.childHasOwnViewport,
    validationReason: payload.reason,
    ...(payload.modelRequestId ? { modelRequestId: payload.modelRequestId } : {}),
    ...(payload.parentToolUseId ? { parentToolUseId: payload.parentToolUseId } : {}),
  }, { toolCount: current ? 0 : 1, validationFailureCount: 1 })
}

function upsertTool(
  state: ToolExecutionProjectionState,
  toolUseId: string,
  status: ToolExecutionStatus,
  patch: Omit<Partial<ToolExecutionEntry>, "toolUseId" | "status">,
  increments: Partial<Pick<ToolExecutionState, "toolCount" | "completedCount" | "failedCount" | "validationFailureCount">> = {},
): ToolExecutionProjectionState {
  // Invariant: either state.tools[toolUseId] exists (consumer reducers gated by requireTool)
  // or patch carries the producer fields from an input, invocation, or validation fact.
  const current = state.tools[toolUseId]
  const toolName = patch.toolName ?? current?.toolName
  const executionMode = patch.executionMode ?? current?.executionMode
  const traceKind = patch.traceKind ?? current?.traceKind
  const childHasOwnViewport = patch.childHasOwnViewport ?? current?.childHasOwnViewport
  if (toolName === undefined || !executionMode || !traceKind || childHasOwnViewport === undefined) {
    throw new InvariantViolation({
      kind: "schema-mismatch",
      eventType: "tool.input.completed",
      eventPosition: -1,
      aggregateId: "",
      detail: `tool execution metadata missing for toolUseId ${toolUseId}`,
    })
  }
  const next = {
    ...(current ?? { toolUseId, toolName, status }),
    ...patch,
    toolUseId,
    toolName,
    executionMode,
    traceKind,
    childHasOwnViewport,
    status,
  }
  state.toolCount += increments.toolCount ?? 0
  state.completedCount += increments.completedCount ?? 0
  state.failedCount += increments.failedCount ?? 0
  state.validationFailureCount += increments.validationFailureCount ?? 0
  state.tools[toolUseId] = next

  const wasActiveSubagent = current ? isActiveSubagent(current) : false
  const isNowActiveSubagent = isActiveSubagent(next)
  if (wasActiveSubagent !== isNowActiveSubagent) {
    if (isNowActiveSubagent) state.activeSubagentToolUseIds.add(toolUseId)
    else state.activeSubagentToolUseIds.delete(toolUseId)
    state.activeSubagentRevision += 1
  }
  return state
}

function isActiveSubagent(entry: ToolExecutionEntry): boolean {
  return entry.status === "called" && entry.traceKind === "subagent" && !entry.childHasOwnViewport
}

function firstTimestamp(entry: ToolExecutionEntry): number {
  return entry.calledAt ?? entry.validationFailedAt ?? entry.completedAt ?? entry.acknowledgedAt ?? 0
}

function providerAliasIdentity(modelRequestId: string, providerCallId: string): string {
  return `${modelRequestId}\u0000${providerCallId}`
}
