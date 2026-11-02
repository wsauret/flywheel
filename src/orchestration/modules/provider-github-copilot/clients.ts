/**
 * GitHub Copilot SDK client builders for the agent runtime.
 *
 * Copilot routes are OpenAI-compatible (and Anthropic-compatible for Claude models):
 * same wire protocols, different base URL + headers + token-refresh dance.
 * We hand `Anthropic` and `OpenAI` instances pointed at the Copilot proxy and let
 * the existing agent runtime adapters do the rest.
 */

import Anthropic from "@anthropic-ai/sdk";
import { Redacted } from "effect";
import OpenAI from "openai";

import type { OAuthPersistencePolicy, ProviderConnection, RuntimeOAuthCredential } from "../../../infra/auth/auth-context.js";
import type { AccessProviderCandidate } from "../../../infra/llm/access-provider.js";
import {
  COPILOT_STATIC_HEADERS,
  type CopilotStoredTokens,
  isCopilotTokenExpired,
} from "./auth-types.js";
import { getGitHubCopilotBaseUrl, rebaseToCopilotHost } from "./base-url.js";
import { refreshGitHubCopilotToken } from "./token-refresh.js";
import { Log } from "../../../infra/log.js";
import { createResettableTimingFetch, type ResettableTimingFetch } from "../../agent-runtime/llm/request-timing.js";
import { normalizeProviderAttemptFailure } from "../../agent-runtime/llm/provider-failure.js";

const log = Log.create({ service: "llm-copilot" });

interface CopilotTokenAccessor {
  ensureFresh(signal?: AbortSignal): Promise<CopilotStoredTokens>;
}

interface CopilotClients {
  anthropic: Anthropic;
  openai: OpenAI;
  resetIdleConnections: ResettableTimingFetch["resetIdleConnections"];
}

const connectionAccessors = new WeakMap<ProviderConnection, Map<string, CopilotTokenAccessor>>();

function createCopilotTokenAccessor(
  initial: CopilotStoredTokens,
  oauthPersistence: OAuthPersistencePolicy,
  compareAndSet?: (expected: CopilotStoredTokens, next: CopilotStoredTokens, signal?: AbortSignal) => Promise<boolean>,
): CopilotTokenAccessor {
  let current = initial;
  let refreshPromise: Promise<CopilotStoredTokens> | null = null;
  function refresh(signal?: AbortSignal): Promise<CopilotStoredTokens> {
    if (oauthPersistence === "access-only") throw new Error("GitHub Copilot access-only credentials cannot refresh. Create a new headless auth snapshot.");
    if (!refreshPromise) {
      refreshPromise = (async () => {
        try {
          log.info("refreshing Copilot token");
          const refreshed = await refreshGitHubCopilotToken(current.githubToken, current.enterpriseDomain, signal)
            .catch((error) => { throw normalizeProviderAttemptFailure(error); });
          signal?.throwIfAborted();
          if (oauthPersistence === "profile") {
            if (compareAndSet === undefined) throw new Error("GitHub Copilot profile token refresh requires a candidate-bound compare-and-set capability");
            const replaced = await compareAndSet(current, refreshed, signal);
            if (!replaced) log.info("Copilot credential changed while refresh was in flight; preserving the newer store entry");
            signal?.throwIfAborted();
          }
          current = refreshed;
          return refreshed;
        } finally {
          refreshPromise = null;
        }
      })();
    }
    return refreshPromise;
  }
  return {
    async ensureFresh(signal?: AbortSignal) {
      if (!isCopilotTokenExpired(current)) return current;
      return refresh(signal);
    },
  };
}

type FetchLike = (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function createCopilotFetch(
  accessor: CopilotTokenAccessor,
  transport: ResettableTimingFetch,
): FetchLike {
  return async (url, init) => {
    const tokens = await accessor.ensureFresh(init?.signal ?? undefined);
    // The `proxy-ep=` routing metadata inside the token can move on refresh,
    // so the current token is the authority for the host; the constructor
    // baseURL is only the initial value.
    const target = rebaseToCopilotHost(url, getGitHubCopilotBaseUrl(tokens.copilotToken, tokens.enterpriseDomain));
    const headers = new Headers(init?.headers);
    // Provider-call adapter: the token is unwrapped only into the header.
    headers.set("Authorization", `Bearer ${Redacted.value(tokens.copilotToken)}`);
    return transport.fetch(target, { ...init, headers });
  };
}

function requiredRefreshToken(credential: RuntimeOAuthCredential) {
  if (credential.refresh === undefined) throw new Error("GitHub Copilot credential is missing the GitHub token. Run: flywheel auth login --copilot");
  return credential.refresh;
}

/** Profile-persistent refreshes use the candidate-bound compare-and-set capability. */
export function buildCopilotClients(
  cred: RuntimeOAuthCredential,
  connection: ProviderConnection,
  candidate: AccessProviderCandidate,
  compareAndSet?: (expected: CopilotStoredTokens, next: CopilotStoredTokens, signal?: AbortSignal) => Promise<boolean>,
): CopilotClients {
  if (candidate.kind !== "subscription") throw new Error("Copilot requires a subscription candidate");
  const tokens: CopilotStoredTokens = {
    githubToken: requiredRefreshToken(cred),
    copilotToken: cred.access,
    expiresAtMs: cred.expires,
    ...(cred.enterpriseDomain === undefined ? {} : { enterpriseDomain: cred.enterpriseDomain }),
  };
  const byCandidate = connectionAccessors.get(connection) ?? new Map<string, CopilotTokenAccessor>();
  connectionAccessors.set(connection, byCandidate);
  let accessor = byCandidate.get(candidate.instanceId);
  if (!accessor) {
    accessor = createCopilotTokenAccessor(tokens, connection.oauthPersistence, compareAndSet);
    byCandidate.set(candidate.instanceId, accessor);
  }
  const transport = createResettableTimingFetch();
  const fetch = createCopilotFetch(accessor, transport);
  const baseURL = getGitHubCopilotBaseUrl(tokens.copilotToken, tokens.enterpriseDomain);

  // `authToken` + `apiKey: null` makes the Anthropic SDK send
  // `Authorization: Bearer X` directly (no x-api-key header to strip).
  // pi's client-factory pattern. Our custom fetch
  // overrides Authorization with the latest token from the accessor on every
  // request (handles refresh), so the SDK's initial value only needs to be a
  // truthy placeholder to opt out of `apiKey` - the real token never leaves
  // its Redacted wrapper outside the fetch adapter.
  const anthropic = new Anthropic({
    apiKey: null,
    authToken: "copilot-oauth",
    baseURL,
    defaultHeaders: { ...COPILOT_STATIC_HEADERS },
    // withRetryStream owns retries; SDK retries would stack multiplicatively.
    maxRetries: 0,
    fetch,
  });

  const openai = new OpenAI({
    apiKey: "copilot",
    baseURL,
    defaultHeaders: { ...COPILOT_STATIC_HEADERS },
    // withRetryStream owns retries; SDK retries would stack multiplicatively.
    maxRetries: 0,
    fetch,
  });

  return {
    anthropic,
    openai,
    resetIdleConnections: transport.resetIdleConnections,
  };
}
