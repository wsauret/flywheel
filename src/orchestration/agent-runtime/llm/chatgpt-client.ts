import * as os from "node:os";
import { Redacted } from "effect";
import OpenAI from "openai";
import type { OAuthPersistencePolicy } from "../../../infra/auth/auth-context.js";
import { CHATGPT_BACKEND_API_BASE, type OpenAIAuth } from "../../../infra/auth/openai-auth-types.js";
import { extractAccountIdFromJwt } from "../../../infra/auth/openai-jwt.js";
import type { AccessProviderCandidate } from "../../../infra/llm/access-provider.js";
import { Log } from "../../../infra/log.js";
import { parseChatGptAdapterErrorResponse } from "./chatgpt-adapter-error.js";
import { createChatGPTTokenAccessor, dumpFailedChatGptRequest, logRejectedChatGptRequest, type ChatGPTTokenAccessor } from "./openai-chatgpt.js";
import type { ProviderAvailability } from "./provider-availability-types.js";

// The ChatGPT backend's HTTP client. It is the one part of the ChatGPT route that needs the OpenAI SDK, so it loads
// with the adapter when the route opens its first connection. The token owners in `openai-chatgpt.ts` load without it.

const log = Log.create({ service: "llm-openai-chatgpt" });

interface StringFields { [key: string]: string }
interface ChatGptBackendError { readonly response: Response; readonly quotaExhausted: boolean }
type ChatGPTAuth = Extract<OpenAIAuth, { kind: "chatgpt" }>;
type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export const CHATGPT_SSE_ZSTD_MIN_BYTES = 1_024;
export const CHATGPT_SSE_ZSTD_MAX_BYTES = 1_048_576;

/** Builds the ChatGPT backend client. `availability` is the account binding
 *  every usage header and terminal error on this transport is folded into.
 *  The adapter forwards the binding the composition root injected; a client
 *  built outside it names no account and states nothing.
 *  Profile token rotations use the candidate-bound compare-and-set capability.
 *  `projectRoot` is the startup-selected project root a failed-request dump is
 *  written under; it is absent only for a client built outside the composition
 *  root, which has no project to write under and so writes no dump. */
export function createChatGPTClient(options: {
  readonly auth: ChatGPTAuth;
  readonly projectRoot?: string;
  readonly oauthPersistence: OAuthPersistencePolicy;
  readonly tokenAccessor?: ChatGPTTokenAccessor;
  readonly transportFetch?: FetchLike;
  readonly availability?: ProviderAvailability;
  readonly candidate?: AccessProviderCandidate;
}): OpenAI {
  const { auth, oauthPersistence, projectRoot, transportFetch = fetch, availability, candidate } = options;
  const tokenAccessor = options.tokenAccessor ?? createChatGPTTokenAccessor({ seed: auth, persistence: oauthPersistence });
  // ChatGPT backend expects these on every request. Without `OpenAI-Beta:
  // responses=experimental`, some endpoint variants 400 or silently downgrade.
  // `originator` and `session-id` enable server-side trace correlation and
  // prompt-cache reuse across the same logical conversation. Ported from
  // pi `codex-request.ts:116-152` (now `packages/ai/src/api/openai-codex-responses.ts`).
  const staticHeaders: StringFields = {
    "OpenAI-Beta": "responses=experimental",
    originator: "flywheel",
    "User-Agent": `flywheel (${os.platform()} ${os.release()}; ${os.arch()})`,
  };

  return new OpenAI({
    baseURL: CHATGPT_BACKEND_API_BASE,
    apiKey: "chatgpt-oauth",
    defaultHeaders: staticHeaders,
    // withRetryStream owns retries; SDK retries would stack multiplicatively.
    maxRetries: 0,
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      const tokens = await tokenAccessor.fresh({ signal: init?.signal ?? undefined, caller: "model request" });
      const accountId = tokens.accountId ?? extractAccountIdFromJwt(Redacted.value(tokens.accessToken));
      const headers = chatGPTRequestHeaders(init?.headers, staticHeaders, tokens.accessToken, accountId);
      const compressed = compressedChatGptSseRequest(init, headers);
      const res = await transportFetch(url, compressed);
      const backendError = await chatGptBackendErrorResponse(res, url, init?.body, projectRoot);
      // Terminal quota bodies own their observation in the common stream catch,
      // where the durable transition can travel with the typed failure.
      if (availability && candidate && backendError?.quotaExhausted !== true) {
        availability.observeChatGptRateHeaders(candidate, res.headers);
      }
      return backendError?.response ?? res;
    },
  });
}

function compressedChatGptSseRequest(init: RequestInit | undefined, headers: StringFields): RequestInit {
  const body = init?.body;
  if (typeof body !== "string" || new Headers(headers).has("content-encoding")) return { ...init, headers };
  const size = Buffer.byteLength(body);
  if (size < CHATGPT_SSE_ZSTD_MIN_BYTES || size > CHATGPT_SSE_ZSTD_MAX_BYTES) return { ...init, headers };
  try {
    const compressedBody = new Uint8Array(Bun.zstdCompressSync(body, { level: 3 }));
    const compressedHeaders = { ...headers };
    delete compressedHeaders["content-length"];
    return { ...init, headers: { ...compressedHeaders, "content-encoding": "zstd" }, body: compressedBody };
  } catch {
    return { ...init, headers, body };
  }
}

function chatGPTRequestHeaders(
  initHeaders: HeadersInit | undefined,
  staticHeaders: StringFields,
  accessToken: Redacted.Redacted<string>,
  accountId: string | undefined,
): StringFields {
  // Provider-call adapter: the token is unwrapped only into the header.
  const headers = normalizedHeaders(initHeaders);
  Object.assign(headers, staticHeaders);
  headers.authorization = `Bearer ${Redacted.value(accessToken)}`;
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

function normalizedHeaders(initHeaders: HeadersInit | undefined): StringFields {
  const headers: StringFields = {};
  if (initHeaders instanceof Headers) {
    for (const [key, value] of initHeaders) headers[key] = value;
    return headers;
  }
  if (Array.isArray(initHeaders)) {
    for (const [key, value] of initHeaders) if (key !== undefined && value !== undefined) headers[key] = value;
    return headers;
  }
  if (initHeaders && typeof initHeaders === "object") Object.assign(headers, initHeaders);
  return headers;
}

async function chatGptBackendErrorResponse(
  res: Response,
  url: RequestInfo | URL,
  requestBody: BodyInit | null | undefined,
  projectRoot: string | undefined,
): Promise<ChatGptBackendError | null> {
  if (res.ok) return null;

  const body = await res.clone().text().catch(() => {
    log.warn("failed to read ChatGPT error response body", { status: res.status });
    return "";
  });
  const parsed = await parseChatGptAdapterErrorResponse(new Response(body, { status: res.status }));
  const { friendlyMessage } = parsed;
  log.warn("ChatGPT backend API error", { status: res.status, ...(parsed.code ? { code: parsed.code } : {}) });
  if (res.status >= 400) {
    logRejectedChatGptRequest(typeof requestBody === "string" ? requestBody : null, "http");
    if (res.status < 500) dumpFailedChatGptRequest(projectRoot, res.status, requestBody, body);
  }
  return friendlyMessage
    ? { response: friendlyChatGptAdapterErrorResponse(res, friendlyMessage, parsed.code, parsed.resetsAtSeconds), quotaExhausted: parsed.quotaExhausted }
    : null;
}

function friendlyChatGptAdapterErrorResponse(res: Response, friendlyMessage: string, code: string | undefined, resetsAtSeconds: number | undefined): Response {
  const augmented = JSON.stringify({
    error: {
      message: friendlyMessage,
      type: "chatgpt_usage_limit",
      code: code ?? "http_error",
      ...(resetsAtSeconds === undefined ? {} : { resets_at: resetsAtSeconds }),
    },
  });
  return new Response(augmented, {
    status: res.status,
    statusText: "Provider request failed",
    headers: res.headers,
  });
}
