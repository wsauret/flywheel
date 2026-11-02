import { Redacted, Schema } from "effect";
import { COPILOT_CLIENT_ID, COPILOT_STATIC_HEADERS, type CopilotStoredTokens } from "./auth-types.js";
import { getCopilotAuthUrls, getGitHubCopilotBaseUrl } from "./base-url.js";
import { refreshGitHubCopilotToken } from "./token-refresh.js";
import { Log } from "../../../infra/log.js";
import type { DeviceCodeLoginPorts } from "../../../infra/llm/access-provider.js";
import { mergeAbortSignals } from "../../../infra/abort.js";
import { readBoundedJson } from "../../../infra/auth/bounded-json.js";

async function enableCopilotModel(copilotToken: Redacted.Redacted<string>, modelId: string, baseUrl: string, request: typeof fetch): Promise<boolean> {
  try {
    // Provider-call adapter: the token is unwrapped only into the header.
    const response = await request(`${baseUrl}/models/${modelId}/policy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Redacted.value(copilotToken)}`,
        ...COPILOT_STATIC_HEADERS,
        "openai-intent": "chat-policy",
        "x-interaction-type": "chat-policy",
      },
      body: JSON.stringify({ state: "enabled" }),
      signal: AbortSignal.timeout(10_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const CopilotModelsResponseSchema = Schema.StructWithRest(
  Schema.Struct({
    data: Schema.optionalKey(Schema.Array(Schema.StructWithRest(
      Schema.Struct({ id: Schema.optionalKey(Schema.Unknown) }),
      [Schema.Record(Schema.String, Schema.Unknown)],
    ))),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** Wire model ids the account's /models endpoint reports, or null when the
 *  endpoint is unreachable. Ids stay in Copilot's dotted wire form because
 *  the policy endpoint takes the same form. */
async function fetchCopilotWireModelIds(tokens: CopilotStoredTokens, baseUrl: string, request: typeof fetch): Promise<string[] | null> {
  try {
    // Provider-call adapter: the token is unwrapped only into the header.
    const response = await request(`${baseUrl}/models`, {
      headers: { ...COPILOT_STATIC_HEADERS, Authorization: `Bearer ${Redacted.value(tokens.copilotToken)}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const body = Schema.decodeUnknownSync(CopilotModelsResponseSchema)(await readBoundedJson(response, MAX_OAUTH_RESPONSE_BYTES));
    if (body.data === undefined || !body.data.every((model) => typeof model.id === "string" && model.id.length > 0)) return null;
    return body.data
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
      .filter((id, index, ids) => ids.indexOf(id) === index);
  } catch {
    return null;
  }
}

export async function enableCopilotModels(tokens: CopilotStoredTokens, request: typeof fetch = fetch): Promise<void> {
  const baseUrl = getGitHubCopilotBaseUrl(tokens.copilotToken, tokens.enterpriseDomain);
  const models = await fetchCopilotWireModelIds(tokens, baseUrl, request);
  if (models === null || models.length === 0) return;
  const results = await Promise.all(
    models.map(async (model) => ({
      model,
      ok: await enableCopilotModel(tokens.copilotToken, model, baseUrl, request),
    })),
  );
  const enabled = results.filter((r) => r.ok).map((r) => r.model);
  const failed = results.filter((r) => !r.ok).map((r) => r.model);
  log.info("Copilot model enablement complete", { enabled: enabled.length, failed: failed.length, failedModels: failed });
}

const log = Log.create({ service: "copilot-oauth" });

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}

const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;
// RFC 8628 section 3.2: `interval` is optional; when the authorization server
// omits it the client must poll every 5 seconds (pi `device-code.ts:6-7`).
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const MAX_DEVICE_CODE_LIFETIME_SECONDS = 30 * 60;
const MAX_POLL_INTERVAL_SECONDS = 60;
const MAX_OAUTH_RESPONSE_BYTES = 256 * 1024;
const MAX_TOKEN_LENGTH = 8 * 1024;
const MAX_USER_CODE_LENGTH = 256;
const MAX_IDENTITY_LENGTH = 256;


function acceptedVerificationUrl(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" && url.port === "" && (url.hostname === "github.com" || url.hostname.endsWith(".ghe.com"));
  } catch { return false; }
}



type UnknownObject = { [K in string]: unknown };


async function fetchJson(url: string, init: RequestInit, signal?: AbortSignal): Promise<UnknownObject> {
  const response = await fetch(url, { ...init, signal: mergeAbortSignals(signal, AbortSignal.timeout(10_000)) });
  if (!response.ok) throw new Error(`Copilot OAuth request failed (${response.status})`);
  const body = await readBoundedJson(response, MAX_OAUTH_RESPONSE_BYTES);
  if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("Copilot OAuth returned malformed JSON");
  return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(body);
}

const CopilotUserSchema = Schema.StructWithRest(
  Schema.Struct({ login: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);

/** Fetches the GitHub handle once at login. Provider failures are optional enrichment; caller cancellation is not. */
export async function fetchCopilotIdentity(
  githubToken: Redacted.Redacted<string>,
  enterpriseDomain?: string,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
): Promise<string | undefined> {
  if (signal?.aborted) throw new Error("Login cancelled");
  const url = getCopilotAuthUrls(enterpriseDomain).identityUrl;
  try {
    const response = await request(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${Redacted.value(githubToken)}`,
        "User-Agent": COPILOT_STATIC_HEADERS["User-Agent"],
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: mergeAbortSignals(signal, AbortSignal.timeout(10_000)),
    });
    if (!response.ok) return undefined;
    const login = Schema.decodeUnknownSync(CopilotUserSchema)(await readBoundedJson(response, MAX_OAUTH_RESPONSE_BYTES)).login;
    return login.length > 0 && login.length <= MAX_IDENTITY_LENGTH ? login : undefined;
  } catch {
    if (signal?.aborted) throw new Error("Login cancelled");
    return undefined;
  }
}

async function startDeviceFlow(domain: string, signal?: AbortSignal): Promise<DeviceCodeResponse> {
  const urls = getCopilotAuthUrls(domain === "github.com" ? undefined : domain);
  const data = await fetchJson(urls.deviceCodeUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "GitHubCopilotChat/0.35.0",
    },
    body: new URLSearchParams({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  }, signal);

  return parseDeviceCodeResponse(data);
}

/** Boundary parser for GitHub's device-code response. RFC 8628 requires
 *  device_code, user_code, verification_uri, and expires_in; `interval` is
 *  optional and defaults to 5 seconds. */
export function parseDeviceCodeResponse(data: UnknownObject): DeviceCodeResponse {
  const deviceCode = data.device_code;
  const userCode = data.user_code;
  const verificationUri = data.verification_uri;
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

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    interval: interval ?? DEFAULT_POLL_INTERVAL_SECONDS,
    expires_in: expiresIn,
  };
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

async function pollForGitHubAccessToken(
  domain: string,
  deviceCode: string,
  intervalSeconds: number,
  expiresIn: number,
  signal?: AbortSignal,
): Promise<Redacted.Redacted<string>> {
  const urls = getCopilotAuthUrls(domain === "github.com" ? undefined : domain);
  const deadline = Date.now() + expiresIn * 1000;
  let intervalMs = Math.max(1000, Math.floor(intervalSeconds * 1000));
  let intervalMultiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
  let slowDownResponses = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("Login cancelled");

    const remainingMs = deadline - Date.now();
    const waitMs = Math.min(Math.ceil(intervalMs * intervalMultiplier), remainingMs);
    await abortableSleep(waitMs, signal);

    const raw = await fetchJson(urls.accessTokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "GitHubCopilotChat/0.35.0",
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    }, signal);

    if (typeof raw.access_token === "string" && raw.access_token.length > 0 && raw.access_token.length <= MAX_TOKEN_LENGTH) {
      // Earliest resolution point for the GitHub device-flow token: wrap here.
      return Redacted.make(raw.access_token);
    }

    if (typeof raw.error === "string") {
      const error = raw.error;
      const interval = raw.interval;
      if (error === "authorization_pending") continue;

      if (error === "slow_down") {
        slowDownResponses += 1;
        intervalMs = typeof interval === "number" && interval > 0 ? interval * 1000 : Math.max(1000, intervalMs + 5000);
        intervalMultiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
        continue;
      }

      throw new Error(error === "access_denied" ? "Device flow was denied" : "Device flow failed");
    }
  }

  if (slowDownResponses > 0) {
    throw new Error(
      "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments.",
    );
  }

  throw new Error("Device flow timed out");
}

/** The device-code ports every flow shares, plus the identity fetch a test
 *  injects. The opener is required: it validates the URL before any launch,
 *  and the device code is shown whether or not the browser opens. */
interface CopilotLoginOptions extends DeviceCodeLoginPorts {
  /** Injected HTTP boundary for login-time GitHub identity capture. */
  readonly fetchUser?: typeof fetch;
}

export async function loginGitHubCopilot(options: CopilotLoginOptions): Promise<CopilotStoredTokens> {
  let enterpriseDomain: string | undefined = options.previous?.enterpriseDomain;

  if (options.onPrompt && options.previous === undefined) {
    const input = await options.onPrompt({
      message: "GitHub Enterprise URL/domain (blank for github.com)",
      placeholder: "company.ghe.com",
      allowEmpty: true,
    });

    if (options.signal?.aborted) throw new Error("Login cancelled");

    const trimmed = input.trim();
    if (trimmed) {
      enterpriseDomain = input.trim() || undefined;
      if (enterpriseDomain) getCopilotAuthUrls(enterpriseDomain);
    }
  }

  const domain = enterpriseDomain ?? "github.com";
  const device = await startDeviceFlow(domain, options.signal);

  options.onUserCode?.({ userCode: device.user_code, url: device.verification_uri });

  // Not awaited, and not guarded here: the opener refuses anything that is not
  // plain http(s) before it launches, and the device code is on screen whether
  // or not a browser appears.
  void options.openBrowser?.(device.verification_uri);

  log.info("Copilot device code flow started", { url: device.verification_uri });

  const githubAccessToken = await pollForGitHubAccessToken(
    domain,
    device.device_code,
    device.interval,
    device.expires_in,
    options.signal,
  );

  options.onProgress?.("Exchanging for Copilot token...");
  const credentials = await refreshGitHubCopilotToken(githubAccessToken, enterpriseDomain, options.signal);
  const identity = await fetchCopilotIdentity(githubAccessToken, enterpriseDomain, options.signal, options.fetchUser);

  log.info("Copilot login completed");

  // Enable models that need explicit policy acceptance (Claude/Grok/Gemini on
  // individual accounts). Without this, first-use of these models 403s. Fire-
  // and-forget; log failures but don't block login.
  options.onProgress?.("Enabling Claude/Grok/Gemini models...");
  await enableCopilotModels(credentials);

  return { ...credentials, ...(identity === undefined ? {} : { identity }) };
}
