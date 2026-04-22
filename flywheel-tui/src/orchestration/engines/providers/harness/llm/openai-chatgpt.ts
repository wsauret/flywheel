import OpenAI from "openai";
import type { OpenAIAuth, StoredTokens, TokenResponse } from "../../../../../infra/auth/openai-auth-types.js";
import { CODEX_API_BASE } from "../../../../../infra/auth/openai-auth-types.js";
import { isTokenExpired, saveStoredTokens } from "../../../../../infra/auth/openai-token-store.js";
import { refreshAccessToken } from "../../../../auth/openai-oauth.js";
import { Log } from "../../../../../infra/log.js";
import { CLIENT_TIMEOUT_MS } from "./retry.js";

const log = Log.create({ service: "llm-openai-chatgpt" });

type ChatGPTAuth = Extract<OpenAIAuth, { kind: "chatgpt" }>;

export function createChatGPTClient(auth: ChatGPTAuth): OpenAI {
  const staticHeaders: Record<string, string> = {};
  if (auth.accountId) {
    staticHeaders["ChatGPT-Account-Id"] = auth.accountId;
  }

  let current: StoredTokens = {
    accessToken: auth.accessToken,
    refreshToken: auth.refreshToken,
    expiresAtMs: auth.expiresAtMs,
    accountId: auth.accountId,
  };
  let refreshPromise: Promise<TokenResponse> | null = null;

  function refreshWithGuard(): Promise<TokenResponse> {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const result = await Promise.race([
          refreshAccessToken(current.refreshToken),
          Bun.sleep(30_000).then(() => { throw new Error("Token refresh timed out after 30s"); }),
        ]);
        return result;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  return new OpenAI({
    baseURL: CODEX_API_BASE,
    apiKey: "chatgpt-oauth",
    timeout: CLIENT_TIMEOUT_MS,
    defaultHeaders: staticHeaders,
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      if (isTokenExpired(current)) {
        log.info("access token expired, refreshing");
        const refreshed = await refreshWithGuard();
        current = {
          accessToken: refreshed.access_token,
          refreshToken: refreshed.refresh_token ?? current.refreshToken,
          expiresAtMs: Date.now() + refreshed.expires_in * 1000,
          accountId: current.accountId,
        };
        saveStoredTokens(current);
      }

      const headers: Record<string, string> = {};
      if (init?.headers instanceof Headers) {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(init?.headers)) {
        for (const [k, v] of init.headers as [string, string][]) headers[k] = v;
      } else if (init?.headers && typeof init.headers === "object") {
        Object.assign(headers, init.headers);
      }
      Object.assign(headers, staticHeaders);
      headers["authorization"] = `Bearer ${current.accessToken}`;

      const res = await fetch(url, { ...init, headers });
      if (!res.ok) {
        const body = await res.clone().text().catch(() => "");
        log.warn("Codex API error", { status: res.status, url: url.toString(), body });
      }
      return res;
    },
  });
}
