import { awaitWithAbortSignal } from "../../../infra/abort.js";
import { createHash } from "node:crypto";
import { Redacted } from "effect";
import { readBoundedJson } from "../../../infra/auth/bounded-json.js";
import { COPILOT_STATIC_HEADERS, type CopilotStoredTokens } from "./auth-types.js";
import { isRecord } from "../../../infra/record.js";
import { getCopilotAuthUrls } from "./base-url.js";
import { oauthExpiryFromUnixSeconds } from "../../../infra/auth/oauth-expiry.js";

const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const MAX_TOKEN_LENGTH = 8 * 1024;

interface CopilotExchange {
  readonly copilotToken: Redacted.Redacted<string>;
  readonly expiresAtMs: number;
}

const refreshes = new Map<string, Promise<CopilotExchange>>();


export class CopilotTokenRefreshError extends Error {
  readonly _tag = "CopilotTokenRefreshError" as const;

  constructor(readonly reason: { kind: "http"; status: number } | { kind: "malformed_response" }) {
    super(reason.kind === "http" ? `Copilot token refresh failed (${reason.status})` : "Copilot token refresh returned malformed token fields");
    this.name = "CopilotTokenRefreshError";
  }
}


async function exchangeCopilotToken(githubToken: Redacted.Redacted<string>, enterpriseDomain?: string, signal?: AbortSignal): Promise<CopilotExchange> {
  const url = getCopilotAuthUrls(enterpriseDomain).copilotTokenUrl;
  signal?.throwIfAborted();
  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${Redacted.value(githubToken)}`,
      ...COPILOT_STATIC_HEADERS,
    },
    signal: signal === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) {
    throw new CopilotTokenRefreshError({ kind: "http", status: response.status });
  }

  const raw = await readBoundedJson(response, MAX_OAUTH_RESPONSE_BYTES).catch(() => {
    throw new CopilotTokenRefreshError({ kind: "malformed_response" });
  });
  const token = isRecord(raw) ? raw.token : undefined;
  const expiresAt = isRecord(raw) && typeof raw.expires_at === "number" ? oauthExpiryFromUnixSeconds(raw.expires_at) : undefined;

  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH || expiresAt === undefined) {
    throw new CopilotTokenRefreshError({ kind: "malformed_response" });
  }

  return { copilotToken: Redacted.make(token), expiresAtMs: expiresAt };
}


export async function refreshGitHubCopilotToken(
  githubToken: Redacted.Redacted<string>,
  enterpriseDomain?: string,
  signal?: AbortSignal,
): Promise<CopilotStoredTokens> {
  const key = createHash("sha256").update(Redacted.value(githubToken)).update("\0").update(enterpriseDomain ?? "").digest("hex");
  let refresh = refreshes.get(key);
  if (!refresh) {
    const running = exchangeCopilotToken(githubToken, enterpriseDomain, AbortSignal.timeout(30_000));
    const tracked = running.finally(() => {
      if (refreshes.get(key) === tracked) refreshes.delete(key);
    });
    refreshes.set(key, tracked);
    refresh = tracked;
  }
  const exchanged = await awaitWithAbortSignal(refresh, signal);
  signal?.throwIfAborted();
  return { githubToken, ...exchanged, enterpriseDomain };
}
