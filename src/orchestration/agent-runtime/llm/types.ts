import type { Scope } from "effect";
import type { CapabilityCheck } from "../../../infra/capability-text.js";
import type { AccessProviderCandidate, AccessProviderCandidateAttribution, AccessProviderCatalogProvenance, AccessProviderId, AccessProviderModelEligibility } from "../../../infra/llm/access-provider.js";
import type { ModelFamily } from "../../../infra/llm/model-family.js";
import type { CacheRetentionPolicy, ProviderRequestOptions } from "../../../infra/llm/provider-options.js";
import type { CompletedStopReason, LlmApi, LlmStopReason, LlmToolOutputPart } from "./messages.js";
import type { ToolOutcome } from "../../../infra/tool-outcome.js";
import type { ModelInfo, ReasoningEffort } from "../../../infra/llm/models.js";
import type { MutationEvidence } from "../../../infra/mutation-evidence.js";
import type { ContentRepair } from "../../../infra/llm/content-repair.js";
export type { CompletedStopReason, LlmStopReason } from "./messages.js";
import type { StreamAttemptStartEvent } from "./stream-attempt.js";
import type { FailoverFailure, ProviderFailure } from "./provider-failure.js";
import type { RequestAdmission } from "./provider-availability-types.js";
import type { ClaudeTokenizerIdentity } from "../../../infra/llm/model-id.js";
import type { ProviderIdentity } from "../../../infra/llm/auth-error.js";
import type { MessageProducer } from "../../../infra/chat-input.js";
import type { SystemPromptTiers } from "./system-prompt-tiers.js";
import type { ProviderTransportContext } from "../../session/provider-request-audit-types.js";
import type { SharedTree } from "../shared-tree.js";
import type { ProviderHistoryTarget } from "./provider-history.js";

/**
 * Provider-agnostic LLM types.
 *
 * One canonical `ConversationMessage` union flows through the agent runtime:
 * it is simultaneously the loop state, the persisted form, and the provider
 * converters' input. Provider adapters convert to/from wire formats.
 */

/** Providers retain session resources in this scope. The runner's provider runtime cache gives each client its
 * own child scope of the runner's scope and closes it when a client for a different route replaces that client;
 * the runner closes the rest when the run and its turn finalizers settle, with an interruption when a stop decision
 * (`Agent.abort`) ended the run, so a provider can tell a stop from the end of the session. Every client has one, so a
 * provider whose connection holds a resource beyond one request, such as an engine process, keeps it in this scope.
 * Staging and planning acquire nothing in it. */
export interface ProviderSessionLifetime {
  readonly providerSessionKey: string;
  readonly scope: Scope.Scope;
  /** Present for a workflow agent or a subagent (ARCH-PROVIDERS-006): a provider may run it in one process with the other such
   *  sessions of the chat tree rooted at `treeRootSessionId`, whose shared state the session holds for its life. */
  readonly sharedHost?: SharedTree;
  /** Present for every session that knows its chat tree, the chat itself included: the account key of the login that
   *  the tree's live shared host uses (`treeLogin`), which each request prefers while that login can serve and no other
   *  login's included quota expires sooner. */
  readonly treeLogin?: () => string | undefined;
  /** Present for the runs and pre-starts of a session that a client can show: the session's engine demand
   *  (`ProviderDemand`), the same object in every fork of the lifetime. */
  readonly demand?: ProviderDemand;
}

/** What an anticipation returns (`LLMClient.anticipate`, ARCH-PROVIDERS-068): the provider's hold on what it prepared
 *  for the request. Whoever anticipated releases it: a shown session when it is hidden or a newer plan replaces it, a
 *  request when it settles. The provider keeps what a claim holds while any claim or running work holds it, so a
 *  release whose hold a request took, or that a newer claim renewed, releases only that claim. Each call of
 *  `anticipate` returns its own claim. `release` takes effect once and never rejects. */
export interface Claim {
  release(): Promise<void>;
}

/** The engine demand of one show of a session, which the session's owner creates when a client shows the session and
 *  ends when the last client hides it. Every fork of the session's provider lifetime carries it by reference, so a
 *  provider finds the same demand from every client of the show. A provider keeps what the show's claims hold in
 *  `scope`, which closes at the hide after every claim is released; a client that a running turn keeps past the hide
 *  can outlive it. The provider calls `stale` when the session must plan again through request preparation. It names
 *  no provider and no engine state. */
export interface ProviderDemand {
  readonly scope: Scope.Scope;
  stale(): void;
}

interface UnknownFields { [key: string]: unknown }

/** The admitted request's walk is retrying the same candidate in place after
 *  a transient failure. Adapters never emit it; the turn boundary raises it
 *  from the walk's `onRetry` so the session shows the reconnect and the
 *  runtime records the attempt. */
interface StreamRetryEvent {
  readonly kind: "stream_retry";
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly reason: string;
  readonly delayMs: number;
  readonly error: import("../../../infra/llm/provider-error-diagnostic.js").ProviderErrorDiagnostic;
  readonly thinkingStall?: {
    readonly blockKey?: string;
    readonly elapsedMs: number;
    readonly summaryChars: number;
  };
}

export type ContentBlock =
  | { type: "text"; text: string; signature?: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: UnknownFields; registrationId?: string; providerItemId?: string; providerCallId?: string; thoughtSignature?: string }
  | { type: "thinking"; thinking: string; signature?: string; redacted?: boolean; presentation?: "progress" }
  | { type: "reasoning"; id: string; encrypted_content: string; summary?: Array<{ type: "summary_text"; text: string }> };

type MessageFraming = "claude" | "model" | "agent-host" | "tool-notice" | "reminder";

export type ConversationMessage =
  | {
      kind: "user";
      content: string | ContentBlock[];
      /** Explicit delivery provenance. Human input is stamped at human delivery;
       * produced user-role content is stamped by the redaction boundary.
       * Absence is unknown, including historical unmarked messages. */
      origin?: "human" | "system";
      /** Exact producer: the person, another session, or the parent whose
       *  launch gave this assignment. Historical entries can omit it. */
      producer?: MessageProducer;
      /** Inline step/skill invocation display metadata. The content is the full
       *  expanded prompt (model-visible); the transcript renders a divider
       *  divider labeled `label` plus the optional raw `args` instead of the
       *  content. Providers ignore this field. */
      invocation?: { label: string; args?: string };
      /** Durable client display correlation. Providers ignore these ids. */
      submissionIds?: readonly string[];
      /** In-flight recovery keys of queued human inputs this message carries.
       * Ephemeral transport only: the save-point flush retires the keyed cells
       * in the commit that makes the message durable. */
      dispatchIds?: readonly string[];
      /** Distinct recovery keys for system-produced background notifications.
       * They share only the append-and-retire transaction with human input. */
      backgroundNotificationIds?: readonly string[];
      /** A human-facing loop must not park until it has delivered visible text
       * in response to this system-produced input. */
      replyRequired?: true;
      /** A notice of the runtime about the agent's own waits and children: a child's completion, stop, or runtime
       *  interrupt, a reply wait's end without a reply, or a wait's expiry or empty result. A route may deliver it with the
       *  parked tool results that it follows. Only those producers set it; every other input is unlabeled. */
      runtimeNotice?: true;
      /** Request framing that a route wrote into history (`lowerProviderHistory` decides who reads it). `claude` is the
       *  Claude model reminder (`runtime-reminders.ts`), which an Anthropic Messages request to the model that it names reads. `model` is the model
       *  reminder of any other route, which only a request to the model that it names reads. `agent-host` is the shared engine host's
       *  framing: its engine text and each system tier that a hosted agent's conversation carries, which only a request
       *  that the shared host serves reads. `tool-notice` is a tree-hosted agent's tool notice, which every request
       *  reads. `reminder` is an environment or date reminder (`runtime-reminders.ts`), which every request reads.
       *  A fork copies neither `agent-host` nor `tool-notice` framing, because each names the source session or its
       *  grants. */
      framing?: MessageFraming;
      /** The request's request-only text (`StreamOptions.requestContext`), which history never holds. Only the request
       *  context marks it, in memory, so the lowering of a request knows the origin of its blocks. */
      requestOnly?: true;
    }
  | {
      kind: "system";
      content: string;
      /** One paged display manifest, excluded from provider context. */
      mutationEvidence?: MutationEvidence;
      /** The decision this message records about content a provider refused;
       *  `content` is its note. Never sent to a provider: the rebuild reads it. */
      contentRepair?: ContentRepair;
      /** When true, the persisted entry is excluded from the rebuilt model
       *  context, recall, and FTS; it survives only for transcript display and
       *  forensics. Set by writers of pure interaction markers (e.g. the durable
       *  turn-interruption marker) that must not re-enter prompts on resume. */
      displayOnly?: boolean;
    }
  | { kind: "compactionSummary"; content: string }
  | {
      kind: "assistant";
      content: string | ContentBlock[];
      incomplete?: true;
      /** Metadata captured from the provider's `done` event. The session
       *  tree persists it, so a rebuilt context keeps it. Absent or
       *  incomplete on partial turns (stream death before `done`), on the
       *  copies a fork takes from its parent (only `accessProvider` stays),
       *  and on tree entries written before 2026-08-10.
       *  Converters treat missing metadata as cross-provider (no verbatim
       *  replay of provider-native blocks). */
      accessProvider?: AccessProviderId;
      api?: LlmApi;
      provider?: ModelFamily;
      model?: string;
      timestamp?: number;
      stopReason?: LlmStopReason;
      responseId?: string;
      /** Reasoning tokens the provider reported for the response that
       *  produced this message. Its thinking or reasoning blocks can hide them
       *  (redacted thinking carries no text), but the provider charges them
       *  again when the same model replays the blocks and reads them, so the
       *  context estimate counts them there. Absent when the provider
       *  reported none, for a partial response, and on messages stored
       *  before 2026-10-08. */
      reasoningTokens?: number;
    }
  | { kind: "toolResult"; toolUseId: string; content: LlmToolOutputPart[]; isError?: boolean; interrupted?: boolean; blocked?: boolean };

/** Provider role alternation: tool results travel as user-role payloads. */
export function conversationRole(message: ConversationMessage): "user" | "assistant" | "system" {
  switch (message.kind) {
    case "assistant": return "assistant";
    case "system": return "system";
    default: return "user";
  }
}

/** Last message that occupies a slot in provider role alternation. System
 *  messages sit outside it: every provider conversion skips them from the
 *  wire (the system prompt travels separately in the request options), so
 *  alternation checks and turn seeding look past a trailing run of them.
 *  Undefined when no alternating message exists. */
export function trailingAlternatingMessage(messages: readonly ConversationMessage[]): ConversationMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.kind !== "system") return message;
  }
  return undefined;
}

/** The text of the labeled runtime notices after the last assistant message, in history order: the input of the next
 *  request that a route may deliver with the parked tool results. Empty when the tail holds none. */
export function trailingRuntimeNotices(messages: readonly ConversationMessage[]): readonly string[] {
  const notices: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.kind === "assistant") break;
    if (message.kind === "user" && message.runtimeNotice === true) {
      notices.unshift(typeof message.content === "string" ? message.content : message.content.map((block) => block.type === "text" ? block.text : "").join(""));
    }
  }
  return notices;
}

export interface ToolCall {
  id: string;
  name: string;
  input: UnknownFields;
  /** Exact tool registration that owned the contract exposed to the model. */
  registrationId?: string;
  /** Flywheel provider-request audit id for the model request that emitted this call. */
  modelRequestId?: string;
  /** OpenAI Responses-only: the `fc_*` item ID. Must be replayed on subsequent
   *  turns alongside `call_id` for gpt-5 reasoning-and-tool pairing. */
  providerItemId?: string;
  providerCallId?: string;
  /** Provider reasoning bound to this tool call, replayed on the next turn:
   *  Google's `thoughtSignature` from the `functionCall` part, or OpenRouter's
   *  serialized `reasoning.encrypted` detail. */
  thoughtSignature?: string;
  /** Set by the provider adapter when the tool-call argument text could not
   *  be recovered into a JSON object; `input` is `{}` in that case. The
   *  dispatcher converts this into a model-visible error result instead of
   *  executing the tool. Model-ready text including a raw-text snippet. */
  inputParseError?: string;
  /** Original name the model emitted when `name` was auto-repaired to a
   *  registered tool (see repairToolName in tool-dispatch.ts). Travels into
   *  the tool.input.completed fact so repair frequency is queryable per model. */
  repairedFrom?: string;
  /** The shape repairs the dispatcher made to the model's arguments before
   *  validation (see coerce-input.ts), so a repaired call stays observable.
   *  Present only when the repaired arguments passed validation. */
  inputRepairs?: ToolInputRepair[];
}

/** One repair of model-authored tool arguments, at the dot path of the field it produced. */
export type ToolInputRepair =
  | { readonly kind: "unwrapped"; readonly path: string }
  | { readonly kind: "wrapped_in_array"; readonly path: string }
  | { readonly kind: "unwrapped_array"; readonly path: string }
  | { readonly kind: "stringified_value"; readonly path: string }
  | { readonly kind: "dropped_null"; readonly path: string }
  | { readonly kind: "dropped_key"; readonly path: string }
  | { readonly kind: "renamed_key"; readonly path: string; readonly from: string }
  | { readonly kind: "renamed_value"; readonly path: string; readonly from: string; readonly to: string }
  | { readonly kind: "parsed_value"; readonly path: string; readonly type: "number" | "integer" | "boolean" | "array" | "object" }
  | { readonly kind: "decoded_escapes"; readonly path: string }
  | { readonly kind: "read_mixed_entry"; readonly path: string; readonly raw: string; readonly encoded: string };

/** How a provider that supports it constrains generation for this tool. Absent means an ordinary JSON function.
 *  `functionDescription` replaces the tool's description on a route that can send it only as a JSON function,
 *  because the description written for the custom wire tells the model to send raw text. */
export type ToolWirePresentation = Readonly<{ kind: "custom"; grammar: Readonly<{ syntax: "lark"; definition: string }>; functionDescription: string }>;

export interface ToolDef {
  name: string;
  description: string;
  input_schema: UnknownFields;
  wire?: ToolWirePresentation;
}


export interface AssistantMetadata {
  accessProvider?: AccessProviderId;
  api: LlmApi;
  provider: ModelFamily;
  model: string;
  timestamp: number;
  stopReason?: LlmStopReason;
  responseId?: string;
}

/** Events emitted by the provider stream: text/thinking/reasoning chunks,
 *  tool-call lifecycle, usage, the attempt start, and the final `done`.
 *  This is the narrow type yielded by `LLMClient.streamWithTools` and consumed
 *  by `streamAssistantTurn`. */
export type ProviderStreamEvent =
  | { kind: "provider_response_started" }
  | { kind: "text_delta"; text: string; blockKey: string; signature?: string }
  | { kind: "text_terminal"; content: string; blockKey: string; signature?: string }
  // `estimatedTokens` carries the provider's live thinking-token estimate for
  // redacted thinking (Anthropic thinking-token-count beta), where `text` is
  // empty. Approximate progress for spinners, not billed usage.
  | { kind: "thinking_delta"; text: string; blockKey: string; estimatedTokens?: number; presentation?: "progress" }
  | { kind: "thinking_complete"; thinking: string; blockKey?: string; signature?: string; redacted?: boolean; presentation?: "progress" }
  // Provider-level signal that a text content block ended (e.g. Anthropic
  // content_block_stop for a text block). The text itself already streamed
  // via text_delta events; this is purely the "block done" boundary so
  // downstream consumers can exit the "generating" phase rather than wait
  // for the next block to flip it.
  | { kind: "text_complete"; blockKey: string }
  | { kind: "tool_input_start"; toolUseId: string; name: string; modelRequestId?: string }
  // `partialJson` is canonical input for presentation and assembly.
  // `generationText` preserves original provider output when normalization changes it.
  // Absent means `partialJson`; empty marks adapter framing, not generated output.
  // `generationTiming` preserves nonempty original chunk count and monotonic
  // first/last receipt times when an adapter buffers argument deltas.
  | { kind: "tool_input_delta"; toolUseId: string; partialJson: string; generationText?: string; generationTiming?: { first: number; last: number; chunks: number }; modelRequestId?: string }
  | { kind: "tool_use"; toolCall: ToolCall }
  // `blockKey` is the provisional key its summary streamed under, so the
  // live thought row settles to this part.
  | { kind: "reasoning"; id: string; encryptedContent: string; summary?: Array<{ type: "summary_text"; text: string }>; blockKey: string }
  // Serving attribution belongs to the exact candidate that produced usage.
  // Adapters leave it unset; assistant-turn-stream stamps it from its
  // failover-tracked attempt, where the whole request identity is known.
  // `cacheCreate1hTokens` is the 1h-retention subset of `cacheCreateTokens`
  // (Anthropic `usage.cache_creation.ephemeral_1h_input_tokens`); 1h writes
  // price at 2x input instead of the 1.25x 5m rate.
  // Retention is normalized from response evidence only. Null revokes a prior
  // policy; omission lets a same-route cache hit carry the observed window.
  // `final` marks the provider's terminal usage report; a non-final event holds
  // lower bounds from an attempt that ended before that report. A null
  // `cacheReadTokens` means the provider did not report cache reads.
  // `outputTokens` includes `reasoningTokens` whatever the provider's own
  // convention (ARCH-PROVIDERS-076). `reportedChargeUsd` is the amount the
  // provider's response states as charged for the request, absent when it
  // states none; settlement records it in place of a rate-card estimate
  // (ARCH-PROVIDERS-077).
  | { kind: "usage"; final: boolean; inputTokens: number; outputTokens: number; cacheReadTokens: number | null; cacheCreateTokens: number; cacheCreate1hTokens?: number; cacheRetentionMs?: number | null; reasoningTokens: number; reportedChargeUsd?: number; accessProvider?: AccessProviderId; accessProviderCandidate?: AccessProviderCandidate }
  // Provider-reported context size, emitted by adapters when they see the
  // request's prompt token total (Anthropic/Google emit on message_start).
  // The agent loop also synthesizes this between turns from its own token
  // estimate, sharing the same event channel.
  // `compactionTriggerTokens` is the context size of the next automatic reset
  // (0: none can run). Only the loop's compaction plan owner states it.
  | { kind: "context_update"; promptTokens: number; contextWindow: number; compactionTriggerTokens?: number }
  | { kind: "provider_status"; message: string; level?: "info" | "error" }
  | { kind: "done"; stopReason: CompletedStopReason; metadata?: AssistantMetadata }
  // What a transport between the adapter and the service added to this
  // request, as the transport states it. The attempt keeps it for the
  // request's audit response and forwards it to no consumer.
  | { kind: "transport_context"; context: ProviderTransportContext }
  // Attempt start timestamps the silent startup window before the provider
  // emits its first stream event.
  | StreamAttemptStartEvent
  | StreamRetryEvent
  // The admitted request's walk is resampling the same candidate because the
  // response's reasoning repeated itself (`ProviderResample`). Like
  // `stream_retry`, only the turn boundary raises it.
  | ({ kind: "stream_resample" } & ProviderResample);

/** The same record as a raw frame of a provider's own stream, as a transport between the adapter and the service
 *  hands it to the adapter. It is no service event: the adapter turns it into a `transport_context` event and reads
 *  nothing else from it. */
export interface TransportContextFrame {
  readonly type: "transport_context";
  readonly context: ProviderTransportContext;
}

type StreamTelemetrySource = "provider" | "normalized" | "watchdog" | "request";

export interface StreamTelemetryObservation {
  source: StreamTelemetrySource;
  kind: string;
  metadata?: UnknownFields;
}

export type StreamTelemetryObserveResult = void | Promise<void>;

export interface StreamTelemetrySink {
  observe(observation: StreamTelemetryObservation): StreamTelemetryObserveResult;
}

/** Events emitted by the agent runtime itself (dispatcher, compaction,
 *  budget tracker), surfaced to the runner's `onEvent` callback alongside
 *  provider events. The agent loop fans both channels into one consumer. */
type RuntimeEvent =
  | { kind: "stream_abandoned"; reason: "failed" | "interrupted" | "retry" }
  | {
    kind: "tool_preview_check";
    toolUseId: string;
    operation: { type: "set"; advice: string } | { type: "clear" };
  }
  | {
    kind: "tool_result";
    toolUseId: string;
    content: LlmToolOutputPart[];
    outcome: ToolOutcome;
    details?: unknown;
    modelRequestId?: string;
    contentTruncated?: boolean;
    originalContentBytes?: number;
    originalContentSha256?: string;
    fullContentPath?: string;
    semanticOutputTruncated?: boolean;
    byteOutputTruncated?: boolean;
    executionOutputTail?: string;
  }
  | {
    kind: "tool_result_available";
    toolUseId: string;
    content: LlmToolOutputPart[];
    outcome: ToolOutcome;
    details?: unknown;
    contentTruncated?: boolean;
    originalContentBytes?: number;
    originalContentSha256?: string;
    fullContentPath?: string;
    semanticOutputTruncated?: boolean;
    byteOutputTruncated?: boolean;
    executionOutputTail?: string;
  }
  | { kind: "tool_result_ack"; toolUseId: string; modelRequestId?: string }
  | { kind: "tool_execution_output"; toolUseId: string; output: string; modelRequestId?: string }
  | { kind: "compaction_start" }
  | { kind: "compaction_done"; success: boolean; durationMs: number; tokensBefore?: number; tokensAfter?: number };

/** Merged event type seen by the runner and downstream consumers. */
export interface AssistantOutputIdentity {
  readonly entryId: string;
  readonly blockKey: string;
}

export type StreamEvent = (ProviderStreamEvent | RuntimeEvent) & { readonly outputIdentity?: AssistantOutputIdentity };

export type CacheRetention = Exclude<CacheRetentionPolicy, "provider"> | "none";

/** Cross-provider tool-choice constraint. `auto` (default) lets the model
 *  decide; `any` forces at least one tool call; `none` forbids tool calls;
 *  `{type:"tool", name}` forces a specific function. Used by the budget-
 *  exhaust path to guarantee a structured `handoff` artifact. */
export type ToolChoice = "auto" | "any" | "none" | { type: "tool"; name: string };

/** A hidden user-role message that Flywheel, not a person, adds to a conversation. */
export type SystemOriginMessage = Extract<ConversationMessage, { kind: "user" }> & { origin: "system" };

export interface StreamOptions {
  messages: ConversationMessage[];
  /** Request-only user text that history does not hold, such as the continuation after a stall: present when the
   *  last message of `messages` holds it (`AssistantAttemptInput.requestContext`). */
  requestContext?: string;
  tools: ReadonlyArray<ToolDef>;
  systemPrompt: SystemPromptTiers;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  signal?: AbortSignal;
  /** How long the provider should retain prompt-cache entries. Anthropic
   *  supports "5m" (default) and "1h". OpenAI supports "in_memory" and "24h"
   *  where the selected model accepts the policy. */
  cacheRetention?: CacheRetention;
  /** User-authored API policies captured with this request's configuration. */
  cacheRetentionPolicies?: { readonly [provider: string]: CacheRetentionPolicy };
  /** Stable provider session identity of the runner that sends the request:
   *  session headers, provider connection lifetime, and audit. Never a
   *  prompt-cache key (ARCH-PROVIDERS-026). */
  providerSessionKey?: string;
  /** The prompt-cache group of the request: the chat tree whose agents and
   *  side calls share a prefix. OpenAI's Responses API sends it as
   *  `prompt_cache_key`. No-op for Anthropic (its cache is prefix-keyed
   *  implicitly). */
  promptCacheKey?: string;
  /** Force the model to call a specific tool, any tool, or no tool.
   *  Default (undefined) is provider-native auto. */
  toolChoice?: ToolChoice;
  /** Caller's estimate of the request's prompt token size (the agent loop's
   *  context anchor). Adapters use it to clamp `max_tokens` to the remaining
   *  context window; an unclamped cap that overflows the window is a
   *  validation 400 on Anthropic. */
  estimatedContextTokens?: number;
  /** Host-resolved maximum output tokens for this candidate and request. */
  outputTokenLimit?: number;
  stopSequences?: readonly string[];
  providerOptions?: ProviderRequestOptions;
  /** Evidence gate for in-stream retries: returns true once the current
   *  attempt has produced durable turn content (assistant output or tool
   *  calls). With evidence, a stream failure settles the turn with the partial
   *  intact instead of silently discarding and re-billing it; the outer
   *  recovery layer owns what happens next. */
  attemptProducedEvidence?: () => boolean;
  /** Request-scoped debug telemetry for provider-wire activity, watchdog
   *  liveness, and normalized stream milestones. Not model context. */
  telemetry?: StreamTelemetrySink;
  /** Durable observation appended after the adapter invokes provider I/O. */
  onDispatch?: () => void | Promise<void>;
  /** How the stream attempt guards a response against reasoning that collapses into repetition. Only the admitted
   *  request's walk sets it (`ServingCandidate.repetitionGuard`); without it the attempt runs unguarded. */
  repetitionGuard?: RepetitionGuard;
}

/** The repetition guard of one attempt of the walk. `detect`: the attempt stops a response whose reasoning collapses
 *  into repetition (`DegenerateRepetitionError`), so that the walk can resample it. `reasoning_off`: the last attempt
 *  that the resample budget allows runs with reasoning effort `off` and without detection, and is accepted in full.
 *  The adapter decides the wire form of `off`; a model whose adapter cannot turn reasoning off reasons as before. */
export type RepetitionGuard = "detect" | "reasoning_off";

/** Resolves a captured provider policy without re-enabling explicitly uncached work.
 *  An absent entry preserves the caller's policy; `provider` omits the override. */
export function resolveCacheRetention(provider: string, options: Pick<StreamOptions, "cacheRetention" | "cacheRetentionPolicies">): CacheRetention | undefined {
  if (options.cacheRetention === "none") return "none";
  const policy = options.cacheRetentionPolicies?.[provider];
  return policy === "provider" ? undefined : policy ?? options.cacheRetention;
}

export type PreparedProviderEndpoint = "anthropic-messages" | "openai-completions" | "openai-responses";

/** Exact immutable provider request prepared before transport construction.
 * `params` is the sole wire-body authority consumed by dispatch. */
export interface PreparedProviderRequest<
  Endpoint extends PreparedProviderEndpoint,
  Params extends object,
> {
  readonly endpoint: Endpoint;
  readonly params: Params;
  readonly systemPrompt: unknown;
  readonly messages: unknown;
  readonly tools: unknown;
  readonly providerOptions: unknown;
  readonly cacheRetention: CacheRetention | undefined;
  readonly tokenClasses: Readonly<{
    estimatedPromptTokens: number | undefined;
    cacheRetention: CacheRetention | undefined;
  }>;
  readonly outputCap: number | undefined;
}

/** Freezes one provider-owned request tree after all normalization is complete. */
export function immutablePreparedRequest<Request extends PreparedProviderRequest<PreparedProviderEndpoint, object>>(
  request: Request,
): Request {
  const immutable = structuredClone(request);
  const pending: object[] = [immutable];
  const seen = new Set<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    for (const child of Object.values(value)) {
      if (typeof child === "object" && child !== null) pending.push(child);
    }
    Object.freeze(value);
  }
  return immutable;
}

/** One tool as a route sends it. The presentation owns the description, because a tool that can take more
 *  than one wire form declares a description for each (ARCH-TOOLS-044). */
type ToolInputPresentation = Readonly<
  | { kind: "custom"; description: string; inputFormat: Readonly<{ type: "grammar"; syntax: "lark"; definition: string }> }
  | { kind: "function"; description: string; inputFormat: ToolDef["input_schema"] }
>;

export interface ToolPresentation {
  readonly format: string;
  present(tool: ToolDef): ToolInputPresentation;
  /** Maps canonical executable names only at the provider boundary. */
  wireName?(name: string): string;
  /** Inverts `wireName` for a name that no declared tool has, such as one the model invents, so that a refused
   *  call enters Flywheel, its transcript, and its error under the canonical name space. */
  canonicalName?(wireName: string): string;
}

/** Returns a provider-only view of tool history. Canonical conversation entries remain unchanged. */
export function presentToolHistory(messages: ConversationMessage[], presentation: ToolPresentation): ConversationMessage[] {
  const wireName = presentation.wireName;
  if (!wireName) return messages;
  return messages.map((message) => {
    if (message.kind !== "assistant" || typeof message.content === "string") return message;
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "tool_use") return block;
      const name = wireName(block.name);
      if (name === block.name) return block;
      changed = true;
      return { ...block, name };
    });
    return changed ? { ...message, content } : message;
  });
}
export const FUNCTION_TOOL_PRESENTATION: ToolPresentation = Object.freeze({
  format: "function-schema",
  present: (tool: ToolDef) => Object.freeze({
    kind: "function" as const,
    description: tool.wire?.kind === "custom" ? tool.wire.functionDescription : tool.description,
    inputFormat: tool.input_schema,
  }),
});

/** Provider facts for one request. Every candidate of an access-provider
 *  chain has its own limits and prices, so a request that a
 *  chain routes must read all of them from the attempt that actually serves
 *  it. Immutable for the life of the request. */
export interface ServingAttempt {
  readonly accessProvider: AccessProviderId;
  /** The serving provider as a person knows it, so a failure names the
   *  provider that actually failed. Absent for an adapter built outside the
   *  provider registry, whose failures then name no provider. */
  readonly providerIdentity?: ProviderIdentity;
  /** Complete immutable admission attribution for the candidate that owns this attempt. */
  readonly candidateAttribution?: AccessProviderCandidateAttribution;
  readonly accessProviderCandidate?: AccessProviderCandidate;
  readonly catalogProvenance?: AccessProviderCatalogProvenance;
  /** Opaque auth-owned generation of the credential that served this attempt. */
  readonly credentialLineage?: string;
  readonly modelFamily: ModelFamily;
  readonly model: string;
  /** Canonical text tokenizer resolved once for the admitted request. */
  readonly tokenizerIdentity?: ClaudeTokenizerIdentity;
  /** Wire representation this concrete adapter uses for executable tools. */
  readonly toolPresentation: ToolPresentation;
  readonly contextLimit: number;
  readonly totalContextLimit?: number;
  readonly outputLimit: number;
  readonly supportsReasoning: boolean;
  /** How much of a request this route's prompt cache can share between two
   *  conversations of one session. Absent means the tools and the stable and
   *  session tiers: the route ends a cache breakpoint after the session tier
   *  or caches by byte prefix, and its cache keys nothing by conversation.
   *  `stable` means the route sends the session and conversation tiers as one
   *  cached block, so the conversations share only the tools and the stable
   *  tier. `cache-key` means the route's cache routing reads the request's
   *  `promptCacheKey`, so two requests share a prefix only when they also
   *  share that key. The workflow prefix hold reads it (prompt-prefix-hold.ts). */
  readonly sharedPromptPrefix?: "stable" | "cache-key";
  /** The route's client starts what a request needs before the request comes (`LLMClient.anticipate`), such as the
   *  process that serves it. A session's pre-start (`RequestPreparer`) hands its request only to a client of such a route. */
  readonly anticipatesRequests?: true;
  /** Subset of model names this provider/account is allowed to use. Used by
   *  subagent tier resolution to avoid picking a model the API will reject.
   *  `undefined` means "no constraint" (e.g. Anthropic API key). */
  readonly availableModels?: ReadonlySet<string>;

  /** Returns ordinary system-origin user messages required by this provider, worded for `capabilities`, the agent
   * check of the request (ARCH-CONTEXT-033). The history owner appends them before counting and preparing the request.
   * This callback does not mutate history; existing entries determine omissions. */
  messagesToAppend?(messages: readonly ConversationMessage[], executionCwd: string, capabilities: CapabilityCheck): readonly SystemOriginMessage[];

  /** Returns the system-origin user messages that this route adds for `request`, the exact request that its client
   *  receives (`attemptRequest`), read after outbound preparation. The request's owner appends them to canonical
   *  history and prepares the request again, so the client receives them. Existing entries determine omissions, so
   *  the request prepared again needs none. */
  requestEntries?(request: StreamOptions): readonly SystemOriginMessage[];

  /** Prices token counts from the immutable models.dev rate card cached for this adapter. */
  priceFor(tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h?: number; reasoning: number; promptTokens?: number }): import("../../../infra/llm/llm-helpers.js").UsagePriceResult;
}

/** Exact outbound revision evaluated before adapter construction and consumed unchanged by execution. */
export interface PreparedServingRequest {
  readonly attempt: ServingAttempt;
  readonly messages: readonly ConversationMessage[];
  readonly tools: ReadonlyArray<ToolDef>;
  readonly systemPrompt: SystemPromptTiers;
  readonly outputTokenLimit?: number;
  readonly providerOptions: ProviderRequestOptions | undefined;
  readonly cacheRetention: CacheRetention | undefined;
  readonly tokenClasses: Readonly<{
    readonly estimatedPromptTokens: number | undefined;
    /** Prepared input not expected to use a provider cache. */
    readonly estimatedUncachedInputTokens?: number;
    /** Prepared input expected to use the provider's cache-input rate. */
    readonly estimatedCacheTokens?: number;
    readonly cacheRetention: CacheRetention | undefined;
  }>;
}

/** One immutable request-bound capture. Its candidate chain is the sole input
 * to planning and serving for this request; policy resolvers share its capture
 * boundary so no later read can change the chain they govern. */
export interface ProviderRequestAdmission extends RequestAdmission {
  readonly candidateAttributions: readonly AccessProviderCandidateAttribution[];
  readonly tokenizerIdentity?: ClaudeTokenizerIdentity;
}

/** Options a provider request is actually dispatched with: the prepared
 *  request plus the logical-turn retry budget its completion seam attaches
 *  (the turn scope for loop requests; the caller itself for one-off clients).
 *  Adapters take only this type, so a dispatch path that skips the budget
 *  cannot compile; the runtime guards this replaces fired mid-request. */
/** One provider adapter: the facts of the requests it serves, plus its wire
 *  I/O. Adapters know nothing about selection; an adapter serves every
 *  request handed to it. */
export interface LLMClient extends ServingAttempt {
  streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent>;
  /** The history target of a request with `options` (`lowerProviderHistory`): the replay identity that this client
   *  stamps on the turns that it serves, and whether a shared engine host serves the request. The request's owner
   *  lowers the request's history for it and records what the lowering withheld. */
  historyTarget(options: StreamOptions): ProviderHistoryTarget | Promise<ProviderHistoryTarget>;
  /** A request with `options` reaches this client later: once it leaves a wait, such as the workflow prefix hold, or
   *  when the session that a client shows sends its next message. The client may start meanwhile what that request
   *  needs, such as the process that serves it, and sends nothing. Resolves once the start settled with the claim on
   *  what it holds for the request (`Claim`), or undefined when it holds nothing, and never rejects. */
  anticipate?(options: StreamOptions): Promise<Claim | undefined>;
}

/** One candidate described for one request without opening its provider transport. */
export interface StagedProviderClient {
  readonly attempt: ServingAttempt;
  connect(): Promise<LLMClient>;
}

/** A protocol client on a connection that outlives one request's eligibility. It lowers requests on the metadata that
 *  built it, and `withModelInfo` returns the client that lowers them on `info` over the same connection: the same SDK
 *  client, sockets, and token state, with the limits, capabilities, and headers of `info` (ARCH-PROVIDERS-023). */
export interface ConnectedClient extends LLMClient {
  withModelInfo(info: ModelInfo): LLMClient;
}

/** The evidence of one request that its attempt on an adapter reads, all from the request's captured eligibility: the
 *  candidate's attribution, the tokenizer that the request's admission resolved, and the offerings of every model that
 *  the eligibility admits for the candidate's account, which is the lineup of a host that the request opens. */
export interface AdapterAdmission {
  readonly attribution: AccessProviderCandidateAttribution;
  readonly tokenizerIdentity?: ClaudeTokenizerIdentity;
  readonly accountOfferings: readonly AccessProviderCandidateAttribution[];
}

/** A provider's adapter for one candidate's wire model on one connection. Its transport opens once, at the first
 *  connect, and serves every request of the client that holds the adapter, so a publication of eligibility never
 *  ends it (ARCH-PROVIDERS-070). Each request stages its own attempt and binds its own wire requests from its own
 *  admission (ARCH-PROVIDERS-023). */
export interface ProviderAdapter {
  stage(admission: AdapterAdmission): Promise<StagedProviderClient>;
}

/** How one candidate's attempt settled. `provider_failure` is the one signal
 *  that advances the chain, so it carries only the failures the chain may
 *  advance on. `login_refused` retains the settled failure value for an
 *  interactive login wait; it never advances to another candidate.
 *  `repetition` is an attempt whose reasoning collapsed into repetition,
 *  which the walk resamples on the same candidate. */
export type AdmittedModelRequestExecution<T> =
  | { readonly kind: "success"; readonly value: T }
  | { readonly kind: "login_refused"; readonly failure: Extract<ProviderFailure, { readonly _tag: "AuthFailure" }>; readonly value: T }
  | { readonly kind: "provider_failure"; readonly failure: FailoverFailure }
  | { readonly kind: "repetition"; readonly failure: Extract<ProviderFailure, { readonly _tag: "DegenerateRepetitionFailure" }> };

/** One in-place retry the walk is about to make on the candidate that just
 *  failed: which retry of how many, how long it waits first, and the failure
 *  it answers. Reported before the wait so a session can show the reconnect. */
export interface ProviderRetry {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly failure: FailoverFailure;
}

/** One resample the walk is about to make on the candidate whose response
 *  repeated itself: which resample of how many, and whether the attempt that
 *  it starts runs with reasoning off (`RepetitionGuard`). It sends the same
 *  request at once, so a session shows it before the next attempt starts. */
export interface ProviderResample {
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly nextAttemptDisablesReasoning: boolean;
}

/** The candidate that a request walk selected: its serving attempt, its connected client, and the request that it
 *  prepared for that candidate. */
export type PreparedCandidate = Readonly<{ attempt: ServingAttempt; client: LLMClient; prepared: PreparedServingRequest }>;

/** One attempt the walk sends on a prepared candidate. `sample` numbers the attempts of one model response from 1,
 *  and grows by one with each resample. `repetitionGuard` is `reasoning_off` on the last attempt that the walk's
 *  resample budget allows and `detect` on every earlier one (`RepetitionGuard`). */
export type ServingCandidate = PreparedCandidate & Readonly<{ sample: number; repetitionGuard: RepetitionGuard }>;

/** How one admitted request prepares its outbound revision for a candidate. */
export interface AdmittedModelRequestPreparation {
  readonly signal?: AbortSignal;
  readonly providerOptions?: ProviderRequestOptions;
  /** Prepares each outbound revision before affordability, including settled retries. */
  readonly prepare: (attempt: ServingAttempt) => PreparedServingRequest | Promise<PreparedServingRequest>;
}

export interface AdmittedModelRequestRun<T> extends AdmittedModelRequestPreparation {
  readonly execute: (candidate: ServingCandidate) => Promise<AdmittedModelRequestExecution<T>>;
  readonly onRetry?: (retry: ProviderRetry) => void;
  readonly onResample?: (resample: ProviderResample) => void;
  /** Brackets an account login wait after execution settles, outside stream deadlines. */
  readonly onLoginWait?: (waiting: boolean) => void;
}

/** One real request admitted against one immutable candidate capture and its
 * account-bound availability view. Planning and serving through this object
 * cannot re-read request eligibility or bind a different availability owner. */
export interface AdmittedModelRequest {
  readonly candidateAttributions: readonly AccessProviderCandidateAttribution[];
  run<T>(request: AdmittedModelRequestRun<T>): Promise<T>;
  /** Selects the candidate that `run` would serve the request with first, through the same selection, construction,
   *  affordability check, and connection, and returns it with its prepared request, without serving it. It claims no
   *  recheck lease and records no routing choice, and it waits on a pending recheck as `run` does. Rejects as `run`
   *  does when no candidate can be prepared. */
  prepare(request: AdmittedModelRequestPreparation): Promise<PreparedCandidate>;
  plannedAttempt(providerOptions?: ProviderRequestOptions): Promise<ServingAttempt>;
}


/** What one request captured of its profile's routing policy (ARCH-PROVIDERS-023): its exact-account eligibility and
 *  its training-route permission. The request's candidate plan and each candidate's account lineup read only these,
 *  so a client that outlives a publication of either serves each later request on that request's own capture. */
export interface ModelRequestCapture {
  readonly eligibility?: AccessProviderModelEligibility;
  readonly allowTrainingRoutes: boolean;
}

/** What the agent runtime holds instead of a provider: a model plus the
 *  access-provider chain that can serve it. Which provider serves a request
 *  is decided immediately before that request's I/O, so a ModelClient carries
 *  no provider facts of its own. */
export interface ModelClient {
  /** Normalized model name, as every candidate receives it. */
  readonly model: string;
  readonly modelFamily: ModelFamily;

  /** Captures one real request. The returned object is the sole serving path
   * for that capture and the sole path on which a real-client facade emits
   * request-admission diagnostics. `capture` is the request's own capture,
   * which plans its candidates; a client that outlives a publication of
   * eligibility or training-route permission serves each later request on
   * that request's capture (ARCH-PROVIDERS-023). Without it, or without its
   * eligibility, the client reads what its builder supplied. */
  admitRequest(capture?: ModelRequestCapture): Promise<AdmittedModelRequest>;

  /** Provider facts for work that must be shaped before any request exists
   *  (context budgeting, compaction prompts, subagent model choice): the
   *  candidate the chain would serve a request carrying `providerOptions`
   *  with right now. A request never plans from this; it reads its own
   *  ServingAttempt. `capture` is read as by `admitRequest`. */
  plannedAttempt(providerOptions?: ProviderRequestOptions, capture?: ModelRequestCapture): Promise<ServingAttempt>;

}

/** One model client together with the request options that make its provider
 *  route eligible. Selecting or falling back switches this value as a unit. */
export interface ModelRequestRoute {
  readonly client: ModelClient;
  readonly providerOptions?: ProviderRequestOptions;
}

/** The model client held by the agent loop. */
export type TurnModelClient = ModelClient;

/** Identity of the provider request one attempt actually sends. The serving
 *  attempt is the source of truth; the automatic chain restates it whenever a
 *  failover changes which provider serves the request. */
export interface ProviderRequestAttribution {
  readonly accessProvider: AccessProviderId;
  readonly accessProviderCandidate?: AccessProviderCandidate;
  readonly catalogProvenance?: AccessProviderCatalogProvenance;
  readonly candidateAttribution?: AccessProviderCandidateAttribution;
  readonly modelFamily: ModelFamily;
  readonly model: string;
  readonly contextLimit: number;
}

export function providerRequestAttribution(attempt: ServingAttempt): ProviderRequestAttribution {
  return {
    accessProvider: attempt.accessProvider,
    ...(attempt.candidateAttribution === undefined ? {} : { candidateAttribution: attempt.candidateAttribution }),
    ...(attempt.accessProviderCandidate === undefined ? {} : { accessProviderCandidate: attempt.accessProviderCandidate }),
    ...(attempt.catalogProvenance === undefined ? {} : { catalogProvenance: attempt.catalogProvenance }),
    modelFamily: attempt.modelFamily,
    model: attempt.model,
    contextLimit: attempt.contextLimit,
  };
}
