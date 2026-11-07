import { Schema } from "effect"
import type { FrontendOutputBlock, FrontendToolEntry } from "./app-service-types.js"
import type { BudgetView } from "./budget-protocol-types.js"
import type { PendingQuestionView } from "./question-protocol-types.js"
import type { UsageSessionStats } from "./modules/subscription-usage.js"

/** Agent Client Protocol version 1 (https://agentclientprotocol.com) as
 *  headless chat speaks it: JSON-RPC 2.0 messages, one per line, on standard
 *  input and output. Flywheel is the agent. It serves `initialize`,
 *  `session/new`, `session/prompt`, and the `session/cancel` notification, and
 *  sends `session/update` notifications. It asks the client for nothing: it
 *  uses its own tools, so it sends no permission, file, or terminal request.
 *  Inbound messages are decoded liberally: unknown fields are ignored. */
export const ACP_PROTOCOL_VERSION = 1

const JsonRpcIdSchema = Schema.Union([Schema.String, Schema.Number])
export type JsonRpcId = typeof JsonRpcIdSchema.Type

/** A request when it carries an id, otherwise a notification. */
export const AcpInboundSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(JsonRpcIdSchema),
  method: Schema.String,
  params: Schema.optionalKey(Schema.Unknown),
})

export const AcpInitializeParamsSchema = Schema.Struct({ protocolVersion: Schema.Number })
/** `cwd` and `mcpServers` are required by the protocol. Flywheel runs in the
 *  project directory it started in and starts no client-named MCP server. */
export const AcpNewSessionParamsSchema = Schema.Struct({ cwd: Schema.String, mcpServers: Schema.Array(Schema.Unknown) })
/** Flywheel advertises no prompt capability, so a prompt holds text blocks only. */
export const AcpPromptParamsSchema = Schema.Struct({
  sessionId: Schema.String,
  prompt: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
})
export const AcpCancelParamsSchema = Schema.Struct({ sessionId: Schema.String })

/** JSON-RPC 2.0 error codes. */
export const JSON_RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const

const TextContentSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ToolCallStatusSchema = Schema.Literals(["pending", "in_progress", "completed", "failed"])
const ToolKindSchema = Schema.Literals(["read", "edit", "search", "execute", "fetch", "other"])
const ToolCallContentSchema = Schema.Array(Schema.Struct({ type: Schema.Literal("content"), content: TextContentSchema }))
const RawInputSchema = Schema.Struct({ tool: Schema.String, input: Schema.optionalKey(Schema.String) })
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const AcpSessionUpdateSchema = Schema.Union([
  Schema.Struct({ sessionUpdate: Schema.Literal("agent_message_chunk"), content: TextContentSchema }),
  Schema.Struct({ sessionUpdate: Schema.Literal("agent_thought_chunk"), content: TextContentSchema }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call"), toolCallId: Schema.String, title: Schema.String, kind: ToolKindSchema, status: ToolCallStatusSchema,
    rawInput: Schema.optionalKey(RawInputSchema), content: Schema.optionalKey(ToolCallContentSchema),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call_update"), toolCallId: Schema.String, status: ToolCallStatusSchema,
    rawInput: Schema.optionalKey(RawInputSchema), content: Schema.optionalKey(ToolCallContentSchema),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("usage_update"), used: NonNegativeInt, size: NonNegativeInt,
    cost: Schema.optionalKey(Schema.Struct({ amount: Schema.Number, currency: Schema.Literal("USD") })),
  }),
])
export type AcpSessionUpdate = typeof AcpSessionUpdateSchema.Type

const AcpUsageSchema = Schema.Struct({
  totalTokens: NonNegativeInt, inputTokens: NonNegativeInt, outputTokens: NonNegativeInt,
  thoughtTokens: NonNegativeInt, cachedReadTokens: NonNegativeInt, cachedWriteTokens: NonNegativeInt,
})
type AcpUsage = typeof AcpUsageSchema.Type

const AcpResultSchema = Schema.Union([
  Schema.Struct({
    protocolVersion: Schema.Literal(ACP_PROTOCOL_VERSION),
    agentCapabilities: Schema.Struct({ loadSession: Schema.Literal(false) }),
    agentInfo: Schema.Struct({ name: Schema.String, title: Schema.String, version: Schema.String }),
    authMethods: Schema.Tuple([]),
  }),
  Schema.Struct({ sessionId: Schema.String }),
  Schema.Struct({ stopReason: Schema.Literals(["end_turn", "cancelled"]), usage: Schema.optionalKey(AcpUsageSchema) }),
])
export type AcpResult = typeof AcpResultSchema.Type

const AcpOutboundSchema = Schema.Union([
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: JsonRpcIdSchema, result: AcpResultSchema }),
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: Schema.NullOr(JsonRpcIdSchema), error: Schema.Struct({ code: Schema.Int, message: Schema.String }) }),
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), method: Schema.Literal("session/update"), params: Schema.Struct({ sessionId: Schema.String, update: AcpSessionUpdateSchema }) }),
])
type AcpOutbound = typeof AcpOutboundSchema.Type

const encodeOutbound = Schema.encodeSync(AcpOutboundSchema, { onExcessProperty: "error" })
const line = (message: AcpOutbound): string => `${JSON.stringify(encodeOutbound(message))}\n`

export const acpResult = (id: JsonRpcId, result: AcpResult): string => line({ jsonrpc: "2.0", id, result })
export const acpError = (id: JsonRpcId | null, code: number, message: string): string => line({ jsonrpc: "2.0", id, error: { code, message } })
export const acpUpdate = (sessionId: string, update: AcpSessionUpdate): string => line({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })

/** What a session already streamed of one transcript block: the characters of
 *  a text or thinking block, the status of a tool call, or a question. */
export type AcpStreamed = number | FrontendToolEntry["status"] | "asked"

/** The updates that stream one block, and what the client then holds of it. */
interface AcpBlockStream {
  readonly updates: readonly AcpSessionUpdate[]
  readonly streamed: AcpStreamed | undefined
}

/** The updates that bring a client from what it was streamed of `block` to the
 *  block itself, and what it then holds. A text or thinking block streams the
 *  characters it gained; a tool call streams once when it appears and again
 *  when its status changes; an open question streams its text once. Other
 *  blocks, such as the person's own messages and runtime notices, stream
 *  nothing. */
export function acpBlockUpdates(block: FrontendOutputBlock, streamed: AcpStreamed | undefined): AcpBlockStream {
  if (block.kind === "text" || block.kind === "thinking") {
    const from = typeof streamed === "number" ? streamed : 0
    if (block.content.length <= from) return { updates: [], streamed }
    const sessionUpdate = block.kind === "text" ? "agent_message_chunk" : "agent_thought_chunk"
    return { updates: [{ sessionUpdate, content: { type: "text", text: block.content.slice(from) } }], streamed: block.content.length }
  }
  if (block.kind === "question") {
    if (streamed !== undefined || block.answers !== undefined || block.cancelled) return { updates: [], streamed }
    return { updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: questionText(block) } }], streamed: "asked" }
  }
  if (block.kind !== "tool" || block.status === streamed) return { updates: [], streamed }
  const status = toolCallStatus(block.status)
  const content = toolResultText(block)
  const fields = {
    toolCallId: block.id, status,
    rawInput: { tool: block.name, ...(block.invocationBody ? { input: block.invocationBody.content } : {}) },
    ...(content ? { content: [{ type: "content" as const, content: { type: "text" as const, text: content } }] } : {}),
  }
  const update: AcpSessionUpdate = streamed === undefined
    ? { sessionUpdate: "tool_call", title: `${block.presentation.name} ${block.presentation.detail}`.trim(), kind: toolKind(block), ...fields }
    : { sessionUpdate: "tool_call_update", ...fields }
  return { updates: [update], streamed: block.status }
}

/** A pending question streams as the agent's message, which the caller
 *  answers with its next prompt. */
function questionText(question: Pick<PendingQuestionView, "questions">): string {
  return question.questions.map((entry) => [
    entry.question,
    ...entry.choices.flatMap((choice) => choice.kind === "option" ? [`- ${choice.label}${choice.description ? `: ${choice.description}` : ""}`] : []),
  ].join("\n")).join("\n\n")
}

/** The context and billed cost a budget view reports. ACP requires the
 *  context window, which no protocol view carries: the budget states it only
 *  as a whole percentage, capped at 100, of the measured window. So `size` is
 *  approximate: a percentage `p` places the window between the prompt tokens
 *  times 100 / (p + 0.5) and times 100 / (p - 0.5). At 0 percent no window
 *  follows, and no update is sent. The cost is the metered spend only: the
 *  equivalent value of a subscription run is not a cost (PI-AGENT-076), so a
 *  run with nothing billed, or with no price, states none. */
export function acpUsageUpdate(budget: BudgetView): AcpSessionUpdate | undefined {
  if (budget.totalsLoading || budget.contextPercent === 0) return undefined
  return {
    sessionUpdate: "usage_update",
    used: budget.contextPromptTokens,
    size: Math.round(budget.contextPromptTokens * 100 / budget.contextPercent),
    ...(budget.priceUnavailable || budget.billedCost === 0 ? {} : { cost: { amount: budget.billedCost, currency: "USD" as const } }),
  }
}

/** The session's cumulative tokens, its own and its children's. Input counts
 *  every prompt token, cached or not; the cached ones are also stated apart. */
export function acpPromptUsage(stats: UsageSessionStats): AcpUsage {
  const tokens = stats.totals.tokens
  return {
    totalTokens: tokens.total,
    inputTokens: tokens.input + tokens.cacheRead + tokens.cacheWrite,
    outputTokens: tokens.output,
    thoughtTokens: tokens.reasoning,
    cachedReadTokens: tokens.cacheRead,
    cachedWriteTokens: tokens.cacheWrite,
  }
}

/** A tool call is pending while its input streams and in progress while it runs. */
function toolCallStatus(status: FrontendToolEntry["status"]): typeof ToolCallStatusSchema.Type {
  switch (status) {
    case "streaming": return "pending"
    case "pending": return "in_progress"
    case "completed": return "completed"
    case "error": case "blocked": case "interrupted": return "failed"
  }
}

function toolKind(block: FrontendToolEntry): typeof ToolKindSchema.Type {
  switch (block.action) {
    case "file_read": return "read"
    case "file_write": case "file_edit": return "edit"
    case "search": case "list": return "search"
    case "shell_exec": return "execute"
    case "web_search": return "fetch"
    default: return "other"
  }
}

function toolResultText(block: FrontendToolEntry): string | undefined {
  if (block.status === "error") return block.errorMessage
  if (block.status === "blocked") return block.statusMessage
  return block.status === "completed" ? block.content : undefined
}
