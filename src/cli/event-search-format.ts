import { asRecord } from "../infra/record.js"
import { rowTimestamp, type EventSearchRow, type MergedEventTypeSummary } from "../infra/event-search.js"

interface Payload {
  [key: string]: unknown
}

interface EventSearchFormatOptions {
  json?: boolean
  previousTimestamp?: number
}

/** One line per merged-timeline row, the same shape for both sources:
 *  timestamp, source tag, identifiers, payload summary. Log records carry no
 *  position and may lack session or actor, so those fields simply do not
 *  print. */
export function formatEventSearchMatch(row: EventSearchRow, options: EventSearchFormatOptions = {}): string {
  if (options.json) return formatJsonRow(row)

  const timestamp = rowTimestamp(row)
  const time = new Date(timestamp).toISOString()
  const gap =
    options.previousTimestamp === undefined
      ? ""
      : ` +${timestamp - options.previousTimestamp}ms`
  if (row.source === "log") {
    const record = row.record
    const identifiers = [
      "log",
      record.sessionId ? `session=${record.sessionId}` : null,
      `type=${record.type}`,
      record.actor ? `actor=${record.actor}` : null,
    ].filter(Boolean).join(" ")
    return `${time}${gap} ${identifiers} ${summarizeTypedPayload(record.type, asRecord(record.payload) ?? {})}`
  }
  const event = row.fact
  const identifiers = [
    "store",
    `pos=${event.position}`,
    `session=${event.sessionId}`,
    `type=${event.type}`,
    `actor=${event.actor}`,
    event.runId ? `run=${event.runId}` : null,
  ].filter(Boolean).join(" ")
  return `${time}${gap} ${identifiers} ${summarizeTypedPayload(event.type, event.payload)}`
}

function formatJsonRow(row: EventSearchRow): string {
  if (row.source === "store") {
    return JSON.stringify({ source: "store", ...row.fact, summary: summarizeTypedPayload(row.fact.type, row.fact.payload) })
  }
  const record = row.record
  return JSON.stringify({
    source: "log",
    timestamp: record.ts,
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    type: record.type,
    ...(record.actor ? { actor: record.actor } : {}),
    payload: record.payload,
    summary: summarizeTypedPayload(record.type, asRecord(record.payload) ?? {}),
  })
}

export function formatEventTypeSummary(summary: MergedEventTypeSummary): string {
  const first = new Date(summary.firstTimestamp).toISOString()
  const last = new Date(summary.lastTimestamp).toISOString()
  return [
    summary.type.padEnd(34),
    `count=${String(summary.count).padStart(5)}`,
    `source=${summary.sources.join("+")}`,
    summary.firstPosition !== undefined ? `positions=${summary.firstPosition}-${summary.lastPosition}` : null,
    `time=${first}..${last}`,
  ].filter(Boolean).join(" ")
}

// The historical span.* and file.read cases stay until phase 5 prunes those
// families from existing stores.
function summarizeTypedPayload(type: string, payload: Payload): string {
  switch (type) {
    case "span.started":
      return summarizeSpanStarted(payload)
    case "span.completed":
      return summarizeSpanCompleted(payload)
    case "trace.finalized":
      return summarizeTraceFinalized(payload)
    case "model.requested":
      return summarizeModelRequested(payload)
    case "model.response_received":
      return summarizeModelResponse(payload)
    case "model.usage.recorded":
      return summarizeModelUsage(payload)
    case "model.stream.started":
      return `stream started request=${stringField(payload, "requestId")} turn=${numberField(payload, "turn")}`
    case "model.stream.event_observed":
      return summarizeModelStreamEvent(payload)
    case "model.stream.completed":
      return summarizeModelStreamCompleted(payload)
    case "model.stream.summary.recorded":
      return summarizeModelStreamSummary(payload)
    case "prompt.assembled":
      return summarizePrompt(payload)
    case "tool_surface.selected":
      return summarizeToolSurface(payload)
    case "tool.input.completed":
      return summarizeToolCalled(payload)
    case "tool.result.recorded":
      return summarizeToolCompleted(payload)
    case "tool.execution_output.recorded":
      return summarizeToolExecutionOutput(payload)
    case "tool.validation.failed":
      return summarizeToolValidation(payload)
    case "tool.result.acknowledged":
      return `ack toolUseId=${stringField(payload, "toolUseId")}`
    case "file.read":
      return summarizeFileRead(payload)
    case "file.changed":
      return summarizeFileChanged(payload)
    case "handoff.written":
      return summarizeHandoffWritten(payload)
    case "handoff.validated":
      return summarizeHandoffValidated(payload)
    case "queue.created":
      return summarizeQueueCreated(payload)
    case "queue.state.changed":
      return `queue status=${stringField(payload, "status")} cursor=${numberField(payload, "cursor")}`
    case "queue.mutated":
      return summarizeQueueMutated(payload)
    case "step.status.changed":
      return summarizeAttemptStatus(payload)
    case "model.context.measured":
      return summarizeContextMeasured(payload)
    case "model.usage.measured":
      return summarizeUsageMeasured(payload)
    case "subagent.completed":
      return summarizeSubagentCompleted(payload)
    case "subagent.interrupted":
      return `subagent interrupted childRunId=${stringField(payload, "childRunId")} reason=${stringField(payload, "reason")}`
    case "agent.error.observed":
      return `agent error ${preview(payload.data)}`
    default:
      return preview(payload)
  }
}

function summarizeSpanStarted(payload: Payload): string {
  const input = asRecord(payload.input)
  const name = stringField(payload, "name")
  const kind = stringField(payload, "kind")
  return `start ${kind} ${name} input=${preview(input ?? payload.input)}`
}

function summarizeSpanCompleted(payload: Payload): string {
  const span = asRecord(payload.span)
  if (!span) return preview(payload)

  const error = asRecord(span.error)
  return [
    `done ${stringField(span, "kind")} ${stringField(span, "status")}`,
    durationText(span),
    error ? `error=${preview(error.message)}` : null,
    `output=${preview(span.output)}`,
  ].filter(Boolean).join(" ")
}

function summarizeTraceFinalized(payload: Payload): string {
  return [
    `trace ${stringField(payload, "status")}`,
    stringField(payload, "workflowName"),
    durationText(payload),
    `spans=${numberField(payload, "closedSpanCount")}/${numberField(payload, "spanCount")}`,
  ].join(" ")
}

function summarizeModelRequested(payload: Payload): string {
  const candidate = asRecord(payload.accessProviderCandidate)
  const candidateIdentity = candidate?.kind === "subscription"
    ? `${stringField(candidate, "providerId")}:${stringField(candidate, "instanceId")}`
    : candidate?.kind === "singleton" ? stringField(candidate, "providerId") : ""
  return [
    `request=${stringField(payload, "requestId")}`,
    `turn=${numberField(payload, "turn")}`,
    `model=${stringField(payload, "model")}`,
    `provider=${stringField(payload, "accessProvider")}`,
    candidateIdentity ? `candidate=${candidateIdentity}` : "",
    stringField(payload, "catalogProvenance") ? `catalog=${stringField(payload, "catalogProvenance")}` : "",
    `family=${stringField(payload, "modelFamily")}`,
  ].filter(Boolean).join(" ")
}

function summarizeModelResponse(payload: Payload): string {
  const error = asRecord(payload.error)
  return [
    `response request=${stringField(payload, "requestId")}`,
    `turn=${numberField(payload, "turn")}`,
    `outcome=${stringField(payload, "outcome")}`,
    durationText(payload),
    stringField(payload, "stopReason") ? `stop=${stringField(payload, "stopReason")}` : null,
    error ? `error=${stringField(error, "tag")}:${preview(error.message)}` : null,
    summarizeTransportContext(asRecord(payload.transportContext)),
  ].filter(Boolean).join(" ")
}

/** What a transport added to the request (`ProviderTransportContext`): each addition as `part:kind@at` or
 *  `part:kind=value`, each request that the transport sent by itself with its status and input tokens, and each
 *  addition that the transport did not state. */
function summarizeTransportContext(context: Payload | undefined): string | null {
  if (context === undefined) return null
  const records = (value: unknown): Payload[] => Array.isArray(value) ? value.flatMap((item) => asRecord(item) ?? []) : []
  const stated = (record: Payload, field: string): string => record[field] === undefined ? "not-recorded" : String(record[field])
  const additions = records(context.additions).map((addition) => [
    `${stringField(addition, "part")}:${stringField(addition, "kind")}`,
    addition.at === undefined ? "" : `@${String(addition.at)}`,
    addition.value === undefined ? "" : `=${String(addition.value)}`,
  ].join(""))
  const hidden = records(context.hiddenRequests).map((request) => `${stringField(request, "source")}(status=${stated(request, "status")} in=${stated(request, "inputTokens")})`)
  const notRecorded = Array.isArray(context.notRecorded) ? context.notRecorded.map(String) : []
  return [
    `added-by=${stringField(context, "identity")}`,
    additions.length > 0 ? `added=${additions.join(",")}` : null,
    hidden.length > 0 ? `hidden=${hidden.join(",")}` : null,
    notRecorded.length > 0 ? `not-recorded=${notRecorded.join(",")}` : null,
  ].filter(Boolean).join(" ")
}

function summarizeModelUsage(payload: Payload): string {
  return [
    `usage request=${stringField(payload, "requestId")}`,
    `turn=${numberField(payload, "turn")}`,
    workflowAttemptOf(payload) ? `attempt=${workflowAttemptOf(payload)}` : null,
    stringField(payload, "parentToolUseId") ? `parentTool=${stringField(payload, "parentToolUseId")}` : null,
    stringField(payload, "coverage") ? `coverage=${stringField(payload, "coverage")}` : null,
    `in=${numberField(payload, "inputTokens")}`,
    `out=${numberField(payload, "outputTokens")}`,
    `cacheRead=${numberField(payload, "cacheReadInputTokens")}`,
    `cacheCreate=${numberField(payload, "cacheCreationInputTokens")}`,
    `reasoning=${numberField(payload, "reasoningTokens")}`,
    `deltaCost=${numberValue(payload.deltaCostUsd)?.toFixed(6) ?? "?"}`,
  ].filter(Boolean).join(" ")
}

function summarizeModelStreamEvent(payload: Payload): string {
  return [
    `stream event #${numberField(payload, "sequence")}`,
    `request=${stringField(payload, "requestId")}`,
    `source=${stringField(payload, "source")}`,
    `kind=${stringField(payload, "kind")}`,
    `elapsed=${numberField(payload, "elapsedMs")}ms`,
    `gap=${numberField(payload, "sincePreviousMs")}ms`,
    `metadata=${preview(payload.metadata)}`,
  ].join(" ")
}

function summarizeModelStreamCompleted(payload: Payload): string {
  return [
    `stream completed request=${stringField(payload, "requestId")}`,
    `outcome=${stringField(payload, "outcome")}`,
    durationText(payload),
    `events=${numberField(payload, "eventCount")}`,
    stringField(payload, "lastEventKind") ? `last=${stringField(payload, "lastEventKind")}` : null,
    typeof payload.stallCount === "number" ? `stalls=${payload.stallCount}` : null,
  ].filter(Boolean).join(" ")
}

function summarizeModelStreamSummary(payload: Payload): string {
  const interDelta = asRecord(payload.interDelta)
  const watchdog = asRecord(payload.watchdog)
  const loopLagMs = numberValue(payload.loopLagMs)
  return [
    `stream summary request=${stringField(payload, "requestId")}`,
    `rawEvents=${numberField(payload, "rawEventCount")}`,
    `firstVisible=${numberField(payload, "firstVisibleDeltaMs")}ms`,
    `p90Gap=${numberField(interDelta ?? {}, "p90Ms")}ms`,
    `stalls=${numberField(watchdog ?? {}, "thinkingStallCount")}`,
    ...(loopLagMs !== null && loopLagMs > 0 ? [`loopLag=${loopLagMs}ms`] : []),
  ].join(" ")
}

function summarizePrompt(payload: Payload): string {
  return [
    `prompt request=${stringField(payload, "requestId")}`,
    `kind=${stringField(payload, "promptKind")}`,
    `messages=${numberField(payload, "messageCount")}`,
    `context=${numberField(payload, "estimatedContextTokens")}/${numberField(payload, "contextWindow")}`,
  ].join(" ")
}

function summarizeToolSurface(payload: Payload): string {
  const tools = Array.isArray(payload.tools) ? payload.tools.length : 0
  const omitted = Array.isArray(payload.omittedTools) ? payload.omittedTools.length : 0
  return `tool surface request=${stringField(payload, "requestId")} tools=${tools} omitted=${omitted}`
}

function summarizeToolCalled(payload: Payload): string {
  return [
    `tool call ${stringField(payload, "toolName")}`,
    `id=${stringField(payload, "toolUseId")}`,
    `request=${stringField(payload, "modelRequestId")}`,
    `input=${preview(payload.inputPreview ?? payload.input)}`,
  ].join(" ")
}

function summarizeToolCompleted(payload: Payload): string {
  const status = typeof payload.outcome === "string" ? payload.outcome : payload.interrupted === true ? "interrupted" : payload.isError === true ? "error" : "ok"
  return [
    `tool result ${status}`,
    `id=${stringField(payload, "toolUseId")}`,
    `bytes=${numberField(payload, "contentBytes")}`,
    `recovery=${stringField(payload, "fullContentPath")}`,
    `semantic=${boolField(payload, "semanticOutputTruncated")}`,
    `byteCap=${boolField(payload, "byteOutputTruncated")}`,
    `preview=${preview(payload.contentPreview)}`,
  ].join(" ")
}

// `output` is inline text at version 1 and may be a tool-content reference
// { sha256, bytes, preview } at version 2; both render as a bounded preview
// instead of raw JSON.
function summarizeToolExecutionOutput(payload: Payload): string {
  const output = payload.output
  const reference = asRecord(output)
  const rendered = reference
    ? `bytes=${numberField(reference, "bytes")} preview=${preview(reference.preview)}`
    : `preview=${preview(output)}`
  return [
    "tool execution output",
    `id=${stringField(payload, "toolUseId")}`,
    rendered,
  ].join(" ")
}

function summarizeToolValidation(payload: Payload): string {
  return [
    `tool validation failed ${stringField(payload, "toolName")}`,
    `id=${stringField(payload, "toolUseId")}`,
    `reason=${preview(payload.reason)}`,
  ].join(" ")
}

function summarizeFileRead(payload: Payload): string {
  const selection = asRecord(payload.selection)
  const lines = selection ? lineRange(selection) : ""
  return `read ${stringField(payload, "displayPath")} ${stringField(payload, "mode")} ${lines}`.trim()
}

function summarizeFileChanged(payload: Payload): string {
  const diff = asRecord(payload.diff)
  return [
    `${stringField(payload, "changeKind")} ${stringField(payload, "displayPath")}`,
    diff ? `diff=${preview(diff.preview)}` : null,
  ].filter(Boolean).join(" ")
}

/** The workflow attempt a usage fact belongs to: `workflowAttemptId`, or
 *  `stepId` in a fact that a build before the agent lexicon wrote. */
function workflowAttemptOf(payload: Payload): string | undefined {
  return stringField(payload, "workflowAttemptId") || stringField(payload, "stepId") || undefined
}

/** The attempt and agent of a handoff fact: `attemptId` and `agentName`, or
 *  `stepId` and `stepName` in a version 1 fact. */
interface HandoffAuthor {
  readonly attempt: string
  readonly agent: string
}

function handoffAuthor(payload: Payload): HandoffAuthor {
  return {
    attempt: stringField(payload, "attemptId") || stringField(payload, "stepId"),
    agent: stringField(payload, "agentName") || stringField(payload, "stepName"),
  }
}

function summarizeHandoffWritten(payload: Payload): string {
  // A fact from a build before the step-content cutover also names its
  // handoff type. A current writer never sets it.
  const handoffType = stringField(payload, "handoffType")
  const { attempt, agent } = handoffAuthor(payload)
  return [
    `handoff written ${agent}`,
    `attempt=${attempt}`,
    `definition=${stringField(payload, "definitionId")}`,
    handoffType ? `handoffType=${handoffType}` : null,
    `preview=${preview(payload.preview)}`,
  ].filter(Boolean).join(" ")
}

function summarizeHandoffValidated(payload: Payload): string {
  const issues = Array.isArray(payload.issues) ? payload.issues.length : 0
  return `handoff ${stringField(payload, "status")} ${handoffAuthor(payload).agent} issues=${issues}`
}

function summarizeQueueCreated(payload: Payload): string {
  const queue = asRecord(payload.queue)
  const attempts = Array.isArray(queue?.steps) ? queue.steps.length : 0
  return `queue created status=${stringField(queue, "status")} attempts=${attempts}`
}

function summarizeQueueMutated(payload: Payload): string {
  const mutation = asRecord(payload.mutation)
  const inserted = Array.isArray(payload.insertedSteps) ? payload.insertedSteps.length : 0
  const removed = Array.isArray(payload.removedStepIds) ? payload.removedStepIds.length : 0
  return `queue mutated action=${stringField(mutation, "action")} inserted=${inserted} removed=${removed}`
}

/** The status change of an attempt in a `step.status.changed` fact, which
 *  only a build before the agent lexicon wrote; its payload keeps `stepId`. */
function summarizeAttemptStatus(payload: Payload): string {
  return [
    `attempt ${stringField(payload, "stepId")}`,
    `${stringField(payload, "previousStatus")}->${stringField(payload, "status")}`,
    stringField(payload, "reason") ? `reason=${preview(payload.reason)}` : null,
  ].filter(Boolean).join(" ")
}

function summarizeContextMeasured(payload: Payload): string {
  return `context ${numberField(payload, "promptTokens")}/${numberField(payload, "contextWindow")}`
}

function summarizeUsageMeasured(payload: Payload): string {
  const stream = stringField(payload, "parentToolUseId")
  // Entries since v5 carry a token object; v6 adds coverage, and an unmeasured entry has no tokens.
  if (typeof payload.attemptId === "string") {
    const tokens = asRecord(payload.tokens)
    return [
      `usage attempt=${payload.attemptId}`,
      `coverage=${stringField(payload, "coverage") || "complete"}`,
      tokens ? `in=${numberField(tokens, "input")} out=${numberField(tokens, "output")} cacheRead=${numberField(tokens, "cacheRead")}` : "",
      stream ? `stream=${stream}` : "",
    ].filter(Boolean).join(" ")
  }
  return [
    `usage cost=$${numberField(payload, "totalCostUsd")}`,
    `in=${numberField(payload, "inputTokens")}`,
    `out=${numberField(payload, "outputTokens")}`,
    stream ? `stream=${stream}` : "",
  ].filter(Boolean).join(" ")
}

function summarizeSubagentCompleted(payload: Payload): string {
  return [
    `subagent ${stringField(payload, "status")}`,
    `id=${stringField(payload, "childRunId")}`,
    durationText(payload),
    `preview=${preview(payload.resultPreview)}`,
  ].join(" ")
}

function durationText(payload: Payload): string {
  const duration = numberValue(payload.durationMs)
  return typeof duration === "number" ? `duration=${duration}ms` : "duration=?"
}

function lineRange(payload: Payload): string {
  const start = numberValue(payload.startLine)
  const end = numberValue(payload.endLine)
  return typeof start === "number" && typeof end === "number" ? `lines=${start}-${end}` : ""
}

function stringField(payload: Payload | null | undefined, field: string): string {
  const value = payload?.[field]
  return typeof value === "string" ? value : ""
}

function numberField(payload: Payload | null | undefined, field: string): string {
  const value = numberValue(payload?.[field])
  return typeof value === "number" ? String(value) : "?"
}

function boolField(payload: Payload | null | undefined, field: string): string {
  const value = payload?.[field]
  return typeof value === "boolean" ? String(value) : ""
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null
}

function preview(value: unknown, maxLength = 180): string {
  const text = stringifyPreview(value)
  const compacted = text.replace(/\s+/g, " ").trim()
  return compacted.length > maxLength ? `${compacted.slice(0, maxLength)}...` : compacted
}

function stringifyPreview(value: unknown): string {
  if (value == null) return ""
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return String(value)
  }
}
