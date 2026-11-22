import { Schema } from "effect"
import type { FrontendOutputBlock, FrontendToolEntry } from "./app-service-types.js"
import type { BudgetView } from "./budget-protocol-types.js"
import { RuntimeSessionModelPlanResultSchema } from "./model-assignment-protocol-schemas.js"
import type { EffortOptionRow, ModelOptionRow } from "./model-assignment-protocol-types.js"
import { formatQuestionChoiceAnswer, type AgentInputAnswer, type AgentInputAnswers, type PendingQuestionView } from "./question-protocol-types.js"
import { RoleAssignmentViewSchema, WorkflowsModeSchema } from "./runtime-protocol-schemas.js"

/** Agent Client Protocol version 1 (https://agentclientprotocol.com) as
 *  headless chat speaks it: JSON-RPC 2.0 messages, one per line, on standard
 *  input and output. Flywheel is the agent. It serves `initialize`,
 *  `session/new`, `session/load`, `session/resume`, `session/close`,
 *  `session/prompt`, `session/set_config_option`, and the `session/cancel`
 *  notification, and sends `session/update` notifications. The one request it
 *  sends the client is `elicitation/create`, for a question, and only to a
 *  client that advertised form elicitation. It uses its own tools, so it sends
 *  no permission, file, or terminal request. Inbound messages are decoded
 *  liberally: unknown fields are ignored. */
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

/** A client's response to a request Flywheel sent it. */
export const AcpInboundResponseSchema = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: JsonRpcIdSchema,
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
})

/** A client that names `elicitation.form`, even as `{}`, can show a form;
 *  an omitted or null entry advertises nothing. */
export const AcpInitializeParamsSchema = Schema.Struct({
  protocolVersion: Schema.Number,
  clientCapabilities: Schema.optionalKey(Schema.Struct({
    elicitation: Schema.optionalKey(Schema.NullOr(Schema.Struct({ form: Schema.optionalKey(Schema.Unknown) }))),
  })),
})
/** `cwd` and `mcpServers` are required by the protocol. Flywheel runs in the
 *  project directory it started in and starts no client-named MCP server. */
export const AcpNewSessionParamsSchema = Schema.Struct({ cwd: Schema.String, mcpServers: Schema.Array(Schema.Unknown) })
/** `session/load` and `session/resume` name a saved chat of the project. */
export const AcpContinueSessionParamsSchema = Schema.Struct({ sessionId: Schema.String, cwd: Schema.String })
export const AcpCloseSessionParamsSchema = Schema.Struct({ sessionId: Schema.String })
export const AcpSetConfigOptionParamsSchema = Schema.Struct({ sessionId: Schema.String, configId: Schema.String, value: Schema.String })
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
  /** ACP's "Resource not found", such as an unknown session. */
  resourceNotFound: -32002,
} as const

const TextContentSchema = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })

const AcpConfigOptionSchema = Schema.Struct({
  id: Schema.Literals(["model", "effort"]),
  name: Schema.String,
  category: Schema.Literals(["model", "thought_level"]),
  type: Schema.Literal("select"),
  currentValue: Schema.String,
  options: Schema.Array(Schema.Struct({ value: Schema.String, name: Schema.String })),
})
export type AcpConfigOption = typeof AcpConfigOptionSchema.Type

const EnumOptionSchema = Schema.Struct({ const: Schema.String, title: Schema.String, description: Schema.optionalKey(Schema.String) })
const AcpFormPropertySchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("string"), title: Schema.String, description: Schema.optionalKey(Schema.String), oneOf: Schema.optionalKey(Schema.Array(EnumOptionSchema)) }),
  Schema.Struct({ type: Schema.Literal("array"), title: Schema.String, description: Schema.optionalKey(Schema.String), items: Schema.Struct({ anyOf: Schema.Array(EnumOptionSchema) }) }),
])
type AcpFormProperty = typeof AcpFormPropertySchema.Type

/** A form elicitation scoped to the session and the question's tool call. */
const AcpElicitationParamsSchema = Schema.Struct({
  sessionId: Schema.String,
  toolCallId: Schema.String,
  mode: Schema.Literal("form"),
  message: Schema.String,
  requestedSchema: Schema.Struct({ type: Schema.Literal("object"), properties: Schema.Record(Schema.String, AcpFormPropertySchema), required: Schema.Array(Schema.String) }),
})
type AcpElicitationParams = typeof AcpElicitationParamsSchema.Type

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
    sessionUpdate: Schema.Literal("tool_call_update"), toolCallId: Schema.String, status: ToolCallStatusSchema, title: Schema.optionalKey(Schema.String),
    rawInput: Schema.optionalKey(RawInputSchema), content: Schema.optionalKey(ToolCallContentSchema),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("usage_update"), used: NonNegativeInt, size: NonNegativeInt,
    cost: Schema.optionalKey(Schema.Struct({ amount: Schema.Number, currency: Schema.Literal("USD") })),
  }),
  Schema.Struct({ sessionUpdate: Schema.Literal("user_message_chunk"), content: TextContentSchema }),
  Schema.Struct({ sessionUpdate: Schema.Literal("config_option_update"), configOptions: Schema.Array(AcpConfigOptionSchema) }),
])
export type AcpSessionUpdate = typeof AcpSessionUpdateSchema.Type

const AcpUsageSchema = Schema.Struct({
  totalTokens: NonNegativeInt, inputTokens: NonNegativeInt, outputTokens: NonNegativeInt,
  thoughtTokens: NonNegativeInt, cachedReadTokens: NonNegativeInt, cachedWriteTokens: NonNegativeInt,
})
type AcpUsage = typeof AcpUsageSchema.Type

/** Why the agent stopped a prompt turn. Flywheel sends `end_turn`, `refusal`
 *  for the provider's refusal of the conversation content, and `cancelled`; a
 *  turn that failed otherwise is a JSON-RPC error, never a stop reason. */
const AcpStopReasonSchema = Schema.Literals(["end_turn", "refusal", "cancelled"])
export type AcpStopReason = typeof AcpStopReasonSchema.Type

/** The JSON-RPC error `data` of a prompt whose turn failed, which names the
 *  kind of the failure, such as `context_overflow` or `api_error`, or of a
 *  request that named an unknown session. */
const AcpErrorDataSchema = Schema.Union([Schema.Struct({ failure: Schema.String }), Schema.Struct({ sessionId: Schema.String })])
type AcpErrorData = typeof AcpErrorDataSchema.Type

/** The read-only settings that a session's results carry under `_meta`
 *  (PI-AGENT-076), in the protocol shapes of the runtime's own queries. */
const AcpSessionMetaSchema = Schema.Struct({
  "dev.flywheel/settings": Schema.Struct({
    modelPlan: RuntimeSessionModelPlanResultSchema,
    roles: Schema.NullOr(RoleAssignmentViewSchema),
    workflowsMode: WorkflowsModeSchema,
  }),
})


const AcpResultSchema = Schema.Union([
  Schema.Struct({
    protocolVersion: Schema.Literal(ACP_PROTOCOL_VERSION),
    agentCapabilities: Schema.Struct({
      loadSession: Schema.Literal(true),
      sessionCapabilities: Schema.Struct({ resume: Schema.Struct({}), close: Schema.Struct({}) }),
    }),
    agentInfo: Schema.Struct({ name: Schema.String, title: Schema.String, version: Schema.String }),
    authMethods: Schema.Tuple([]),
  }),
  Schema.Struct({ sessionId: Schema.String, configOptions: Schema.Array(AcpConfigOptionSchema), _meta: AcpSessionMetaSchema }),
  Schema.Struct({ configOptions: Schema.Array(AcpConfigOptionSchema), _meta: AcpSessionMetaSchema }),
  Schema.Struct({ stopReason: AcpStopReasonSchema, usage: Schema.optionalKey(AcpUsageSchema) }),
  Schema.Struct({}),
])
export type AcpResult = typeof AcpResultSchema.Type

const AcpOutboundSchema = Schema.Union([
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: JsonRpcIdSchema, method: Schema.Literal("elicitation/create"), params: AcpElicitationParamsSchema }),
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: JsonRpcIdSchema, result: AcpResultSchema }),
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), id: Schema.NullOr(JsonRpcIdSchema), error: Schema.Struct({ code: Schema.Int, message: Schema.String, data: Schema.optionalKey(AcpErrorDataSchema) }) }),
  Schema.Struct({ jsonrpc: Schema.Literal("2.0"), method: Schema.Literal("session/update"), params: Schema.Struct({ sessionId: Schema.String, update: AcpSessionUpdateSchema }) }),
])
type AcpOutbound = typeof AcpOutboundSchema.Type

const encodeOutbound = Schema.encodeSync(AcpOutboundSchema, { onExcessProperty: "error" })
const line = (message: AcpOutbound): string => `${JSON.stringify(encodeOutbound(message))}\n`

export const acpResult = (id: JsonRpcId, result: AcpResult): string => line({ jsonrpc: "2.0", id, result })
export const acpError = (id: JsonRpcId | null, code: number, message: string, data?: AcpErrorData): string =>
  line({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } })
export const acpUpdate = (sessionId: string, update: AcpSessionUpdate): string => line({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } })
export const acpElicitationRequest = (id: JsonRpcId, params: AcpElicitationParams): string => line({ jsonrpc: "2.0", id, method: "elicitation/create", params })

/** The client's answer to a form: its content when it accepted, otherwise
 *  how it ended the form. An action this agent does not know, an invalid
 *  answer, and a JSON-RPC error answer nothing, as `cancel` does. */
export type AcpElicitationReply =
  | { readonly action: "accept"; readonly content: AcpFormContent }
  | { readonly action: "decline" | "cancel" }

type AcpFormContent = { readonly [key: string]: string | number | boolean | readonly string[] }

const AcpElicitationResultSchema = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("accept"),
    content: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Array(Schema.String)])))),
  }),
  Schema.Struct({ action: Schema.Literals(["decline", "cancel"]) }),
])

export function acpElicitationReply(response: typeof AcpInboundResponseSchema.Type): AcpElicitationReply {
  const decoded = Schema.decodeUnknownOption(AcpElicitationResultSchema)(response.result)
  if (response.error !== undefined || decoded._tag === "None") return { action: "cancel" }
  return decoded.value.action === "accept" ? { action: "accept", content: decoded.value.content ?? {} } : { action: decoded.value.action }
}

/** What a session already streamed of one transcript block: the characters of
 *  a text or thinking block, the status and title of a tool call, or that a
 *  question or an error notice was sent. */
export type AcpStreamed = number | AcpStreamedTool | "sent"

interface AcpStreamedTool {
  readonly status: FrontendToolEntry["status"]
  readonly title: string
}

/** A tool call whose client was last streamed a status before its result. */
export const acpToolOpen = (streamed: AcpStreamed | undefined): boolean =>
  typeof streamed === "object" && (streamed.status === "streaming" || streamed.status === "pending")

/** The updates that stream one block, and what the client then holds of it. */
interface AcpBlockStream {
  readonly updates: readonly AcpSessionUpdate[]
  readonly streamed: AcpStreamed | undefined
}

/** The updates that bring a client from what it was streamed of `block` to the
 *  block itself, and what it then holds. A text or thinking block streams the
 *  characters it gained; a tool call streams once when it appears and again
 *  when its status or title changes; an open question and an error notice
 *  stream their text once, as the agent's message. Other blocks, such as the
 *  person's own messages and informational notices, stream nothing. */
export function acpBlockUpdates(block: FrontendOutputBlock, streamed: AcpStreamed | undefined): AcpBlockStream {
  if (block.kind === "text" || block.kind === "thinking") {
    const from = typeof streamed === "number" ? streamed : 0
    if (block.content.length <= from) return { updates: [], streamed }
    const sessionUpdate = block.kind === "text" ? "agent_message_chunk" : "agent_thought_chunk"
    return { updates: [{ sessionUpdate, content: { type: "text", text: block.content.slice(from) } }], streamed: block.content.length }
  }
  if (block.kind === "question") {
    if (streamed !== undefined || block.answers !== undefined || block.cancelled) return { updates: [], streamed }
    return { updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: questionText(block) } }], streamed: "sent" }
  }
  if (block.kind === "system") {
    if (streamed !== undefined || block.level !== "error") return { updates: [], streamed }
    return { updates: [{ sessionUpdate: "agent_message_chunk", content: { type: "text", text: block.message } }], streamed: "sent" }
  }
  if (block.kind !== "tool") return { updates: [], streamed }
  const title = `${block.presentation.name} ${block.presentation.detail}`.trim()
  const sent = typeof streamed === "object" ? streamed : undefined
  if (sent?.status === block.status && sent.title === title) return { updates: [], streamed }
  const content = toolResultText(block)
  const fields = {
    toolCallId: block.id, status: toolCallStatus(block.status),
    rawInput: { tool: block.name, ...(block.invocationBody ? { input: block.invocationBody.content } : {}) },
    ...(content ? { content: [{ type: "content" as const, content: { type: "text" as const, text: content } }] } : {}),
  }
  const update: AcpSessionUpdate = sent === undefined
    ? { sessionUpdate: "tool_call", title, kind: toolKind(block), ...fields }
    : { sessionUpdate: "tool_call_update", ...fields, ...(sent.title === title ? {} : { title }) }
  return { updates: [update], streamed: { status: block.status, title } }
}

/** The form that asks an open question: one property per question, named
 *  `q1`, `q2`, and so on. A named option is a `oneOf` entry of a single
 *  choice, or an `anyOf` item of a multi-select, whose value is the option's
 *  `choiceId`. An option that requires text adds the optional text property
 *  `q1_<choiceId>`, and a free-text choice adds the optional `q1_other`. A
 *  question without named options is one text property. A question that a
 *  free-text answer can settle requires no selection. */
export function acpQuestionForm(question: PendingQuestionView, sessionId: string): AcpElicitationParams {
  const properties: { [key: string]: AcpFormProperty } = {}
  const required: string[] = []
  for (const [index, entry] of question.questions.entries()) {
    const key = `q${index + 1}`
    const title = entry.header ?? entry.question
    const described = entry.header === undefined ? {} : { description: entry.question }
    const options = namedOptions(entry)
    const other = entry.choices.find((choice) => choice.kind === "freeform")
    if (options.length === 0) {
      properties[key] = { type: "string", title, ...described }
      required.push(key)
      continue
    }
    const titled = options.map((option) => ({ const: option.choiceId, title: option.label, ...(option.description ? { description: option.description } : {}) }))
    properties[key] = entry.multiSelect
      ? { type: "array", title, ...described, items: { anyOf: titled } }
      : { type: "string", title, ...described, oneOf: titled }
    if (other === undefined) required.push(key)
    for (const option of options) if (option.requiresText) properties[`${key}_${option.choiceId}`] = { type: "string", title: `${option.label}: details` }
    if (other !== undefined) properties[`${key}_other`] = { type: "string", title: other.label, ...(other.placeholder ? { description: other.placeholder } : {}) }
  }
  return {
    sessionId, toolCallId: question.toolUseId, mode: "form",
    message: question.questions.map((entry) => entry.question).join("\n\n"),
    requestedSchema: { type: "object", properties, required },
  }
}

/** The answers that a form's accepted content gives every question, or
 *  undefined when it leaves one unanswered. Text in a free-text property
 *  answers its question as free text, as the terminal form's free-text entry
 *  does; otherwise the selected options, with their text, answer it. Values
 *  that name no option of the question are ignored. */
export function acpQuestionAnswers(question: PendingQuestionView, content: AcpFormContent): AgentInputAnswers | undefined {
  const answers: { [question: string]: AgentInputAnswer } = {}
  for (const [index, entry] of question.questions.entries()) {
    const key = `q${index + 1}`
    const text = (name: string) => {
      const value = content[name]
      return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
    }
    const options = namedOptions(entry)
    const freeform = options.length === 0 ? text(key) : text(`${key}_other`)
    if (freeform !== undefined) {
      answers[entry.question] = { kind: "freeform", text: freeform }
      continue
    }
    const value = content[key]
    const picked = new Set(typeof value === "string" ? [value] : Array.isArray(value) ? value : [])
    const selections = options.filter((option) => picked.has(option.choiceId)).map((option) => {
      const detail = option.requiresText ? text(`${key}_${option.choiceId}`) : undefined
      return { choiceId: option.choiceId, ...(detail ? { text: detail } : {}) }
    })
    if (selections.length === 0) return undefined
    answers[entry.question] = { kind: "choice", selections, text: formatQuestionChoiceAnswer(entry, selections) }
  }
  return answers
}

/** The options of a question that an answer can name: those with a `choiceId`. */
function namedOptions(entry: PendingQuestionView["questions"][number]) {
  return entry.choices.flatMap((choice) => choice.kind === "option" && choice.choiceId !== undefined ? [{ ...choice, choiceId: choice.choiceId }] : [])
}

/** The chat seat's model and effort as session configuration options. Each
 *  lists the selectable rows that name a value, and is left out when no row
 *  is current. */
export function acpConfigOptions(models: readonly ModelOptionRow[], efforts: readonly EffortOptionRow[]): AcpConfigOption[] {
  const option = (id: "model" | "effort", rows: readonly { readonly value: string | null; readonly label: string; readonly selectable: boolean; readonly current?: boolean }[]): AcpConfigOption[] => {
    const listed = rows.flatMap((row) => row.selectable && row.value !== null ? [{ ...row, value: row.value }] : [])
    const current = listed.find((row) => row.current === true)
    if (current === undefined) return []
    return [{
      id, name: id === "model" ? "Model" : "Effort", category: id === "model" ? "model" : "thought_level", type: "select",
      currentValue: current.value, options: listed.map((row) => ({ value: row.value, name: row.label })),
    }]
  }
  return [
    ...option("model", models.map((row) => ({ ...row, value: row.model }))),
    ...option("effort", efforts.map((row) => ({ ...row, value: row.effort }))),
  ]
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

/** Token counts as the Usage module states them. */
interface AcpTokenCounts {
  readonly total: number
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

/** The prompt usage of cumulative token counts. Input counts every prompt
 *  token, cached or not; the cached ones are also stated apart. */
export function acpPromptUsage(tokens: AcpTokenCounts): AcpUsage {
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
