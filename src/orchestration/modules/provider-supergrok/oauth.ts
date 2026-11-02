import { Redacted, Schema } from "effect";
import { Log } from "../../../infra/log.js";
import type { ExternalUrlOpener } from "../../../infra/open-external-url.js";
import type { StoredTokens } from "../../../infra/auth/openai-auth-types.js";
import { XAI_DEVICE_CODE_URL, XAI_OAUTH_CLIENT_ID, XAI_OAUTH_SCOPES, XAI_TOKEN_URL } from "./auth-types.js";
import { extractDisplayIdentityFromJwt } from "../../../infra/auth/openai-jwt.js";
import { readBoundedJson } from "../../../infra/auth/bounded-json.js";
import { oauthExpiryFromLifetimeSeconds } from "../../../infra/auth/oauth-expiry.js";

const log = Log.create({ service: "xai-oauth" });

// RFC 8628 section 3.2: `interval` is optional; when the authorization server
// omits it the client must poll every 5 seconds.
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
const MAX_DEVICE_CODE_LIFETIME_SECONDS = 30 * 60;
const MAX_POLL_INTERVAL_SECONDS = 60;
const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const MAX_TOKEN_LENGTH = 8 * 1024;
const MAX_USER_CODE_LENGTH = 128;
const MAX_VERIFICATION_URL_LENGTH = 2 * 1024;

function acceptedVerificationUrl(value: string): boolean {
  if (value.length > MAX_VERIFICATION_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    const trustedHost = url.hostname === "auth.x.ai" || url.hostname === "accounts.x.ai";
    return url.protocol === "https:" && trustedHost && url.username === "" && url.password === "" && url.port === "";
  } catch {
    return false;
  }
}


type UnknownObject = { [K in string]: unknown };

interface XaiDeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

/** Parses xAI's device grant, including its prefilled verification URL.
 * Rejects invalid fields or an absent or untrusted complete URL.
 * The optional polling interval defaults to 5 seconds per RFC 8628. */
export function parseXaiDeviceCodeResponse(data: UnknownObject): XaiDeviceCodeResponse {
  const deviceCode = data.device_code;
  const userCode = data.user_code;
  const verificationUri = data.verification_uri;
  const verificationUriComplete = data.verification_uri_complete;
  const interval = data.interval;
  const expiresIn = data.expires_in;

  if (
    typeof deviceCode !== "string" || deviceCode.length === 0 || deviceCode.length > MAX_TOKEN_LENGTH ||
    typeof userCode !== "string" || userCode.length === 0 || userCode.length > MAX_USER_CODE_LENGTH ||
    typeof verificationUri !== "string" || !acceptedVerificationUrl(verificationUri) ||
    typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0 || expiresIn > MAX_DEVICE_CODE_LIFETIME_SECONDS ||
    (interval !== undefined && (typeof interval !== "number" || !Number.isFinite(interval) || interval <= 0 || interval > MAX_POLL_INTERVAL_SECONDS))
  ) {
    throw new TypeError("Invalid device code response fields");
  }
  if (typeof verificationUriComplete !== "string" || !acceptedVerificationUrl(verificationUriComplete)) {
    throw new TypeError("SuperGrok did not return a valid complete verification URL");
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    verification_uri_complete: verificationUriComplete,
    interval: interval ?? DEFAULT_POLL_INTERVAL_SECONDS,
    expires_in: expiresIn,
  };
}

async function postForm(url: string, form: URLSearchParams, signal?: AbortSignal): Promise<{ status: number; body: UnknownObject }> {
  signal?.throwIfAborted();
  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: signal === undefined ? AbortSignal.timeout(10_000) : AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  const raw = await readBoundedJson(response, MAX_OAUTH_RESPONSE_BYTES).catch(() => ({}));
  const body = raw !== null && typeof raw === "object" && !Array.isArray(raw)
    ? Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(raw)
    : {};
  return { status: response.status, body };
}

async function startDeviceFlow(signal?: AbortSignal): Promise<XaiDeviceCodeResponse> {
  const { status, body } = await postForm(XAI_DEVICE_CODE_URL, new URLSearchParams({
    client_id: XAI_OAUTH_CLIENT_ID,
    scope: XAI_OAUTH_SCOPES,
    // xAI expects each client to name itself in the referrer field.
    referrer: "flywheel",
  }), signal);
  if (status < 200 || status >= 300) throw new Error(`SuperGrok device flow failed to start with HTTP ${status}`);
  return parseXaiDeviceCodeResponse(body);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new Error("Login cancelled"));
    }, { once: true });
  });
}

interface XaiPollOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (message: string) => void;
  /** Waits between polls. A test supplies one that does not sleep. */
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** Polls the token endpoint until the person approves, the code expires, or
 *  the login is cancelled. Only an answer from xAI ends the login: a dropped
 *  connection or a server error polls again at the next interval, because the
 *  person can still approve the code. Progress reports a change of state once,
 *  never every poll, because the terminal shows each report as a notice. */
export async function pollForXaiTokens(device: XaiDeviceCodeResponse, options: XaiPollOptions = {}): Promise<StoredTokens> {
  const { signal, onProgress, wait = abortableSleep } = options;
  const deadline = Date.now() + device.expires_in * 1000;
  let intervalMs = Math.max(1000, device.interval * 1000);
  let interrupted = false;
  const reportInterruption = (): void => {
    if (interrupted) return;
    interrupted = true;
    log.info("SuperGrok device poll interrupted");
    onProgress?.("The connection to SuperGrok was interrupted. Still waiting for approval...");
  };

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");
    await wait(Math.min(intervalMs, deadline - Date.now()), signal);

    let answer: Awaited<ReturnType<typeof postForm>>;
    try {
      answer = await postForm(XAI_TOKEN_URL, new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: device.device_code,
      }), signal);
    } catch {
      if (signal?.aborted) throw new Error("Login cancelled");
      reportInterruption();
      continue;
    }
    const { status, body } = answer;

    if (typeof body.access_token === "string" && body.access_token.length > 0 && body.access_token.length <= MAX_TOKEN_LENGTH) {
      const refreshToken = typeof body.refresh_token === "string" && body.refresh_token.length > 0 && body.refresh_token.length <= MAX_TOKEN_LENGTH
        ? body.refresh_token
        : undefined;
      const expiresIn = body.expires_in === undefined ? DEFAULT_EXPIRES_IN_SECONDS : body.expires_in;
      if (typeof expiresIn !== "number") throw new TypeError("Invalid xAI token response fields");
      const expiresAtMs = oauthExpiryFromLifetimeSeconds(expiresIn, Date.now());
      if (expiresAtMs === undefined) throw new TypeError("Invalid xAI token response fields");
      return {
        accessToken: Redacted.make(body.access_token),
        refreshToken: refreshToken === undefined ? undefined : Redacted.make(refreshToken),
        expiresAtMs,
        email: extractDisplayIdentityFromJwt(body.access_token),
      };
    }

    if (typeof body.error === "string") {
      interrupted = false;
      if (body.error === "authorization_pending") continue;
      if (body.error === "slow_down") {
        // RFC 8628 section 3.5: add 5 seconds on every slow_down.
        intervalMs += 5000;
        onProgress?.(`SuperGrok asked Flywheel to check less often. Checking every ${intervalMs / 1000} seconds...`);
        continue;
      }
      throw new Error("Device flow was rejected");
    }

    if (status >= 500) {
      reportInterruption();
      continue;
    }
    throw new Error(`Device flow failed with HTTP ${status}`);
  }

  throw new Error("Device flow timed out");
}

export interface XaiLoginFlowOptions {
  /** Opens the prefilled verification URL on this machine. The link remains
   * visible when the browser cannot open, and absent, the client that shows
   * the link opens it. */
  openBrowser?: ExternalUrlOpener;
  onUserCode?: (instructions: { userCode?: string; url: string }) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

/** Opens xAI's prefilled verification link and polls until approved, expired,
 * or cancelled. Returns tokens for the caller to store under `supergrok`. */
export async function loginXai(options: XaiLoginFlowOptions): Promise<StoredTokens> {
  const device = await startDeviceFlow(options.signal);
  const url = device.verification_uri_complete;

  options.onUserCode?.({ url });

  // Not awaited, and not guarded here: the opener refuses anything that is not
  // plain http(s) before it launches, and the login link is on screen whether
  // or not a browser appears.
  void options.openBrowser?.(url);

  log.info("SuperGrok device code flow started");

  const tokens = await pollForXaiTokens(device, { signal: options.signal, onProgress: options.onProgress });
  log.info("SuperGrok login completed");
  return tokens;
}
