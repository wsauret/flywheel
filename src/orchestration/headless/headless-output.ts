import { Schema } from "effect"
import type { EventBus, Unsubscribe } from "../../infra/event-bus.js"
import type { FlywheelEvent, FlywheelEventType } from "../../infra/events.js"
import type { HeadlessTaskResult } from "./run-headless-task.js"

/** The version of the whole JSONL contract, which every record states.
 *  Version 4 contains only `chat.*` records for the direct task stream. */
const HEADLESS_JSONL_VERSION = 4 as const

const TerminalEnvelope = {
  version: Schema.Literal(HEADLESS_JSONL_VERSION),
  sessionId: Schema.optionalKey(Schema.String),
}

const ProgressEnvelope = {
  ...TerminalEnvelope,
  timestamp: Schema.Number,
}

const Usage = {
  requests: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  reasoningTokens: Schema.Number,
  costUsd: Schema.Number,
}

const Terminal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("completed") }),
  Schema.Struct({ kind: Schema.Literal("budget_exhausted") }),
  Schema.Struct({ kind: Schema.Literal("context_overflow") }),
  Schema.Struct({ kind: Schema.Literal("output_overflow") }),
  Schema.Struct({ kind: Schema.Literal("api_error") }),
  Schema.Struct({ kind: Schema.Literal("model_unavailable") }),
  Schema.Struct({ kind: Schema.Literal("transient_disconnect") }),
  Schema.Struct({ kind: Schema.Literal("stream_stalled") }),
  Schema.Struct({ kind: Schema.Literal("api_overloaded") }),
  Schema.Struct({ kind: Schema.Literal("aborted") }),
  Schema.Struct({ kind: Schema.Literal("interrupted") }),
  Schema.Struct({ kind: Schema.Literal("input_closed") }),
  Schema.Struct({ kind: Schema.Literal("model_reassigned") }),
])

/** Why a run ended before it ran: its arguments, or its project directory,
 *  or a command failure before the run published a result. A run that ran
 *  states its own end in the rest of the record instead. */
const HeadlessFailureSchema = Schema.Literals(["usage_error", "project_error", "command_error"])
export type HeadlessFailure = typeof HeadlessFailureSchema.Type

const Termination = Schema.Struct({
  version: Schema.Literal(2),
  terminal: Schema.optionalKey(Terminal),
  deadlineFired: Schema.Boolean,
})

const Report = Schema.Struct({
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  sourceArchiveSha256: Schema.optionalKey(Schema.String),
  toolSurfaces: Schema.Array(Schema.Struct({
    toolSurfaceHash: Schema.String,
    tools: Schema.Array(Schema.String),
  })),
})

export const HeadlessOutputRecordSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("chat.provider_request.started"), ...ProgressEnvelope }),
  Schema.Struct({ kind: Schema.Literal("chat.tool.called"), ...ProgressEnvelope, name: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("chat.tool.result"), ...ProgressEnvelope, isError: Schema.Boolean }),
  // One record per measured attempt; `cacheReadTokens` is null when the provider did not report cache reads.
  Schema.Struct({ kind: Schema.Literal("chat.usage"), ...ProgressEnvelope, inputTokens: Schema.Number, outputTokens: Schema.Number, cacheReadTokens: Schema.NullOr(Schema.Number) }),
  Schema.Struct({ kind: Schema.Literal("chat.turn.completed"), ...ProgressEnvelope }),
  Schema.Struct({ kind: Schema.Literal("chat.terminal"), ...TerminalEnvelope, completed: Schema.Boolean, projectRoot: Schema.String, finalMessage: Schema.optionalKey(Schema.String), usage: Schema.optionalKey(Schema.Struct(Usage)), termination: Termination, report: Schema.optionalKey(Report), failure: Schema.optionalKey(HeadlessFailureSchema) }),
])

export type HeadlessOutputRecord = typeof HeadlessOutputRecordSchema.Type

const HEADLESS_JSONL_EVENT_TYPES = [
  "agent.provider_response.started",
  "tool.input.completed",
  "tool.result.recorded",
  "model.usage.measured",
  "model.turn.completed",
] as const satisfies readonly FlywheelEventType[]

const encode = Schema.encodeSync(HeadlessOutputRecordSchema, { onExcessProperty: "error" })

export function encodeHeadlessOutputRecord(record: HeadlessOutputRecord): string {
  return `${JSON.stringify(encode(record))}\n`
}

export function normalizeHeadlessEvent(event: FlywheelEvent): HeadlessOutputRecord | undefined {
  const common = { version: HEADLESS_JSONL_VERSION, timestamp: event.timestamp, sessionId: event.sessionId }
  switch (event.type) {
    case "agent.provider_response.started": return { kind: "chat.provider_request.started", ...common }
    case "tool.input.completed": return { kind: "chat.tool.called", ...common, name: event.data.tool_use.name }
    case "tool.result.recorded": return { kind: "chat.tool.result", ...common, isError: event.data.is_error === true }
    case "model.usage.measured": {
      const entry = event.data.usage_entry
      if (entry.coverage === "unmeasured") return undefined
      return { kind: "chat.usage", ...common, inputTokens: entry.tokens.input, outputTokens: entry.tokens.output, cacheReadTokens: entry.tokens.cacheRead }
    }
    case "model.turn.completed": return { kind: "chat.turn.completed", ...common }
    default: return undefined
  }
}

export interface HeadlessOutputSink {
  write(chunk: string): boolean
  once(event: "drain", listener: () => void): void
}

export interface HeadlessOutputObserver {
  connect(bus: EventBus): void
  close(): Promise<void>
  publishTaskTerminal(result: HeadlessTaskResult, failure?: HeadlessFailure): Promise<void>
}

const PROGRESS_BUFFER_CAPACITY = 64

export function createHeadlessOutputObserver(sink: HeadlessOutputSink): HeadlessOutputObserver {
  let unsubscribe: Unsubscribe | undefined
  let blocked = false
  let closed = false
  let terminalPublished = false
  const buffered: string[] = []
  let drain: Promise<void> | undefined
  let resolveDrain: (() => void) | undefined

  const waitForDrain = (): Promise<void> => {
    if (!blocked) return Promise.resolve()
    if (!drain) {
      drain = new Promise((resolve) => { resolveDrain = resolve })
      sink.once("drain", () => {
        blocked = false
        while (!blocked && buffered.length > 0) blocked = !sink.write(buffered.shift() ?? "")
        const resolve = resolveDrain
        drain = undefined
        resolveDrain = undefined
        resolve?.()
      })
    }
    return drain
  }

  const publishProgress = (record: HeadlessOutputRecord): void => {
    if (closed || terminalPublished) return
    const line = encodeHeadlessOutputRecord(record)
    if (!blocked) blocked = !sink.write(line)
    else {
      if (buffered.length === PROGRESS_BUFFER_CAPACITY) buffered.shift()
      buffered.push(line)
    }
    if (blocked) void waitForDrain()
  }

  const publishTerminal = async (record: HeadlessOutputRecord): Promise<void> => {
    if (terminalPublished) return
    terminalPublished = true
    await waitForDrain()
    while (buffered.length > 0) {
      blocked = !sink.write(buffered.shift() ?? "")
      if (blocked) await waitForDrain()
    }
    const line = encodeHeadlessOutputRecord(record)
    blocked = !sink.write(line)
    if (blocked) await waitForDrain()
  }

  return {
    connect(bus) {
      if (unsubscribe) throw new Error("headless output observer is already connected")
      unsubscribe = bus.subscribeToTypes(HEADLESS_JSONL_EVENT_TYPES, (event) => {
        const record = normalizeHeadlessEvent(event)
        if (record) publishProgress(record)
      }, { delivery: "direct", deliveryClass: "diagnostic", label: "headless-jsonl" })
    },
    async close() {
      closed = true
      unsubscribe?.()
      unsubscribe = undefined
      await waitForDrain()
    },
    async publishTaskTerminal(result, failure) {
      await publishTerminal({
        kind: "chat.terminal",
        version: HEADLESS_JSONL_VERSION,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        completed: result.completed,
        projectRoot: result.projectRoot,
        ...(result.finalMessage !== undefined ? { finalMessage: result.finalMessage } : {}),
        ...(result.usage ? { usage: result.usage } : {}),
        termination: {
          version: 2,
          // The published v2 union has no local failure kind. Aborted reports an early end; the transcript notice carries the cause.
          ...(result.termination.terminal ? { terminal: { kind: result.termination.terminal.kind === "local_persistence_error" ? "aborted" : result.termination.terminal.kind } } : {}),
          deadlineFired: result.termination.deadlineFired,
        },
        ...(result.report ? {
          report: {
            ...(result.report.model ? { model: result.report.model } : {}),
            ...(result.report.effort ? { effort: result.report.effort } : {}),
            ...(result.report.sourceArchiveSha256 ? { sourceArchiveSha256: result.report.sourceArchiveSha256 } : {}),
            toolSurfaces: result.report.toolSurfaces.map((surface) => ({
              toolSurfaceHash: surface.toolSurfaceHash,
              tools: [...surface.tools],
            })),
          },
        } : {}),
        ...(failure ? { failure } : {}),
      })
    },
  }
}

export function formatLegacyTaskOutput(result: HeadlessTaskResult): string {
  const { finalMessage, ...summary } = result
  const terminal = summary.termination.terminal
  // Internal aggregate copy must not expand the legacy public terminal shape.
  const termination = terminal?.kind === "api_error"
    ? { ...summary.termination, terminal: { kind: terminal.kind, message: terminal.message } }
    : summary.termination
  return `${finalMessage ? `${finalMessage}\n` : ""}${JSON.stringify({ ...summary, termination })}\n`
}
