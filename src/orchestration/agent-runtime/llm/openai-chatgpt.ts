import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { Redacted } from "effect";
import type { StoredTokens } from "../../../infra/auth/openai-auth-types.js";
import { extractAccountIdFromJwt } from "../../../infra/auth/openai-jwt.js";
import { errorDetail, errorMessage } from "../../../infra/error-message.js";
import { durationMs } from "../../../infra/operation-log.js";
import { Log } from "../../../infra/log.js";
import { redactSecrets } from "../../../infra/redact-secrets.js";
import { LOG_DIR } from "../../../infra/paths.js";
import { applyWindowsPrivateDirectoryAcl, windowsDirectoryIsOwnerOnly } from "../../../infra/windows-private-directory-acl.js";
import { refreshAccessToken } from "../../auth/openai-oauth.js";
import type { ProviderConnection } from "../../../infra/auth/auth-context.js";
import { normalizeProviderAttemptFailure, ProviderAuthenticationError } from "./provider-failure.js";

const log = Log.create({ service: "llm-openai-chatgpt" });

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Write an opted-in, redacted failed request and response under the client's project root (ARCH-DIRECTORIES-003).
 * Windows requires verified owner-only directory access before any request bytes are written.
 * Missing project roots, unverified privacy, and write failures warn without throwing. */
export function dumpFailedChatGptRequest(projectRoot: string | undefined, status: number | "websocket", requestBody: unknown, responseBody: unknown): void {
  // Off by default: the request body is full prompt content and the response may
  // carry credential-bearing error envelopes, so persisting it unconditionally
  // leaks user data to disk. Only a developer who opts in gets a dump, and known
  // secret patterns are scrubbed from it even then.
  if (process.env.FLYWHEEL_DUMP_FAILED_REQUESTS !== "1") return;
  if (projectRoot === undefined) {
    log.warn("failed ChatGPT backend request not dumped: this client names no project root");
    return;
  }
  try {
    const dir = path.join(projectRoot, LOG_DIR, "chatgpt-adapter-failures");
    fs.mkdirSync(dir, { recursive: true });
    if (process.platform === "win32") {
      applyWindowsPrivateDirectoryAcl(dir);
      if (!windowsDirectoryIsOwnerOnly(dir)) throw new Error("ChatGPT dump directory is not owner-only");
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${status}.json`);
    const reqBody = typeof requestBody === "string" ? safeParseJson(requestBody) : requestBody;
    const resBody = typeof responseBody === "string" ? safeParseJson(responseBody) ?? responseBody : responseBody;
    const serialized = JSON.stringify({ status, request: reqBody, response: resBody }, null, 2);
    fs.writeFileSync(file, redactSecrets(serialized), { mode: 0o600 });
    log.info("dumped failed ChatGPT backend request", { path: file });
  } catch (err) {
    log.warn("failed to dump ChatGPT backend request", { error: errorMessage(err), errorDetail: errorDetail(err) });
  }
}

const diagnosticKeys = new Set([
  "model", "input", "instructions", "tools", "tool_choice", "parallel_tool_calls",
  "temperature", "reasoning", "service_tier", "text", "include", "prompt_cache_key",
  "store", "stream", "previous_response_id", "type", "role", "content", "id",
  "status", "name", "arguments", "call_id", "output", "format", "effort",
  "summary", "verbosity", "annotations", "strict", "parameters",
]);

type RequestFieldTypes = string | { count: number; items: RequestFieldTypes[] } | { [key: string]: RequestFieldTypes };

function requestFieldTypes(value: unknown, depth = 0): RequestFieldTypes {
  if (Array.isArray(value)) {
    return { count: value.length, items: depth >= 5 ? [] : value.slice(0, 32).map((item) => requestFieldTypes(item, depth + 1)) };
  }
  if (value !== null && typeof value === "object") {
    if (depth >= 5) return "object";
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => diagnosticKeys.has(key))
      .slice(0, 32)
      .map(([key, item]) => [key, requestFieldTypes(item, depth + 1)]));
  }
  return value === null ? "null" : typeof value;
}

/** Record bounded field types and item counts without request values on a backend rejection. A string body is
 *  read as the JSON that the request sent. */
export function logRejectedChatGptRequest(requestBody: unknown, transport: "http" | "websocket"): void {
  const sent = typeof requestBody === "string" ? safeParseJson(requestBody) : requestBody;
  log.warn("ChatGPT backend request rejected", { transport, requestFields: requestFieldTypes(sent) });
}

function safeParseJson(s: string): JsonValue | null {
  try {
    return JSON.parse(s);
  } catch (err) {
    log.debug("failed to parse ChatGPT backend error body as JSON", { error: errorMessage(err), errorDetail: errorDetail(err) });
    return null;
  }
}


const TOKEN_EXPIRY_BUFFER_MS = 60_000;

const chatGptRefreshes = new Map<string, ReturnType<typeof refreshAccessToken>>();

/** Which owner asked for a fresh token, so a refresh record says why it ran. */
type ChatGPTTokenCaller = "model request" | "usage check" | "web search" | "model catalog" | "auth snapshot"

/** A refresh never opens a browser: a rejected refresh surfaces as its error,
 *  and the person signs in again through /auth. */
export interface EnsureFreshChatGPTTokensOptions {
  readonly caller?: ChatGPTTokenCaller;
  signal?: AbortSignal;
  persistence?: import("../../../infra/auth/auth-context.js").OAuthPersistencePolicy;
  compareAndSet?: (expected: StoredTokens, next: StoredTokens, signal?: AbortSignal) => Promise<boolean>;
}

type RefreshChatGPTTokensOptions = EnsureFreshChatGPTTokensOptions & {
  readonly normalizeRefreshFailure?: boolean;
};

/** Prevents a long-lived client from sending with credentials for an account
 *  other than the immutable availability binding selected at construction. */
export function assertChatGptAccountUnchanged(expected: StoredTokens, actual: StoredTokens): void {
  if (expected.accountId !== undefined && actual.accountId !== undefined) {
    if (expected.accountId === actual.accountId) return;
    throw new ProviderAuthenticationError(
      `The ChatGPT account changed from ${expected.accountId} to ${actual.accountId}. Retry the request so provider routing and quota tracking bind to the new account.`,
    );
  }
  if (expected.accountId === undefined && actual.accountId === undefined
    && expected.refreshToken !== undefined && actual.refreshToken !== undefined
    && Redacted.value(expected.refreshToken) === Redacted.value(actual.refreshToken)) return;
  throw new ProviderAuthenticationError(
    "The ChatGPT credential identity changed. Retry the request so provider routing and quota tracking bind to the current account.",
  );
}

/** Stable diagnostic identity. Refresh coordination is owned by each accessor. */
export function chatGptRefreshIdentity(tokens: StoredTokens): string {
  if (tokens.accountId !== undefined) return `account:${tokens.accountId}`;
  const credential = tokens.refreshToken ?? tokens.accessToken;
  return `credential:${createHash("sha256").update(Redacted.value(credential)).digest("hex")}`;
}

function sharedChatGptRefresh(refreshToken: Redacted.Redacted<string>): ReturnType<typeof refreshAccessToken> {
  const key = createHash("sha256").update(Redacted.value(refreshToken)).digest("hex");
  const active = chatGptRefreshes.get(key);
  if (active) return active;
  const running = refreshAccessToken(refreshToken);
  const tracked = running.finally(() => {
    if (chatGptRefreshes.get(key) === tracked) chatGptRefreshes.delete(key);
  });
  chatGptRefreshes.set(key, tracked);
  return tracked;
}




function isTokenExpired(tokens: { expiresAtMs: number }): boolean {
  return tokens.expiresAtMs - TOKEN_EXPIRY_BUFFER_MS < Date.now();
}

function refreshChatGPTTokens(
  current: StoredTokens,
  options: RefreshChatGPTTokensOptions = {},
): Promise<StoredTokens> {
  const persist = options.persistence !== "memory-only" && options.persistence !== "access-only";
  const compareAndSet = options.compareAndSet;
  const profileCompareAndSet = (): NonNullable<typeof compareAndSet> => {
    if (compareAndSet === undefined) throw new ProviderAuthenticationError("ChatGPT profile token refresh requires a candidate-bound compare-and-set capability");
    return compareAndSet;
  };
  const started = performance.now();
  return (async () => {
    try {
      if (options.persistence === "access-only") {
        throw new ProviderAuthenticationError("ChatGPT access-only credentials cannot refresh. Create a new headless auth snapshot.");
      }
      if (persist) profileCompareAndSet();
      const refreshToken = current.refreshToken;
      if (!refreshToken) throw new ProviderAuthenticationError("The ChatGPT access token expired and no refresh token is saved. Run /auth and sign in to ChatGPT again.");
      const refresh = sharedChatGptRefresh(refreshToken);
      const refreshed = await boundedRefresh(
        options.normalizeRefreshFailure
          ? refresh.catch((error) => { throw normalizeProviderAttemptFailure(error); })
          : refresh,
        options.signal,
      );
      const currentAccountId = current.accountId ?? extractAccountIdFromJwt(Redacted.value(current.accessToken));
      const refreshedAccountId = extractAccountIdFromJwt(Redacted.value(refreshed.accessToken));
      if (currentAccountId === undefined || refreshedAccountId !== currentAccountId) {
        throw new ProviderAuthenticationError("The ChatGPT refresh returned a credential for a different or unknown account. Run /auth and reconnect this account.");
      }
      const next: StoredTokens = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken ?? refreshToken,
        expiresAtMs: Date.now() + refreshed.expiresIn * 1000,
        accountId: currentAccountId,
      };
      options.signal?.throwIfAborted();
      // A rotation is a state change: one record when it ends, naming who
      // asked, so a refresh storm reads apart from ordinary expiry.
      const replaced = persist ? await profileCompareAndSet()(current, next, options.signal) : undefined;
      log.info("ChatGPT access token refreshed", {
        caller: options.caller, durationMs: durationMs(started),
        stored: replaced === undefined ? "memory only" : replaced ? "saved" : "a newer saved token kept",
      });
      return next;
    } catch (err) {
      log.warn("ChatGPT access token refresh failed", { caller: options.caller, durationMs: durationMs(started), error: errorMessage(err) });
      throw err;
    }
  })();
}

const REFRESH_TIMEOUT_MS = 30_000;

/** Settles as `refresh` does, or fails when it outlasts its bound or `signal`
 *  aborts. The timer and the abort listener end with the race, so a refresh
 *  that answers leaves no timer behind to hold the event loop for 30 s. */
async function boundedRefresh<T>(refresh: Promise<T>, signal?: AbortSignal): Promise<T> {
  let stop = (): void => {};
  const deadline = new Promise<never>((_resolve, reject) => {
    const timeout = setTimeout(() => { reject(new Error("Token refresh timed out")); }, REFRESH_TIMEOUT_MS);
    const abort = (): void => { reject(signal?.reason); };
    stop = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([refresh, deadline]);
  } finally {
    stop();
  }
}

/** Returns fresh ChatGPT OAuth tokens, refreshing and persisting on expiry.
 *  `seed` is the credential captured at adapter construction and remains the
 *  sole token source for this runtime. */
async function freshChatGPTTokens(seed: StoredTokens, options: RefreshChatGPTTokensOptions = {}): Promise<StoredTokens> {
  if (!isTokenExpired(seed)) return seed;
  if (options.persistence === "access-only") throw new ProviderAuthenticationError("The delegated ChatGPT access token expired. Create a new headless auth snapshot.");
  return refreshChatGPTTokens(seed, options);
}

export function ensureFreshChatGPTTokens(seed: StoredTokens, options?: EnsureFreshChatGPTTokensOptions): Promise<StoredTokens> {
  return freshChatGPTTokens(seed, options);
}

/** Rotates the tokens now, whatever their remaining lifetime, and persists nothing: the caller owns persistence. */
export function rotateChatGPTTokens(current: StoredTokens, signal?: AbortSignal): Promise<StoredTokens> {
  return refreshChatGPTTokens(current, { caller: "auth snapshot", persistence: "memory-only", ...(signal === undefined ? {} : { signal }) });
}

export interface ChatGPTTokenAccessor {
  /** Returns the latest settled credential, refreshing it when required. */
  fresh(options?: Pick<EnsureFreshChatGPTTokensOptions, "signal" | "caller">): Promise<StoredTokens>;
}

/** Owns the latest settled ChatGPT credential for one client and account. */
export function createChatGPTTokenAccessor(options: {
  seed: StoredTokens;
  persistence: import("../../../infra/auth/auth-context.js").OAuthPersistencePolicy;
  compareAndSet?: (expected: StoredTokens, next: StoredTokens, signal?: AbortSignal) => Promise<boolean>;
}): ChatGPTTokenAccessor {
  let current = options.seed;
  let inFlight: Promise<StoredTokens> | undefined;
  return {
    fresh(refreshOptions = {}) {
      if (inFlight) return inFlight;
      const running = freshChatGPTTokens(current, {
        ...refreshOptions,
        persistence: options.persistence,
        compareAndSet: options.compareAndSet,
        normalizeRefreshFailure: true,
      }).then((next) => {
        current = next;
        return next;
      });
      const tracked: Promise<StoredTokens> = running.finally(() => {
        if (inFlight === tracked) inFlight = undefined;
      });
      inFlight = tracked;
      return tracked;
    },
  };
}

const connectionTokenAccessors = new WeakMap<ProviderConnection, Map<string, ChatGPTTokenAccessor>>();

/** Returns the mutable token owner for one exact captured ChatGPT instance. */
export function getConnectionChatGPTTokenAccessor(
  connection: ProviderConnection,
  instanceId: string,
  compareAndSet: (expected: StoredTokens, next: StoredTokens, signal?: AbortSignal) => Promise<boolean>,
): ChatGPTTokenAccessor {
  const accessors = connectionTokenAccessors.get(connection) ?? new Map<string, ChatGPTTokenAccessor>();
  connectionTokenAccessors.set(connection, accessors);
  const selectedId = instanceId;
  const existing = accessors.get(selectedId);
  if (existing) return existing;
  const credential = connection.subscriptionCredentials.get("chatgpt")?.find((entry) => entry.instanceId === selectedId)?.credential;
  if (credential?.type !== "oauth") throw new ProviderAuthenticationError("No ChatGPT tokens are bound to this provider connection.");
  const accessor = createChatGPTTokenAccessor({
    seed: { accessToken: credential.access, refreshToken: credential.refresh, expiresAtMs: credential.expires, ...(credential.accountId === undefined ? {} : { accountId: credential.accountId }) },
    persistence: connection.oauthPersistence,
    compareAndSet,
  });
  accessors.set(selectedId, accessor);
  return accessor;
}
