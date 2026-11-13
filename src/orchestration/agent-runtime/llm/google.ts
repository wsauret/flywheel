/**
 * Google Generative AI (Gemini) streaming adapter.
 *
 * Provider adapter is intentionally cohesive: request building,
 * stream decoding, and event mapping live together.
 *
 * Reasoning: maps ReasoningEffort to Gemini `thinkingBudget` (or `thinkingLevel`
 * for Gemini 3 / Gemma 4). Tools are converted from the agent runtime `ToolDef` shape
 * to Google's `functionDeclarations`. Message history flows through the shared
 * `toGoogleGenerativeAiRequest` converter from `ConversationMessage[]`.
 */

import {
  ApiError,
  FinishReason,
  FunctionCallingConfigMode,
  type GenerateContentConfig,
  type GenerateContentParameters,
  GoogleGenAI,
  ThinkingLevel,
  type Part,
  type ThinkingConfig,
  type Tool,
  type ToolConfig,
} from "@google/genai";
import { Redacted } from "effect";
import { computeUsagePrice } from "../../../infra/llm/llm-helpers.js";
import { providerRequestHeaders } from "../../../infra/llm/provider-request-identity.js";
import type { ModelInfo, ReasoningEffort } from "../../../infra/llm/models.js";
import { errorMessage } from "../../../infra/error-message.js";
import { classifyQuotaError, ContentRefusedError, ContextLengthExceededError, LlmStreamError, ModelAccessRefusedError, OutputLengthExceededError, QuotaExhaustedError } from "./errors.js";
import { GOOGLE_CACHE_RATES } from "./provider-description.js";
import { geminiThinkingConfigMode } from "./model-compat.js";
import { isTransientNetworkError, normalizeProviderAttemptFailure } from "./provider-failure.js";
import { withStreamAttempt } from "./stream-attempt.js";
import { invokeProviderAttempt } from "./provider-attempt-boundary.js";
import { googleHistoryTarget, toGoogleGenerativeAiRequest } from "./conversions/google-generative-ai.js";
import { sanitizeSurrogates } from "./sanitize-unicode.js";
import { renderSystemPrompt } from "./system-prompt-tiers.js";
import { armStreamLiveness, throwIfLivenessFailure } from "./stream-liveness.js";
import { observeProviderTelemetry } from "./stream-observe.js";
import { FUNCTION_TOOL_PRESENTATION, type CompletedStopReason, type ConnectedClient, type LLMClient, type ProviderStreamEvent, type StreamOptions, type ToolPresentation } from "./types.js";

interface UnknownFields { [key: string]: unknown }
function isUnknownFields<T>(value: T): value is T & UnknownFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
interface ThinkingBudgetOverrides {
  low?: number;
  medium?: number;
  high?: number;
}

interface GoogleClientOverrides {
  generateContentStream: (request: GenerateContentParameters) => ReturnType<GoogleGenAI["models"]["generateContentStream"]>;
  apiErrorStatus: (error: Error) => number | undefined;
}

async function createGoogleClientOverrides(apiKey: Redacted.Redacted<string>, vertex: boolean): Promise<GoogleClientOverrides> {
  // Vertex express mode: same Gemini wire on aiplatform.googleapis.com, the
  // API key sent as x-goog-api-key with no project or location (verified live).
  const identity = { httpOptions: { headers: await providerRequestHeaders() } };
  const client = new GoogleGenAI(vertex ? { vertexai: true, apiKey: Redacted.value(apiKey), ...identity } : { apiKey: Redacted.value(apiKey), ...identity });
  return {
    generateContentStream: (request) => client.models.generateContentStream(request),
    apiErrorStatus: (error: Error) => error instanceof ApiError ? error.status : undefined,
  };
}

/** The two access providers this adapter serves; they differ only in the
 *  endpoint host the SDK targets and the identity stamped on the stream. */
export type GoogleAccessProvider = "google_api" | "google_vertex";

export async function createGoogleAdapter(
  apiKey: Redacted.Redacted<string>,
  defaultModel: string,
  openingInfo: ModelInfo,
  overrides?: { client?: GoogleClientOverrides; accessProvider?: GoogleAccessProvider },
): Promise<ConnectedClient> {
  const accessProvider = overrides?.accessProvider ?? "google_api";
  const client = overrides?.client ?? await createGoogleClientOverrides(apiKey, accessProvider === "google_vertex");
  // Counter for synthesizing tool_call IDs when Gemini doesn't supply one.
  // Factory-scoped so each adapter instance has its own monotonic source
  // and no module-level singleton exists.
  let toolCallCounter = 0;

  /** The client that lowers each request on `info` over this adapter's connection (`ConnectedClient`). */
  const withModelInfo = (info: ModelInfo): LLMClient => {
    const adapter = {
      accessProvider,
      modelFamily: "google",
      model: defaultModel,
      toolPresentation: FUNCTION_TOOL_PRESENTATION,
      contextLimit: info.contextLimit,
      outputLimit: info.outputLimit,
      supportsReasoning: info.reasoning,

      priceFor(tokens) {
        return computeUsagePrice(tokens, info.pricing, GOOGLE_CACHE_RATES);
      },

      historyTarget: (options: StreamOptions) => googleHistoryTarget({ accessProvider, model: options.model ?? defaultModel }),

      async *streamWithTools(options: StreamOptions): AsyncGenerator<ProviderStreamEvent> {
        const modelId = options.model ?? defaultModel;
        const requestedReasoning = options.reasoningEffort;

        const contents = toGoogleGenerativeAiRequest({
          accessProvider,
          provider: "google",
          model: modelId,
          supportsImages: supportsGoogleImages(info),
        }, options.messages);

        const googleOpts = options.providerOptions?.google;
        const systemPrompt = renderSystemPrompt(options.systemPrompt);
        // Tool choice is cross-provider via `options.toolChoice`; converted to
        // Google's `toolConfig.functionCallingConfig` shape.
        const toolChoice = buildGoogleToolConfig(options.toolChoice);

        // `abortSignal` is added inside the attempt so its lifetime is explicit.
        const baseConfig: GenerateContentConfig = {
          maxOutputTokens: info.outputLimit,
          ...(systemPrompt && { systemInstruction: sanitizeSurrogates(systemPrompt) }),
          ...(options.tools.length > 0 && { tools: convertTools(options.tools, adapter.toolPresentation) }),
          ...(typeof googleOpts?.temperature === "number" ? { temperature: googleOpts.temperature } : {}),
          ...(toolChoice ? { toolConfig: toolChoice } : {}),
        };
        yield* withStreamAttempt<ProviderStreamEvent>(async function* (attempt) {
          const runId = crypto.randomUUID();
          const effort = clampEffort(requestedReasoning);
          const config: GenerateContentConfig = { ...baseConfig, abortSignal: attempt.signal };
          if (info.reasoning) {
            const thinkingConfig = getThinkingConfig(modelId, effort, googleOpts?.thinking_budgets);
            if (thinkingConfig) config.thinkingConfig = thinkingConfig;
          }
          const request: GenerateContentParameters = { model: modelId, contents, config };

          const streamLiveness = armStreamLiveness(attempt, { label: "llm-google", provider: "Google", telemetry: options.telemetry });
          // `final` marks usage read from the chunk that ended the response; earlier usage is a lower bound.
          let usage: { input: number; output: number; cacheRead: number; reasoning: number; final: boolean } | undefined;
          const usageEvent = () => usage ? ({
            kind: "usage",
            final: usage.final,
            inputTokens: usage.input,
            outputTokens: usage.output,
            cacheReadTokens: usage.cacheRead,
            cacheCreateTokens: 0,
            reasoningTokens: usage.reasoning,
          } as const) : undefined;

          {
            let rawFinishReason: FinishReason | undefined;
            // A blocked prompt returns no candidate, so no finish reason; the
            // block is the provider's statement about the request content.
            let promptBlock: GoogleTerminalState["promptBlock"];
            let sawToolCall = false;
            // Gemini occasionally repeats a functionCall id across parallel calls
            // in one turn; a duplicate would collide the tool results and one
            // requested operation would silently never dispatch (the loop's
            // submittedIds guard drops it). Regenerate on collision (pi
            // `google-generative-ai.ts:185-191`).
            const seenToolCallIds = new Set<string>();
            let thinkingBuffer = "";
            let thinkingActive = false;
            let textRunOrdinal = 0;
            let thinkingRunOrdinal = 0;
            let responseId: string | undefined;
            let contextUpdateEmitted = false;
            let responseStarted = false;
            // M1: per-block signature retention. Gemini emits `thoughtSignature` on
            // the last chunk of a logical block (text or thinking), so we accumulate
            // across chunks of the same block and only emit on block boundaries.
            let currentTextSignature: string | undefined;
            let currentThinkingSignature: string | undefined;
            // Track whether we're currently in a text run, so we can yield
            // text_complete at the block boundary (text → thinking, text → tool,
            // or text → end-of-stream) symmetric with thinking_complete above.
            let inTextRun = false;
            const flushThinking = function* (): Generator<ProviderStreamEvent> {
              if (!thinkingActive) return;
              const blockKey = `${runId}:thinking:${thinkingRunOrdinal}`;
              streamLiveness.complete(blockKey);
              if (thinkingBuffer) {
                yield {
                  kind: "thinking_complete",
                  thinking: thinkingBuffer,
                  blockKey,
                  ...(currentThinkingSignature ? { signature: currentThinkingSignature } : {}),
                };
              }
              thinkingRunOrdinal += 1;
              thinkingBuffer = "";
              thinkingActive = false;
              currentThinkingSignature = undefined;
            };
            const closeTextRun = function* (): Generator<ProviderStreamEvent> {
              if (!inTextRun) return;
              yield { kind: "text_complete", blockKey: `${runId}:text:${textRunOrdinal}` } as const;
              textRunOrdinal += 1;
              inTextRun = false;
              currentTextSignature = undefined;
            };

            streamLiveness.preStream();
            await options.onDispatch?.();
            const stream = await invokeProviderAttempt(async () => {
              try {
                return await client.generateContentStream(request);
              } catch (error) {
                throw classifyGoogleError(error, client.apiErrorStatus);
              }
            });
            const providerChunks = stream[Symbol.asyncIterator]();
            let exhausted = false;
            let failed = false;
            try {
            while (true) {
              let result: Awaited<ReturnType<typeof providerChunks.next>>;
              try {
                result = await invokeProviderAttempt(async () => {
                  try {
                    return await providerChunks.next();
                  } catch (error) {
                    throw classifyGoogleError(error, client.apiErrorStatus);
                  }
                });
              } catch (error) {
                const finalUsage = usageEvent();
                if (finalUsage) yield finalUsage;
                throwIfLivenessFailure(error, attempt, options.signal);
                throw error;
              }
              if (result.done) {
                exhausted = true;
                break;
              }
              const chunk = result.value;
              streamLiveness.frame();
              if (!responseStarted) {
                responseStarted = true;
                yield { kind: "provider_response_started" } as const;
              }
              observeProviderTelemetry(options.telemetry, "chunk", {
                candidateCount: chunk.candidates?.length ?? 0,
                partCount: chunk.candidates?.[0]?.content?.parts?.length ?? 0,
                hasUsage: chunk.usageMetadata !== undefined,
              });
              const candidate = chunk.candidates?.[0];
              for (const part of candidate?.content?.parts ?? []) {
                if (part.text !== undefined) {
                  if (isThinkingPart(part)) {
                    yield* closeTextRun();
                    if (!thinkingActive) {
                      streamLiveness.begin(`${runId}:thinking:${thinkingRunOrdinal}`);
                      thinkingActive = true;
                    }
                    thinkingBuffer += part.text;
                    if (part.text) streamLiveness.append(part.text);
                    currentThinkingSignature = retainThoughtSignature(currentThinkingSignature, part.thoughtSignature);
                    yield { kind: "thinking_delta", text: part.text, blockKey: `${runId}:thinking:${thinkingRunOrdinal}` };
                  } else {
                    yield* flushThinking();
                    currentTextSignature = retainThoughtSignature(currentTextSignature, part.thoughtSignature);
                    inTextRun = true;
                    yield {
                      kind: "text_delta",
                      text: part.text,
                      blockKey: `${runId}:text:${textRunOrdinal}`,
                      ...(currentTextSignature ? { signature: currentTextSignature } : {}),
                    };
                  }
                }
                if (part.functionCall) {
                  yield* flushThinking();
                  yield* closeTextRun();
                  sawToolCall = true;
                  const wireId = part.functionCall.id;
                  const id = !wireId || seenToolCallIds.has(wireId)
                    ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
                    : wireId;
                  seenToolCallIds.add(id);
                  const input = part.functionCall.args ?? {};
                  yield { kind: "tool_input_start", toolUseId: id, name: part.functionCall.name || "" };
                  yield { kind: "tool_input_delta", toolUseId: id, partialJson: JSON.stringify(input) };
                  yield {
                    kind: "tool_use",
                    toolCall: {
                      id,
                      name: part.functionCall.name || "",
                      input,
                      // Gemini 3 thinking-replay: preserve thoughtSignature on functionCall parts.
                      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
                    },
                  };
                  currentTextSignature = undefined;
                }
              }
              if (candidate?.finishReason) rawFinishReason = candidate.finishReason;
              const blockReason = chunk.promptFeedback?.blockReason;
              if (blockReason) promptBlock = { reason: blockReason, message: chunk.promptFeedback?.blockReasonMessage };
              // pi `google.ts:91` uses `output.responseId ||= chunk.responseId`;
              // first non-empty wins. Gemini emits the response id on the first
              // chunk; later chunks shouldn't overwrite it.
              if (!responseId && chunk.responseId) {
                responseId = chunk.responseId;
              }
              if (chunk.usageMetadata) {
                const promptTotal = chunk.usageMetadata.promptTokenCount ?? 0;
                const cached = chunk.usageMetadata.cachedContentTokenCount ?? 0;
                const candidates = chunk.usageMetadata.candidatesTokenCount ?? 0;
                const thoughts = chunk.usageMetadata.thoughtsTokenCount ?? 0;
                // Emitting context_update on the first chunk with a non-zero
                // promptTokenCount gives the agent loop the server-counted prompt
                // size mid-stream, matching Anthropic's `message_start` signal.
                if (!contextUpdateEmitted && promptTotal > 0) {
                  contextUpdateEmitted = true;
                  yield { kind: "context_update", promptTokens: promptTotal, contextWindow: info.contextLimit } as const;
                }
                usage = {
                  input: promptTotal - cached,
                  // Google bills thoughts at the output rate, so fold them into
                  // `output` for accurate cost accounting (pi full-fat's choice).
                  // `reasoning` is reported separately for observability.
                  output: candidates + thoughts,
                  cacheRead: cached,
                  reasoning: thoughts,
                  final: rawFinishReason !== undefined || promptBlock !== undefined,
                };
              }
            }
            } catch (error) {
              failed = true;
              throw error;
            } finally {
              if (!exhausted) {
                try {
                  await providerChunks.return?.(undefined);
                } catch (error) {
                  // oxlint-disable-next-line no-unsafe-finally -- boundary: cleanup failure escapes only when no stream or consumer failure exists.
                  if (!failed) throw error;
                }
              }
            }
            yield* flushThinking();
            yield* closeTextRun();
            const finalUsage = usageEvent();
            if (finalUsage) yield finalUsage;
            const stopReason = resolveGoogleStopReason({ finishReason: rawFinishReason, promptBlock, sawToolCall });
            yield {
              kind: "done",
              stopReason,
              metadata: {
                api: "google-generative-ai",
                provider: "google",
                model: modelId,
                timestamp: Date.now(),
                ...(responseId ? { responseId } : {}),
                stopReason,
              },
            };
          }
          }, options);
      },

    } satisfies LLMClient;

    return adapter;
  };

  return Object.assign(withModelInfo(openingInfo), { withModelInfo });
}

// Provider-shape mapping (formerly google-helpers.ts; single consumer, merged
// back - same cohesive-adapter shape as anthropic.ts).

type ClampedEffort = "off" | "low" | "medium" | "high";

function clampEffort(effort: ReasoningEffort | undefined): ClampedEffort {
  if (!effort || effort === "off") return "off";
  if (effort === "low") return "low";
  if (effort === "high" || effort === "xhigh" || effort === "max" || effort === "ultra") return "high";
  return "medium";
}

function getThinkingConfig(
  model: string,
  effort: ClampedEffort,
  budgetOverrides?: ThinkingBudgetOverrides,
): ThinkingConfig | undefined {
  const thinkingConfigMode = geminiThinkingConfigMode(model);
  if (effort === "off") {
    if (thinkingConfigMode === "budget") return { thinkingBudget: 0 };
    const isPro = /gemini-3(?:\.\d+)?-pro/i.test(model);
    return { thinkingLevel: isPro ? ThinkingLevel.LOW : ThinkingLevel.MINIMAL };
  }
  if (thinkingConfigMode === "level") {
    return { includeThoughts: true, thinkingLevel: thinkingLevelForModel(model, effort) };
  }
  return { includeThoughts: true, thinkingBudget: thinkingBudgetForModel(model, effort, budgetOverrides) };
}

function classifyGoogleError(error: unknown, apiErrorStatus: (error: Error) => number | undefined): Error {
  const message = errorMessage(error);
  const cause = error;
  const providerError = error instanceof Error ? error : new Error(String(error));
  // The SDK's ApiError states the HTTP status; other shapes state it only in
  // the message. The shared classifier must run before the rate-limit branch:
  // a 402 or a spent-quota 429 is terminal for the account, and reading it as
  // a rate limit would burn the retry schedule instead of advancing the chain.
  const status = apiErrorStatus(providerError);
  const quotaStatus = status ?? (/402/.test(message) ? 402
    : /429/.test(message) ? 429
      : undefined);
  const throttle = quotaStatus === 429 ? googleRateLimit(message, cause) : undefined;
  if (throttle) return throttle;
  const quota = classifyQuotaError(quotaStatus, message, cause);
  if (quota) return quota;
  if (/quota.?exceeded|billing (?:account|quota)|credit (?:balance|quota)/i.test(message)) return new QuotaExhaustedError(message, { cause });
  if (/context|token.*exceed|too\s+long/i.test(message)) return new ContextLengthExceededError(message, { cause });
  if (status === 404 && /\bmodels?\b/i.test(message)) return new ModelAccessRefusedError(message, { kind: "model" }, { cause });
  if (status === 429) return new LlmStreamError(message, "rate_limit", undefined, { cause });
  if (status !== undefined && status >= 500) return new LlmStreamError(message, "overload", undefined, { cause });
  if (status === undefined) {
    if (/429|rate.?limit/i.test(message)) return new LlmStreamError(message, "rate_limit", undefined, { cause });
    if (/5\d\d|overload|unavailable|temporar/i.test(message)) return new LlmStreamError(message, "overload", undefined, { cause });
  }
  // Network tears (ECONNRESET, socket hang up, Premature close) that the Google
  // SDK doesn't classify. Without this, the retry policy can't recover them.
  if (isTransientNetworkError(error)) return new LlmStreamError(message, "transient", undefined, { cause });
  return error instanceof Error ? error : new Error(String(error));
}

/** A Google quota that a wait of moments cannot clear: a per-day limit, a
 *  limit of zero, which the plan does not grant, or a billing or credit limit. */
const GOOGLE_SPENT_QUOTA_TEXT = /PerDay|per.?day|limit: 0\b|"quotaValue":\s*"0"|billing (?:account|quota)|credit (?:balance|quota)/i;

/** Google states every 429 as RESOURCE_EXHAUSTED and "Quota exceeded for
 *  metric", also a per-minute request or token limit that clears in seconds.
 *  Such a limit names a per-minute quota id or states when to retry, in a
 *  RetryInfo detail or as "Please retry in 52.7s". It is a rate limit with
 *  that delay, never a spent quota, unless it also names a spent quota. */
function googleRateLimit(message: string, cause: unknown): LlmStreamError | undefined {
  if (GOOGLE_SPENT_QUOTA_TEXT.test(message)) return undefined;
  const delay = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(message) ?? /Please retry in (\d+(?:\.\d+)?)s\b/i.exec(message);
  if (delay === null && !/PerMinute|per.?minute/i.test(message)) return undefined;
  const retryDelayMs = delay === null ? undefined : Math.ceil(Number(delay[1]) * 1_000);
  return new LlmStreamError(message, "rate_limit", retryDelayMs, { cause });
}

interface GoogleTerminalState {
  readonly finishReason: FinishReason | undefined;
  readonly promptBlock: { readonly reason: string; readonly message: string | undefined } | undefined;
  readonly sawToolCall: boolean;
}

/** Resolves the stream's terminal state to the completed stop reason, or
 *  throws the normalized provider failure that a response which did not
 *  complete owes the walk. */
function resolveGoogleStopReason({ finishReason, promptBlock, sawToolCall }: GoogleTerminalState): CompletedStopReason {
  if (finishReason === undefined) {
    // A refusal of the conversation content: never retried or failed over,
    // because every candidate receives the same content.
    if (promptBlock) {
      const { reason, message } = promptBlock;
      throw normalizeProviderAttemptFailure(new ContentRefusedError(
        "Google",
        new Error(`Google blocked the prompt: ${reason}${message ? `: ${message}` : ""}`),
        { reason, part: undefined, policy: reason },
      ));
    }
    // A broken response (proxy drop), not a clean end_turn; fail transient so
    // outer recovery can handle it (pi `google-generative-ai.ts:266-268`).
    throw normalizeProviderAttemptFailure(new LlmStreamError("Google stream ended without a finish reason", "transient"));
  }
  switch (finishReason) {
    // Gemini returns STOP even when the model emitted tool calls, so the loop
    // must be told to continue iterating instead of finalizing.
    case FinishReason.STOP: return sawToolCall ? "tool_use" : "end_turn";
    case FinishReason.MAX_TOKENS:
      throw normalizeProviderAttemptFailure(new OutputLengthExceededError(`Response truncated: ${finishReason}`));
    case FinishReason.BLOCKLIST:
    case FinishReason.PROHIBITED_CONTENT:
    case FinishReason.SPII:
    case FinishReason.SAFETY:
    case FinishReason.IMAGE_SAFETY:
    case FinishReason.IMAGE_PROHIBITED_CONTENT:
    case FinishReason.IMAGE_RECITATION:
    case FinishReason.IMAGE_OTHER:
    case FinishReason.RECITATION:
    case FinishReason.LANGUAGE:
      return "content_filter";
    default:
      // MALFORMED_FUNCTION_CALL, UNEXPECTED_TOOL_CALL, NO_IMAGE, OTHER,
      // FINISH_REASON_UNSPECIFIED, and future values are provider-side
      // generation failures: surface the raw reason instead of finalizing the
      // turn as a silent success (pi `google-generative-ai.ts:269-274`).
      throw normalizeProviderAttemptFailure(new LlmStreamError(`Google stream finished with finish reason ${finishReason}`, "transient"));
  }
}

function retainThoughtSignature(
  existing: string | undefined,
  incoming: string | undefined,
): string | undefined {
  return incoming || existing;
}

function buildGoogleToolConfig(
  toolChoice: "auto" | "any" | "none" | { type: "tool"; name: string } | undefined,
): ToolConfig | undefined {
  if (!toolChoice) return undefined;
  if (toolChoice === "auto") return { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
  if (toolChoice === "any") return { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } };
  if (toolChoice === "none") return { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
  return { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY, allowedFunctionNames: [toolChoice.name] } };
}

function convertTools(tools: StreamOptions["tools"], presentation: ToolPresentation): Tool[] | undefined {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => {
        const presented = presentation.present(t);
        return { name: t.name, description: presented.description, parametersJsonSchema: sanitizeForOpenApi(presented.inputFormat) };
      }),
    },
  ];
}

function supportsGoogleImages(info: ModelInfo): boolean {
  return info.modalities.input.includes("image");
}

function isThinkingPart(part: Pick<Part, "thought">): boolean {
  return part.thought === true;
}

function thinkingLevelForModel(model: string, effort: Exclude<ClampedEffort, "off">): ThinkingLevel {
  if (/gemini-3(?:\.\d+)?-pro/i.test(model)) {
    return effort === "low" ? ThinkingLevel.LOW : ThinkingLevel.HIGH;
  }
  if (/gemma-?4/i.test(model)) {
    return effort === "low" ? ThinkingLevel.MINIMAL : ThinkingLevel.HIGH;
  }
  return effort === "low" ? ThinkingLevel.LOW
    : effort === "medium" ? ThinkingLevel.MEDIUM
    : ThinkingLevel.HIGH;
}

function thinkingBudgetForModel(
  model: string,
  effort: Exclude<ClampedEffort, "off">,
  overrides?: ThinkingBudgetOverrides,
): number {
  const override = overrides?.[effort];
  if (typeof override === "number") return override;
  if (model.includes("2.5-pro")) return { low: 2048, medium: 8192, high: 32768 }[effort]; // provider-model-literal-allow: payload -- Google thinking budget wire compatibility
  if (model.includes("2.5-flash-lite")) return { low: 2048, medium: 8192, high: 24576 }[effort]; // provider-model-literal-allow: payload -- Google thinking budget wire compatibility
  if (model.includes("2.5-flash")) return { low: 2048, medium: 8192, high: 24576 }[effort]; // provider-model-literal-allow: payload -- Google thinking budget wire compatibility
  return -1;
}

// Annotation-only keys that add nothing on the wire. Structural keys ($defs,
// definitions, $id, $anchor) MUST pass through: `parametersJsonSchema` takes
// full JSON Schema, and stripping $defs breaks every $ref that points into it
// (pi passes the schema through untouched, `google-shared.ts:283-285`).
const JSON_SCHEMA_ANNOTATION_KEYS = new Set(["$schema", "$comment"]);

function sanitizeForOpenApi(schema: UnknownFields): UnknownFields {
  const result: UnknownFields = {};
  for (const [key, value] of Object.entries(schema)) {
    if (JSON_SCHEMA_ANNOTATION_KEYS.has(key)) continue;
    result[key] = isUnknownFields(value) ? sanitizeForOpenApi(value) : value;
  }
  return result;
}
