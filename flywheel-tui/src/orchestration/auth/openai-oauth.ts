import type { TokenResponse, StoredTokens } from "../../infra/auth/openai-auth-types.js";
import { CLIENT_ID, ISSUER, OAUTH_PORT, CHATGPT_SCOPES, CODEX_API_BASE } from "../../infra/auth/openai-auth-types.js";
import { generatePKCE, generateState } from "../../infra/auth/openai-pkce.js";
import { saveStoredTokens } from "../../infra/auth/openai-token-store.js";
import { saveCachedModels } from "../../infra/auth/openai-model-cache.js";
import { extractAccountId } from "../../infra/auth/openai-jwt.js";
import { Log } from "../../infra/log.js";

const log = Log.create({ service: "openai-oauth" });

const TOKEN_URL = `${ISSUER}/oauth/token`;
const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/auth/callback`;
const DEVICE_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_POLL_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;

// ---------------------------------------------------------------------------
// Pure URL builder — used by startBrowserFlow below, exported for unit testing
// ---------------------------------------------------------------------------

export function buildAuthorizeUrl(
  redirectUri: string,
  pkce: { verifier: string; challenge: string },
  state: string,
  loginHint?: string,
): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: CHATGPT_SCOPES,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "flywheel",
  });
  if (loginHint) params.set("login_hint", loginHint);
  return `${ISSUER}/oauth/authorize?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  return (await res.json()) as TokenResponse;
}

// ---------------------------------------------------------------------------
// Token refresh
// ---------------------------------------------------------------------------

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  return (await res.json()) as TokenResponse;
}

// ---------------------------------------------------------------------------
// Token response -> StoredTokens conversion
// ---------------------------------------------------------------------------

function toStoredTokens(tokenResponse: TokenResponse): StoredTokens {
  return {
    accessToken: tokenResponse.access_token,
    refreshToken: tokenResponse.refresh_token ?? "",
    expiresAtMs: Date.now() + tokenResponse.expires_in * 1000,
    accountId: extractAccountId(tokenResponse),
  };
}

// ---------------------------------------------------------------------------
// HTML templates for callback server
// ---------------------------------------------------------------------------

function successHtml(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Flywheel</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#eee">
<div style="text-align:center"><h1>Authorization Successful</h1>
<p>You can close this window and return to Flywheel.</p></div>
<script>setTimeout(()=>window.close(),2000)</script></body></html>`;
}

function errorHtml(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Flywheel</title></head>
<body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#111;color:#eee">
<div style="text-align:center"><h1>Authorization Failed</h1>
<pre style="background:#222;padding:1rem;border-radius:8px;font-family:monospace">${escapeHtml(message)}</pre></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------------------------------------------------------------------------
// Browser PKCE flow
// ---------------------------------------------------------------------------

export async function startBrowserFlow(loginHint?: string): Promise<StoredTokens> {
  const pkce = await generatePKCE();
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(REDIRECT_URI, pkce, state, loginHint);

  const { promise: codePromise, resolve, reject } = Promise.withResolvers<string>();

  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    server = Bun.serve({
      port: OAUTH_PORT,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/auth/callback") {
          return new Response("Not Found", { status: 404 });
        }

        const error = url.searchParams.get("error");
        if (error) {
          const desc = url.searchParams.get("error_description") ?? error;
          reject(new Error(`OAuth error: ${desc}`));
          return new Response(errorHtml(desc), {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }

        const returnedState = url.searchParams.get("state");
        if (returnedState !== state) {
          reject(new Error("State mismatch — possible CSRF attack"));
          return new Response(errorHtml("State mismatch"), {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }

        const code = url.searchParams.get("code");
        if (!code) {
          reject(new Error("No authorization code in callback"));
          return new Response(errorHtml("Missing authorization code"), {
            status: 200,
            headers: { "content-type": "text/html" },
          });
        }

        resolve(code);
        return new Response(successHtml(), {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      },
    });

    log.info("OAuth callback server started", { port: OAUTH_PORT });

    const openCmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "cmd" : "xdg-open";
    const openArgs = process.platform === "win32"
      ? ["/c", "start", "", authorizeUrl] : [authorizeUrl];
    Bun.spawn([openCmd, ...openArgs], { stdio: ["ignore", "ignore", "ignore"] });

    const timeout = AbortSignal.timeout(300_000);
    const code = await Promise.race([
      codePromise,
      new Promise<never>((_, rej) => {
        timeout.addEventListener("abort", () =>
          rej(new Error("OAuth flow timed out after 5 minutes")),
        );
      }),
    ]);

    const tokenResponse = await exchangeCodeForTokens(code, REDIRECT_URI, pkce.verifier);
    const stored = toStoredTokens(tokenResponse);
    saveStoredTokens(stored);
    log.info("Browser OAuth flow completed", { accountId: stored.accountId });
    await fetchAndCacheModels(stored.accessToken, stored.accountId);
    return stored;
  } catch (err) {
    if (err instanceof Error && err.message.includes("EADDRINUSE")) {
      throw new Error(
        `Port ${OAUTH_PORT} in use. Close other Flywheel or OpenCode instances.`,
      );
    }
    throw err;
  } finally {
    server?.stop(true);
  }
}

// ---------------------------------------------------------------------------
// Device code flow
// ---------------------------------------------------------------------------

export async function startDeviceCodeFlow(): Promise<StoredTokens> {
  const initRes = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });

  if (!initRes.ok) {
    throw new Error(`Device code initiation failed (${initRes.status})`);
  }

  const initData = (await initRes.json()) as {
    device_auth_id: string;
    user_code: string;
    interval: string;
  };

  const pollIntervalMs = Math.max(parseInt(initData.interval, 10) || 5, 1) * 1000 + 3000;
  const deviceUrl = `${ISSUER}/codex/device`;

  log.info("Device code flow started", {
    userCode: initData.user_code,
    url: deviceUrl,
  });

  const deadline = Date.now() + 300_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));

    const pollRes = await fetch(DEVICE_POLL_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        device_auth_id: initData.device_auth_id,
        user_code: initData.user_code,
      }),
    });

    if (pollRes.status === 403 || pollRes.status === 404) continue;

    if (pollRes.ok) {
      const pollData = (await pollRes.json()) as {
        authorization_code: string;
        code_verifier: string;
      };

      const tokenResponse = await exchangeCodeForTokens(
        pollData.authorization_code,
        DEVICE_REDIRECT_URI,
        pollData.code_verifier,
      );
      const stored = toStoredTokens(tokenResponse);
      saveStoredTokens(stored);
      log.info("Device code flow completed", { accountId: stored.accountId });
      await fetchAndCacheModels(stored.accessToken, stored.accountId);
      return stored;
    }

    const text = await pollRes.text().catch(() => "");
    throw new Error(`Device code poll unexpected status (${pollRes.status}): ${text}`);
  }

  throw new Error("Device code flow timed out after 5 minutes");
}

// ---------------------------------------------------------------------------
// Fetch available models from Codex endpoint and cache to disk
// ---------------------------------------------------------------------------

const MODELS_URL = `${CODEX_API_BASE}/models`;
const CLIENT_VERSION = "1.0.0";

interface CodexModelsResponse {
  models?: Array<{ slug: string }>;
}

export async function fetchAndCacheModels(accessToken: string, accountId?: string): Promise<string[]> {
  try {
    const headers: Record<string, string> = {
      authorization: `Bearer ${accessToken}`,
    };
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;

    const res = await fetch(`${MODELS_URL}?client_version=${CLIENT_VERSION}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.warn("failed to fetch Codex models", { status: res.status });
      return [];
    }
    const data = (await res.json()) as CodexModelsResponse;
    const slugs = (data.models ?? []).map((m) => m.slug);
    saveCachedModels(slugs);
    log.info("cached Codex models", { count: slugs.length, models: slugs });
    return slugs;
  } catch (err) {
    log.warn("Codex models fetch failed", { error: String(err) });
    return [];
  }
}
