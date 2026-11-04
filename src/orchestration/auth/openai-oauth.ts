import { Deferred, Effect, Redacted, Schema } from "effect";
import { mergeAbortSignals } from "../../infra/abort.js";
import type { StoredTokens, TokenResponse } from "../../infra/auth/openai-auth-types.js";
import { CHATGPT_SCOPES, CLIENT_ID, ISSUER, OAUTH_PORT, TokenResponseSchema } from "../../infra/auth/openai-auth-types.js";
import { extractAccountId, extractDisplayIdentityFromJwt } from "../../infra/auth/openai-jwt.js";
import { generatePKCE, generateState } from "../../infra/auth/openai-pkce.js";
import { readBoundedJson } from "../../infra/auth/bounded-json.js";
import { oauthExpiryFromLifetimeSeconds } from "../../infra/auth/oauth-expiry.js";
import { Log } from "../../infra/log.js";
import type { BrowserLoginPorts } from "../../infra/llm/access-provider.js";

/** ChatGPT OAuth: the browser login that yields an account's tokens, and
 *  the refresh the runtime's token accessor runs on every ChatGPT-backed
 *  request. Both stay with the OpenAI dialect the kernel serves, because the
 *  token accessor re-authenticates through the browser flow when a refresh
 *  token is permanently rejected mid-turn. */

const log = Log.create({ service: "openai-oauth" });

const TOKEN_URL = `${ISSUER}/oauth/token`;
export const MAX_OAUTH_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 8 * 1024;

function parseTokenResponse(raw: unknown): TokenResponse {
  const value = Schema.decodeUnknownSync(TokenResponseSchema)(raw);
  if (value.access_token.length === 0 || value.access_token.length > MAX_TOKEN_LENGTH ||
    (value.refresh_token !== undefined && (value.refresh_token.length === 0 || value.refresh_token.length > MAX_TOKEN_LENGTH)) ||
    (value.id_token !== undefined && value.id_token.length > MAX_TOKEN_LENGTH) ||
    oauthExpiryFromLifetimeSeconds(value.expires_in) === undefined) throw new Error("OAuth response contains invalid token fields");
  return value;
}

type JsonInput = string | number | boolean | null | undefined | JsonObject | JsonInput[];
type JsonObject = { [K in string]: JsonInput };

export type ChatGPTTokenRefreshFailureCode =
  | "refresh_token_expired"
  | "refresh_token_reused"
  | "refresh_token_invalidated";

export interface ChatGPTTokenRefreshResult {
  readonly accessToken: Redacted.Redacted<string>;
  readonly refreshToken?: Redacted.Redacted<string>;
  readonly expiresIn: number;
}

export class ChatGPTTokenRefreshError extends Error {
  readonly status: number;
  readonly code: ChatGPTTokenRefreshFailureCode | undefined;

  constructor(input: { status: number; code?: ChatGPTTokenRefreshFailureCode }) {
    super(`ChatGPT token refresh failed (${input.status})`);
    this.name = "ChatGPTTokenRefreshError";
    this.status = input.status;
    this.code = input.code;
  }
}

export function requestSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return mergeAbortSignals(signal, timeout);
}

/** Exchanges a refresh token with a 10-second request timeout. Non-success HTTP
 * responses reject with a safe typed status and an allowlisted permanent-auth
 * code. Provider response text is never reflected into errors or logs. */
export async function refreshAccessToken(refreshToken: Redacted.Redacted<string>, signal?: AbortSignal): Promise<ChatGPTTokenRefreshResult> {
  // Provider-call adapter: the token is unwrapped only into the request body.
  const requestBody = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: Redacted.value(refreshToken),
    client_id: CLIENT_ID,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: requestBody.toString(),
    signal: requestSignal(10_000, signal),
  });

  if (!res.ok) {
    const errorBody = await readBoundedJson(res, MAX_OAUTH_RESPONSE_BYTES).catch(() => undefined);
    const code = parseRefreshErrorCode(errorBody);
    throw new ChatGPTTokenRefreshError({ status: res.status, ...(code ? { code } : {}) });
  }
  const response = parseTokenResponse(await readBoundedJson(res, MAX_OAUTH_RESPONSE_BYTES));
  return {
    accessToken: Redacted.make(response.access_token),
    ...(response.refresh_token === undefined ? {} : { refreshToken: Redacted.make(response.refresh_token) }),
    expiresIn: response.expires_in,
  };
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRefreshErrorCode(parsed: unknown): ChatGPTTokenRefreshFailureCode | undefined {
  const error = isRecord(parsed) ? parsed.error : undefined;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code === "refresh_token_expired" || code === "refresh_token_reused" || code === "refresh_token_invalidated") return code;
  return undefined;
}

const REDIRECT_URI = `http://localhost:${OAUTH_PORT}/auth/callback`;
const MAX_ACCOUNT_ID_LENGTH = 256;

function loginCancelledError(): Error {
  return new Error("Login cancelled");
}

function throwIfLoginCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw loginCancelledError();
}

function abortRejection(signal: AbortSignal, error: () => Error): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(error());
      return;
    }
    signal.addEventListener("abort", () => reject(error()), { once: true });
  });
}

function buildAuthorizeUrl(
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

async function exchangeCodeForTokens(
  code: string,
  redirectUri: string,
  codeVerifier: string,
  signal?: AbortSignal,
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
    signal: requestSignal(10_000, signal),
  });

  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  return parseTokenResponse(await readBoundedJson(res, MAX_OAUTH_RESPONSE_BYTES));
}

// Earliest resolution point for ChatGPT OAuth secrets: wrap here, before the
// tokens travel anywhere else in memory.
function toStoredTokens(tokenResponse: TokenResponse): StoredTokens {
  const accountId = extractAccountId(tokenResponse);
  const email = tokenResponse.id_token === undefined ? undefined : extractDisplayIdentityFromJwt(tokenResponse.id_token);
  const expiresAtMs = oauthExpiryFromLifetimeSeconds(tokenResponse.expires_in);
  if (expiresAtMs === undefined) throw new Error("OAuth response contains invalid expiry");
  return {
    accessToken: Redacted.make(tokenResponse.access_token),
    refreshToken: tokenResponse.refresh_token !== undefined ? Redacted.make(tokenResponse.refresh_token) : undefined,
    expiresAtMs,
    ...(accountId !== undefined && accountId.length <= MAX_ACCOUNT_ID_LENGTH ? { accountId } : {}),
    ...(email !== undefined && email.length <= MAX_ACCOUNT_ID_LENGTH ? { email } : {}),
  };
}

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

// Parse user-pasted auth input into `{ code, state }`. Accepts:
//   - a bare authorization code
//   - the full redirect URL (`http://.../auth/callback?code=...&state=...`)
//   - a `code#state` fragment (forced-tool shorthand)
//   - `code=...&state=...` querystring fragment
// Copied from pi `packages/ai/src/auth/oauth/openai-codex.ts` (MIT); credited in THIRD-PARTY-NOTICES.md.
function parseAuthorizationInput(input: string) {
  const value = input.trim();
  if (!value) return {};
  try {
    const url = new URL(value);
    return {
      code: url.searchParams.get("code") ?? undefined,
      state: url.searchParams.get("state") ?? undefined,
    };
  } catch {
    /* not a URL */
  }
  if (value.includes("#")) {
    const [code, state] = value.split("#", 2);
    return { code, state };
  }
  if (value.includes("code=")) {
    const params = new URLSearchParams(value);
    return {
      code: params.get("code") ?? undefined,
      state: params.get("state") ?? undefined,
    };
  }
  return { code: value };
}

/** The loopback addresses `localhost` in the redirect URI can name. A browser
 *  can send the callback to either one, so the flow listens on each. */
const CALLBACK_HOSTS = ["127.0.0.1", "::1"] as const;

/** Copy for a pasted or redirected address whose state is not this attempt's.
 *  A failure message has no closing period, because each client appends its
 *  own retry advice. */
const OTHER_ATTEMPT_MESSAGE = "This address belongs to a different sign-in attempt";

/** The copy names the remedy only: Bun's own bind error repeats the port
 *  in other words, so the record keeps it and the person does not. */
function callbackPortBusyError(hostname: string, cause: unknown): Error {
  log.info("OAuth callback port busy", { port: OAUTH_PORT, hostname, error: cause instanceof Error ? cause.message : String(cause) });
  return new Error(`Port ${OAUTH_PORT} is in use by another program, so the sign-in cannot receive its callback. Close that program`);
}

/** Whether a listener answers on the address. Bun reports every failed bind
 *  as EADDRINUSE, so the flow asks the address itself. */
async function answers(hostname: string, port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname, port, socket: { data() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/** Listens for the callback on every loopback address. An address held by
 *  another program would take a callback the browser sends there, so the flow
 *  fails at once with plain copy. A machine without the IPv6 loopback has no
 *  listener there and cannot route a callback there either. */
async function serveCallback(fetch: (req: Request) => Response | Promise<Response>): Promise<ReturnType<typeof Bun.serve>[]> {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  for (const hostname of CALLBACK_HOSTS) {
    try {
      servers.push(Bun.serve({ hostname, port: OAUTH_PORT, fetch }));
    } catch (error) {
      if (hostname !== "127.0.0.1" && !await answers(hostname, OAUTH_PORT)) continue;
      for (const server of servers) void server.stop(true);
      throw callbackPortBusyError(hostname, error);
    }
  }
  return servers;
}

/** Stops listening and lets the answered callback page finish writing. A
 *  connection the browser keeps open without a request is closed after a
 *  short grace, so the flow never waits on the browser. */
function closeCallback(servers: readonly ReturnType<typeof Bun.serve>[]): void {
  for (const server of servers) {
    void server.stop();
    setTimeout(() => { void server.stop(true) }, 2_000).unref();
  }
}

function callbackPage(html: string, status = 200): Response {
  return new Response(html, { status, headers: { "content-type": "text/html", connection: "close" } });
}

/** Runs the PKCE authorization-code flow using a fixed localhost callback port.
 *  It listens for the callback on every loopback address before it reports
 *  the URL, so a busy port fails at once. It then attempts to launch the
 *  platform browser, reports the URL through `onAuthorizeUrl`, and optionally
 *  races parsed manual input against the callback (a supplied state must
 *  match). A callback whose state belongs to another attempt gets an error
 *  page while the flow keeps waiting. The browser's page reports the outcome
 *  of the token exchange, so the page and the caller never disagree.
 *  Cancellation rejects with `Login cancelled`; timeout, a provider error,
 *  token exchange failures, and server startup also reject. The spawned
 *  browser is not closed. On success the returned tokens are redacted. */
export async function startBrowserFlow(options: BrowserLoginPorts): Promise<StoredTokens> {
  throwIfLoginCancelled(options.signal);
  const pkce = await generatePKCE();
  throwIfLoginCancelled(options.signal);
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(REDIRECT_URI, pkce, state, options.loginHint);

  const codeDeferred = Deferred.makeUnsafe<string, Error>();
  const codePromise = Effect.runPromise(Deferred.await(codeDeferred));
  const resolveCode = (code: string): void => {
    Effect.runSync(Deferred.succeed(codeDeferred, code));
  };
  const rejectCode = (err: Error): void => {
    Effect.runSync(Deferred.fail(codeDeferred, err));
  };
  // Settles once with whether the flow obtained tokens. The callback page
  // waits for it.
  const outcome = Promise.withResolvers<boolean>();

  let servers: ReturnType<typeof Bun.serve>[] = [];
  try {
    servers = await serveCallback((req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/auth/callback") return new Response("Not Found", { status: 404 });
      if (url.searchParams.get("state") !== state) {
        return callbackPage(errorHtml(`${OTHER_ATTEMPT_MESSAGE}. Close this window and use the newest sign-in window.`), 400);
      }
      if (url.searchParams.get("error")) {
        rejectCode(new Error("OAuth authorization failed"));
        return callbackPage(errorHtml("The provider did not authorize this sign-in. Return to Flywheel and sign in again."));
      }
      const code = url.searchParams.get("code");
      if (!code) {
        rejectCode(new Error("No authorization code in callback"));
        return callbackPage(errorHtml("The callback carried no authorization code. Return to Flywheel and sign in again."));
      }
      resolveCode(code);
      return outcome.promise.then((succeeded) => succeeded
        ? callbackPage(successHtml())
        : callbackPage(errorHtml("Flywheel could not complete this sign-in. Return to Flywheel for the reason.")));
    });
    throwIfLoginCancelled(options.signal);

    log.info("OAuth callback server started", { port: OAUTH_PORT, listeners: servers.length });

    // The handoff is not awaited: the consent page is the user's to complete,
    // and this flow is already waiting on the callback the page redirects to.
    void options.openBrowser?.(authorizeUrl);
    options.onAuthorizeUrl?.({ url: authorizeUrl });

    const timeout = AbortSignal.timeout(300_000);
    const racers: Promise<string>[] = [codePromise];
    if (options.onManualCodeInput) {
      racers.push(options.onManualCodeInput().then((pasted) => {
        const parsed = parseAuthorizationInput(pasted);
        if (parsed.state && parsed.state !== state) {
          throw new Error(OTHER_ATTEMPT_MESSAGE);
        }
        if (!parsed.code) throw new Error("No authorization code in pasted input");
        return parsed.code;
      }));
    }
    racers.push(new Promise<never>((_, rej) => {
      timeout.addEventListener("abort", () =>
        rej(new Error("OAuth flow timed out after 5 minutes")),
      );
    }));
    if (options.signal) {
      racers.push(abortRejection(options.signal, loginCancelledError));
    }
    const code = await Promise.race(racers);

    const tokenResponse = await exchangeCodeForTokens(code, REDIRECT_URI, pkce.verifier, options.signal);
    const stored = toStoredTokens(tokenResponse);
    log.info("Browser OAuth flow completed", { accountId: stored.accountId });
    throwIfLoginCancelled(options.signal);
    outcome.resolve(true);
    return stored;
  } finally {
    outcome.resolve(false);
    closeCallback(servers);
  }
}
