/**
 * ChatGPT backend WebSocket transport wrapper for the Flywheel agent runtime ChatGPT path.
 *
 * Builds the WebSocket URL + handshake headers from the ChatGPT auth, sends
 * the request body Flywheel agent runtime already built (via `buildOpenAIParams`), and yields
 * `ResponseStreamEvent`, the same shape as `createOpenAIStream` returns,
 * so the existing OpenAI adapter event loop can consume it unchanged.
 *
 * Connection-cached continuation (delta requests on subsequent turns that
 * reuse `previous_response_id`) goes through `commitContinuation`.
 *
 * Flywheel names this wire after the ChatGPT subscription it authenticates
 * with, so the access-provider id, adapter, and transport stay consistent end
 * to end.
 */

import type { ResponseCreateParamsStreaming, ResponseInput, ResponseStreamEvent } from "openai/resources/responses/responses.js";
import type { StoredTokens } from "../../../../infra/auth/openai-auth-types.js";
import { isAbortError } from "../../../../infra/abort.js";
import { Log } from "../../../../infra/log.js";
import { openAISessionAffinityHeaders } from "../openai-helpers.js";
import type { ChatGPTTokenAccessor } from "../openai-chatgpt.js";
import type { StreamOptions } from "../types.js";
import { runtimeWebSocket } from "./deps.js";
import { buildWebSocketHeaders, createChatGptAdapterRequestId, extractAccountId, resolveChatGptAdapterWebSocketUrl } from "./request.js";
import { ChatGptAdapterTransportError, type RequestBody } from "./types.js";
import { streamChatGptAdapterWebSocket } from "./websocket.js";
import { isWebSocketSseFallbackActive, recordWebSocketFailure } from "./websocket-session.js";

const log = Log.create({ service: "chatgpt-adapter-ws" });

interface ChatGptAdapterTransportParams {
  tokenAccessor: ChatGPTTokenAccessor;
  projectRoot?: string;
  /** The conversation identity. It keys the pooled socket, its continuation,
   *  and the SSE fallback cooldown, so siblings that share a cache group never
   *  share transport state. */
  providerSessionKey?: string;
  /** The cache group that the handshake session headers carry. */
  promptCacheKey?: string;
  /** Cache-disabled requests use an uncached connection with no continuation state. */
  cacheRetention?: StreamOptions["cacheRetention"];
  signal?: AbortSignal;
  params: ResponseCreateParamsStreaming;
  /** Called immediately before the WebSocket handshake starts. */
  onDispatch?: () => void | Promise<void>;
}

interface ChatGptAdapterTransportResult {
  events: AsyncGenerator<ResponseStreamEvent>;
  commitContinuation: (items: ResponseInput | undefined, responseId: string | undefined) => void;
}

/**
 * Returns `null` if WebSocket transport is unavailable for this session
 * (previously fell back to SSE due to a transport error). Callers should
 * use the SSE path in that case.
 */
export async function tryChatGptAdapterTransport(
  args: ChatGptAdapterTransportParams,
): Promise<ChatGptAdapterTransportResult | null> {
  if (typeof runtimeWebSocket() !== "function") return null;
  if (isWebSocketSseFallbackActive(args.providerSessionKey)) return null;

  // Pull a fresh token at handshake time so long-lived sessions that span the
  // refresh boundary do not 401.
  let tokens: StoredTokens;
  try {
    tokens = await args.tokenAccessor.fresh({ caller: "model request" });
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    const error = new ChatGptAdapterTransportError("setup", cause);
    log.warn(`${error.message}; SSE selected`);
    recordWebSocketFailure(args.providerSessionKey);
    return null;
  }

  const accountId = tokens.accountId ?? extractAccountId(tokens.accessToken);

  const url = resolveChatGptAdapterWebSocketUrl();
  // Only sessionless requests need a generated handshake identity.
  const affinityHeaders = openAISessionAffinityHeaders({
    providerSessionKey: args.providerSessionKey ?? createChatGptAdapterRequestId(),
    promptCacheKey: args.promptCacheKey,
    cacheRetention: args.cacheRetention,
  }, true);
  let headers: Headers;
  try {
    headers = await buildWebSocketHeaders(accountId, tokens.accessToken, affinityHeaders);
  } catch (cause) {
    if (isAbortError(cause)) throw cause;
    const error = new ChatGptAdapterTransportError("setup", cause);
    log.warn(error.message);
    recordWebSocketFailure(args.providerSessionKey);
    return null;
  }

  // OpenAI's SDK params shape is a structural superset of pi's `RequestBody`
  // (both target the ChatGPT backend Responses API wire format), so pass through.
  // SAFETY: ResponseCreateParamsStreaming is the SDK type for the same ChatGPT backend Responses wire body RequestBody models; the open `[key: string]: unknown` index makes RequestBody a structural superset, so the bridge only re-narrows to our local alias.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the OpenAI SDK request and ChatGPT backend request describe the same external wire body
  const body = args.params as RequestBody;
  await args.onDispatch?.();

  try {
    return await streamChatGptAdapterWebSocket(url, body, headers, {
      accountId,
      sessionId: args.cacheRetention === "none" ? undefined : args.providerSessionKey,
      signal: args.signal,
      projectRoot: args.projectRoot,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof ChatGptAdapterTransportError && error.phase === "setup") {
      log.warn("ChatGPT backend WebSocket setup failed; SSE selected");
      recordWebSocketFailure(args.providerSessionKey);
      return null;
    }
    throw error;
  }
}
