/**
 * Detects when a model-provider error message describes an authentication or
 * authorization failure (rejected or missing API key, expired OAuth session)
 * and returns structured copy: a standalone problem statement and the
 * user-facing next step. Returns `undefined` when the message does not look
 * like an auth failure, so callers fall back to their own text.
 *
 * The copy names a provider only from the `ProviderIdentity` of the provider
 * that served the failed request. Error text is never searched for a
 * provider name: an OpenAI-compatible endpoint answers with OpenAI's wording,
 * so text names the SDK, not the account that failed. Lives in `infra/` so
 * the provider-error copy ladder (`provider-error-copy.ts`) and the output
 * laundering paths (`infra/output`) share one detector. The raw provider
 * response is deliberately not echoed; it stays in the event store and logs.
 */

/** The provider whose credential a request used, as a person knows it. */
export interface ProviderIdentity {
  /** The provider's short display name, such as "OpenAI" or a custom provider's name. */
  readonly name: string;
  /** How the person gives Flywheel this provider's credential: a key, or a
   *  sign-in, which Flywheel's own OAuth flow or another program can own. */
  readonly credential: "api_key" | "oauth";
}

export interface AuthErrorCopy {
  /** `credential`: the saved credential is the problem, so /auth is the fix.
   *  `account_setting`: the credential works, but an account setting at the
   *  provider blocks the request, so /auth cannot help. */
  kind: "credential" | "account_setting";
  /** What happened, standalone: safe to embed in worker failure sentences. */
  problem: string;
  /** The user-facing next step, chat surface only. */
  guidance: string;
}

/** The headline each kind of auth failure reads under. */
export const AUTH_ERROR_TITLE = {
  credential: "Authentication failed",
  account_setting: "Account confirmation required",
} as const satisfies { readonly [Kind in AuthErrorCopy["kind"]]: string };

const AUTH_PATTERNS = [
  "incorrect api key",
  "invalid api key",
  "invalid x-api-key",
  "unauthorized",
  "authentication failed",
  "permission denied",
  " 401",
  " 403",
  "401 ",
  "403 ",
];
const OPENROUTER_AGE_CONFIRMATION_URL = "https://openrouter.ai/settings/preferences";
const CHATGPT: ProviderIdentity = { name: "ChatGPT", credential: "oauth" };

/** The one step that repairs a sign-in the provider no longer accepts. */
function reconnectStep(providerName: string): string {
  return `Run /auth and reconnect ${providerName}`;
}

/** Copy for a saved sign-in that its provider rejected outside a model
 *  request, such as a usage check. `providerName` is the provider's short name. */
export function expiredSignInMessage(providerName: string): string {
  return `${providerName} sign-in expired. ${reconnectStep(providerName)}.`;
}

/** Copy for a request whose provider refused its credential. `provider` is
 *  the provider that served the request; without it the copy names no provider. */
function rejectedCredentialCopy(provider: ProviderIdentity | undefined): AuthErrorCopy {
  if (provider?.credential === "oauth") {
    return {
      kind: "credential",
      problem: `${provider.name} sign-in is required. This is a sign-in problem, not a connection error.`,
      guidance: `${reconnectStep(provider.name)}, then send a message to retry.`,
    };
  }
  return {
    kind: "credential",
    problem: `${provider === undefined ? "The model provider's" : `The ${provider.name}`} API key was rejected. This is a configuration problem, not a connection error.`,
    guidance: `Verify a valid API key is configured${provider === undefined ? "" : ` for ${provider.name}`} and retry.`,
  };
}

/** Auth copy for one failed request. A caller that classified the failure as
 *  a rejected credential passes the serving provider as `provider`, and the
 *  copy names that provider. Without a provider, the message text decides
 *  whether the failure is an auth failure at all, and the copy names no
 *  provider. */
export function authErrorCopy(message: string, provider?: ProviderIdentity): AuthErrorCopy | undefined {
  const lower = message.toLowerCase();
  if (lower.includes("18+ age confirmation") && lower.includes(OPENROUTER_AGE_CONFIRMATION_URL)) {
    return {
      kind: "account_setting",
      problem: `OpenRouter requires 18+ age confirmation before this model can be used. The confirmation is in the OpenRouter settings at ${OPENROUTER_AGE_CONFIRMATION_URL}.`,
      guidance: "Confirm your age there, then send a message to retry.",
    };
  }
  if (lower.includes("chatgpt sign-in is required")) return rejectedCredentialCopy(CHATGPT);
  if (provider !== undefined) return rejectedCredentialCopy(provider);
  return AUTH_PATTERNS.some((p) => lower.includes(p)) ? rejectedCredentialCopy(undefined) : undefined;
}

/** One-string form for the tool-error laundering paths. */
export function authErrorHeadline(message: string): string | undefined {
  const copy = authErrorCopy(message);
  return copy ? `${AUTH_ERROR_TITLE[copy.kind]}: ${copy.problem} ${copy.guidance}` : undefined;
}
