import { Option, Schema } from "effect"

/** The ACP messages that `agy acp` sends and Flywheel reads, as observed on agy
 *  1.5.14. This is the external boundary of the engine process: every inbound
 *  frame is decoded here once, and everything past it is typed. Fields that
 *  Flywheel does not read are not declared, and the decoders ignore them, so a
 *  qualified agy version that adds a field still decodes. A frame that lacks a
 *  field Flywheel reads does not decode, and the connection fails closed. */

/** The JSON-RPC 2.0 error code that answers every agent-to-client request,
 *  because Flywheel advertises no client capability that agy may call back. */
export const ACP_METHOD_NOT_FOUND = -32601

const ContentBlockSchema = Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })

const ConfigOptionSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  category: Schema.optionalKey(Schema.String),
  currentValue: Schema.String,
  options: Schema.Array(Schema.Struct({ value: Schema.String, name: Schema.String })),
})
export type AcpConfigOption = typeof ConfigOptionSchema.Type

const ToolCallStatusSchema = Schema.Literals(["pending", "in_progress", "completed", "failed"])

const InitializeResultSchema = Schema.Struct({
  protocolVersion: Schema.Number,
  agentCapabilities: Schema.Struct({
    _meta: Schema.optionalKey(Schema.Struct({
      antigravity: Schema.optionalKey(Schema.Struct({
        systemPrompt: Schema.optionalKey(Schema.Struct({ append: Schema.optionalKey(Schema.Boolean) })),
      })),
    })),
  }),
  authMethods: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  agentInfo: Schema.Struct({ name: Schema.String, version: Schema.String }),
})
type AcpInitializeResult = typeof InitializeResultSchema.Type

const NewSessionResultSchema = Schema.Struct({
  sessionId: Schema.String,
  models: Schema.optionalKey(Schema.Struct({
    availableModels: Schema.Array(Schema.Struct({ modelId: Schema.String, name: Schema.String })),
    currentModelId: Schema.String,
  })),
  configOptions: Schema.Array(ConfigOptionSchema),
})
export type AcpNewSessionResult = typeof NewSessionResultSchema.Type

/** Aggregate usage of every model request of one prompt turn, without the
 *  title request. agy reports none when the turn failed or a hook ended it. */
const UsageSchema = Schema.Struct({
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cachedReadTokens: Schema.Number,
  cachedWriteTokens: Schema.Number,
  thoughtTokens: Schema.Number,
  totalTokens: Schema.Number,
})
export type AcpUsage = typeof UsageSchema.Type

const PromptResultSchema = Schema.Struct({
  stopReason: Schema.Literals(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]),
  usage: Schema.optionalKey(UsageSchema),
})
export type AcpPromptResult = typeof PromptResultSchema.Type

const SetConfigOptionResultSchema = Schema.Struct({ configOptions: Schema.Array(ConfigOptionSchema) })
const EmptyResultSchema = Schema.Struct({})

/** The text sent as one block of a prompt. */
export interface AcpTextBlock {
  readonly type: "text"
  readonly text: string
}

/** Every client-to-agent request Flywheel sends, with its params and the
 *  decoded result. */
export interface AcpRequests {
  readonly initialize: {
    readonly params: {
      readonly protocolVersion: number
      readonly clientCapabilities: { readonly fs: { readonly readTextFile: boolean; readonly writeTextFile: boolean }; readonly terminal: boolean }
      readonly clientInfo: { readonly name: string; readonly version: string }
    }
    readonly result: AcpInitializeResult
  }
  readonly authenticate: {
    readonly params: { readonly methodId: string }
    readonly result: typeof EmptyResultSchema.Type
  }
  readonly logout: { readonly params: { readonly [key: string]: never }; readonly result: typeof EmptyResultSchema.Type }
  readonly "session/new": {
    readonly params: { readonly cwd: string; readonly mcpServers: readonly unknown[]; readonly _meta?: { readonly antigravity: { readonly systemPrompt: { readonly append: string } } } }
    readonly result: AcpNewSessionResult
  }
  readonly "session/prompt": {
    readonly params: { readonly sessionId: string; readonly prompt: readonly AcpTextBlock[] }
    readonly result: AcpPromptResult
  }
  readonly "session/set_config_option": {
    readonly params: { readonly sessionId: string; readonly configId: string; readonly value: string }
    readonly result: typeof SetConfigOptionResultSchema.Type
  }
  readonly "session/set_model": {
    readonly params: { readonly sessionId: string; readonly modelId: string }
    readonly result: typeof EmptyResultSchema.Type
  }
}
export type AcpMethod = keyof AcpRequests

/** Every notification Flywheel sends. Cancel is a notification: it settles the
 *  open prompt with `stopReason: "cancelled"`. */
export interface AcpNotifications {
  readonly "session/cancel": { readonly sessionId: string }
}

/** One result decoder per request method, so a method cannot lack one. */
type AcpResultDecoders = { readonly [M in AcpMethod]: Schema.Decoder<AcpRequests[M]["result"]> }

const RESULT_SCHEMAS: AcpResultDecoders = {
  initialize: InitializeResultSchema,
  authenticate: EmptyResultSchema,
  logout: EmptyResultSchema,
  "session/new": NewSessionResultSchema,
  "session/prompt": PromptResultSchema,
  "session/set_config_option": SetConfigOptionResultSchema,
  "session/set_model": EmptyResultSchema,
}

/** The result of `method`, or none when it does not have the result's shape. */
export function decodeAcpResult<M extends AcpMethod>(method: M, raw: unknown): Option.Option<AcpRequests[M]["result"]> {
  return Schema.decodeUnknownOption(RESULT_SCHEMAS[method])(raw)
}

/** ACP version 1 spells the call id `toolCallId` on the wire; it decodes to
 *  Flywheel's canonical `toolUseId`. */
const WIRE_TOOL_CALL_KEYS = { toolUseId: "toolCallId" } as const

const KnownSessionUpdateSchema = Schema.Union([
  Schema.Struct({ sessionUpdate: Schema.Literal("agent_message_chunk"), content: ContentBlockSchema }),
  Schema.Struct({ sessionUpdate: Schema.Literal("agent_thought_chunk"), content: ContentBlockSchema }),
  Schema.Struct({ sessionUpdate: Schema.Literal("user_message_chunk"), content: ContentBlockSchema }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call"),
    toolUseId: Schema.String,
    status: ToolCallStatusSchema,
    title: Schema.String,
    name: Schema.optionalKey(Schema.String),
    rawInput: Schema.optionalKey(Schema.Unknown),
  }).pipe(Schema.encodeKeys(WIRE_TOOL_CALL_KEYS)),
  Schema.Struct({
    sessionUpdate: Schema.Literal("tool_call_update"),
    toolUseId: Schema.String,
    status: Schema.optionalKey(ToolCallStatusSchema),
    name: Schema.optionalKey(Schema.String),
    rawInput: Schema.optionalKey(Schema.Unknown),
    rawOutput: Schema.optionalKey(Schema.Unknown),
  }).pipe(Schema.encodeKeys(WIRE_TOOL_CALL_KEYS)),
  Schema.Struct({ sessionUpdate: Schema.Literal("usage_update"), used: Schema.Number, size: Schema.Number }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("available_commands_update"),
    availableCommands: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
  Schema.Struct({ sessionUpdate: Schema.Literal("current_mode_update"), currentModeId: Schema.String }),
  Schema.Struct({ sessionUpdate: Schema.Literal("config_option_update"), configOptions: Schema.Array(ConfigOptionSchema) }),
  Schema.Struct({ sessionUpdate: Schema.Literal("session_info_update"), title: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
])
const KNOWN_UPDATE_KINDS: ReadonlySet<string> = new Set(
  KnownSessionUpdateSchema.members.map((member) => ("to" in member ? member.to : member).fields.sessionUpdate.literal),
)
const KnownSessionNotificationSchema = Schema.Struct({ sessionId: Schema.String, update: KnownSessionUpdateSchema })

/** One `session/update`. A kind that this agy version was not qualified with
 *  is kept as `unknown` with the kind agy reported, so a new kind never stops
 *  the session; a known kind that lacks a field Flywheel reads does not
 *  decode. */
export type AcpSessionUpdate =
  | typeof KnownSessionUpdateSchema.Type
  | { readonly sessionUpdate: "unknown"; readonly reportedKind: string }

/** A decoded `session/update` notification. */
export interface AcpSessionNotification {
  readonly sessionId: string
  readonly update: AcpSessionUpdate
}

const SessionNotificationEnvelopeSchema = Schema.Struct({
  sessionId: Schema.String,
  update: Schema.Struct({ sessionUpdate: Schema.String }),
})

/** The params of a `session/update`, or none when they do not decode. */
export function decodeSessionNotification(params: unknown): Option.Option<AcpSessionNotification> {
  const envelope = Schema.decodeUnknownOption(SessionNotificationEnvelopeSchema)(params)
  if (Option.isNone(envelope)) return Option.none()
  const { sessionId, update } = envelope.value
  if (!KNOWN_UPDATE_KINDS.has(update.sessionUpdate)) {
    return Option.some({ sessionId, update: { sessionUpdate: "unknown", reportedKind: update.sessionUpdate } })
  }
  return Schema.decodeUnknownOption(KnownSessionNotificationSchema)(params)
}

const JsonRpcIdSchema = Schema.Union([Schema.Number, Schema.String])
export type AcpJsonRpcId = typeof JsonRpcIdSchema.Type

const JsonRpcErrorSchema = Schema.Struct({
  code: Schema.Number,
  message: Schema.String,
  data: Schema.optionalKey(Schema.Unknown),
})
export type AcpJsonRpcError = typeof JsonRpcErrorSchema.Type

/** One inbound JSON-RPC 2.0 frame, sorted by its members: a response carries
 *  an id and no method, an agent request both, a notification only a method. */
const InboundFrameSchema = Schema.Union([
  Schema.Struct({ id: JsonRpcIdSchema, method: Schema.String, params: Schema.optionalKey(Schema.Unknown) }),
  Schema.Struct({ method: Schema.String, params: Schema.optionalKey(Schema.Unknown) }),
  Schema.Struct({ id: JsonRpcIdSchema, error: JsonRpcErrorSchema }),
  Schema.Struct({ id: JsonRpcIdSchema, result: Schema.Unknown }),
])

export type AcpInboundFrame =
  | { readonly kind: "agent-request"; readonly id: AcpJsonRpcId; readonly method: string; readonly params: unknown }
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown }
  | { readonly kind: "error"; readonly id: AcpJsonRpcId; readonly error: AcpJsonRpcError }
  | { readonly kind: "result"; readonly id: AcpJsonRpcId; readonly result: unknown }

/** One parsed JSON value as an inbound frame, or none when it is not a
 *  JSON-RPC 2.0 frame. */
export function decodeInboundFrame(raw: unknown): Option.Option<AcpInboundFrame> {
  return Option.map(Schema.decodeUnknownOption(InboundFrameSchema)(raw), (frame): AcpInboundFrame => {
    if ("method" in frame) {
      return "id" in frame
        ? { kind: "agent-request", id: frame.id, method: frame.method, params: frame.params }
        : { kind: "notification", method: frame.method, params: frame.params }
    }
    return "error" in frame ? { kind: "error", id: frame.id, error: frame.error } : { kind: "result", id: frame.id, result: frame.result }
  })
}

/** The session an agent request names, when it names one. */
export function agentRequestSessionId(params: unknown): string | undefined {
  return Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Struct({ sessionId: Schema.String }))(params))?.sessionId
}
