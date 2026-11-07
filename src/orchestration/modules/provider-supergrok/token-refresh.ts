
import { awaitWithAbortSignal } from "../../../infra/abort.js";
import { createHash } from "node:crypto";
import { readBoundedJson } from "../../../infra/auth/bounded-json.js";
import { Redacted } from "effect";
import { isRecord } from "../../../infra/record.js";
import type { StoredTokens } from "../../../infra/auth/openai-auth-types.js";
import { XAI_OAUTH_CLIENT_ID, XAI_TOKEN_URL } from "./auth-types.js";
import { oauthExpiryFromLifetimeSeconds } from "../../../infra/auth/oauth-expiry.js";

/**
 * Expected token-refresh failure surfaced as a typed value. It carries only a
 * safe reason (HTTP status/statusText, the OAuth error code, or a
 * malformed-fields marker) and NEVER the raw provider response body, which can
 * echo tokens back.
 */
export class XaiTokenRefreshError extends Error {
  readonly _tag = "XaiTokenRefreshError" as const;

  constructor(
    readonly reason:
      | { kind: "http"; status: number; code?: "invalid_grant" }
      | { kind: "malformed_response" }
      | { kind: "no_refresh_token" }
      | { kind: "refresh_forbidden" },
  ) {
    super(
      reason.kind === "http"
        ? `SuperGrok token refresh failed with HTTP ${reason.status}. Run /auth and sign in to SuperGrok again if this persists.`
        : reason.kind === "no_refresh_token"
          ? "The SuperGrok access token expired and no refresh token is saved. Run /auth and sign in to SuperGrok again."
          : reason.kind === "refresh_forbidden"
            ? "SuperGrok access-only credentials cannot refresh. Create a new headless auth snapshot."
            : "SuperGrok token refresh returned malformed token fields",
    );
    this.name = "XaiTokenRefreshError";
  }
}

// xAI refresh behavior: refresh 5 minutes
// early, keep the old refresh token when the response does not rotate it, and
// default a missing expires_in to one hour.
const EXPIRY_BUFFER_MS = 5 * 60_000;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const MAX_TOKEN_LENGTH = 8 * 1024;
const refreshes = new Map<string, Promise<StoredTokens>>();


function isExpired(tokens: { expiresAtMs: number }): boolean {
  return tokens.expiresAtMs - EXPIRY_BUFFER_MS < Date.now();
}



async function exchangeRefreshedTokens(refreshToken: Redacted.Redacted<string>, signal?: AbortSignal): Promise<StoredTokens> {
  // Provider-call adapter: the refresh token is unwrapped only into the form body.
  const response = await fetch(XAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: XAI_OAUTH_CLIENT_ID,
      refresh_token: Redacted.value(refreshToken),
    }),
    signal: signal === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) {
    const body = await readBoundedJson(response, MAX_OAUTH_RESPONSE_BYTES).catch(() => undefined);
    const rawCode = isRecord(body) && typeof body.error === "string" ? body.error : undefined;
    const code = rawCode === "invalid_grant" ? rawCode : undefined;
    throw new XaiTokenRefreshError({ kind: "http", status: response.status, ...(code ? { code } : {}) });
  }
  const raw = await readBoundedJson(response, MAX_OAUTH_RESPONSE_BYTES).catch(() => { throw new XaiTokenRefreshError({ kind: "malformed_response" }); });
  const accessToken = isRecord(raw) ? raw.access_token : undefined;
  if (typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > MAX_TOKEN_LENGTH) throw new XaiTokenRefreshError({ kind: "malformed_response" });
  const rawRefresh = isRecord(raw) ? raw.refresh_token : undefined;
  const rotatedRefresh = typeof rawRefresh === "string" && rawRefresh.length > 0 && rawRefresh.length <= MAX_TOKEN_LENGTH ? rawRefresh : undefined;
  const rawExpiresIn = isRecord(raw) ? raw.expires_in : undefined;
  const expiresAtMs = typeof rawExpiresIn === "number"
    ? oauthExpiryFromLifetimeSeconds(rawExpiresIn)
    : oauthExpiryFromLifetimeSeconds(DEFAULT_EXPIRES_IN_SECONDS);
  if (expiresAtMs === undefined) throw new XaiTokenRefreshError({ kind: "malformed_response" });
  return {
    // Earliest resolution point for the refreshed tokens: wrap here.
    accessToken: Redacted.make(accessToken),
    refreshToken: rotatedRefresh !== undefined ? Redacted.make(rotatedRefresh) : refreshToken,
    expiresAtMs,
  };
}


async function requestRefreshedTokens(refreshToken: Redacted.Redacted<string>, signal?: AbortSignal): Promise<StoredTokens> {
  const key = createHash("sha256").update(Redacted.value(refreshToken)).digest("hex");
  let refresh = refreshes.get(key);
  if (!refresh) {
    const running = exchangeRefreshedTokens(refreshToken, AbortSignal.timeout(30_000));
    const tracked = running.finally(() => {
      if (refreshes.get(key) === tracked) refreshes.delete(key);
    });
    refreshes.set(key, tracked);
    refresh = tracked;
  }
  const next = await awaitWithAbortSignal(refresh, signal);
  signal?.throwIfAborted();
  return Redacted.value(next.refreshToken ?? refreshToken) === Redacted.value(refreshToken)
    ? { ...next, refreshToken }
    : next;
}

export interface XaiTokenRefreshDependencies {

  readonly compareAndSet: (expected: StoredTokens, next: StoredTokens, signal?: AbortSignal) => Promise<boolean>;
}

/** Exchanges the refresh token for new tokens now, whatever the remaining lifetime, and persists nothing. */
export async function rotateXaiTokens(current: StoredTokens, signal?: AbortSignal): Promise<StoredTokens> {
  if (!current.refreshToken) throw new XaiTokenRefreshError({ kind: "no_refresh_token" });
  return requestRefreshedTokens(current.refreshToken, signal);
}

async function refreshXaiTokens(current: StoredTokens, dependencies: XaiTokenRefreshDependencies, persistence: import("../../../infra/auth/auth-context.js").OAuthPersistencePolicy, signal?: AbortSignal): Promise<StoredTokens> {
  // An access-only credential carries no refresh token, so this refusal comes
  // first: it names the remedy for a headless snapshot, a new snapshot.
  if (persistence === "access-only") throw new XaiTokenRefreshError({ kind: "refresh_forbidden" });
  const next = await rotateXaiTokens(current, signal);
  signal?.throwIfAborted();
  if (persistence === "profile") await dependencies.compareAndSet(current, next, signal);
  return next;
}

/** Returns fresh SuperGrok OAuth tokens, refreshing and persisting on expiry.
 *  Callers provide the immutable credential captured for the provider instance
 *  and its candidate-bound compare-and-set capability. */
export async function ensureFreshXaiTokens(seed: StoredTokens, dependencies: XaiTokenRefreshDependencies, signal?: AbortSignal, persistence: import("../../../infra/auth/auth-context.js").OAuthPersistencePolicy = "profile"): Promise<StoredTokens> {
  signal?.throwIfAborted();
  if (!isExpired(seed)) return seed;
  return refreshXaiTokens(seed, dependencies, persistence, signal);
}

export interface XaiTokenAccessor {
  readonly fresh: () => Promise<StoredTokens>;
}

export function createXaiTokenAccessor(seed: StoredTokens, dependencies: XaiTokenRefreshDependencies, persistence: import("../../../infra/auth/auth-context.js").OAuthPersistencePolicy = "profile"): XaiTokenAccessor {
  let current = seed;
  let inFlight: Promise<StoredTokens> | undefined;
  return {
    fresh() {
      if (inFlight) return inFlight;
      const tracked: Promise<StoredTokens> = ensureFreshXaiTokens(current, dependencies, undefined, persistence).then((next) => {
        current = next;
        return next;
      }).finally(() => {
        if (inFlight === tracked) inFlight = undefined;
      });
      inFlight = tracked;
      return tracked;
    },
  };
}

