import { Redacted } from "effect";
import { oauthCredentialDto, type CapturedSubscriptionCredential, type RuntimeOAuthCredential } from "../../../infra/auth/auth-context.js";
import { replaceCredentialInstance } from "../../../infra/auth/auth-store-mutations.js";
import type { Credential } from "../../../infra/auth/auth-store-types.js";
import type { AccessProviderCatalogFetchInput, AccessProviderCatalogFetchResult } from "../../../infra/llm/access-provider.js";
import { classifyFetchFailure, fetchCatalog } from "../../../infra/llm/model-listing.js";
import { DEFAULT_DYNAMIC_CATALOG_LIMITS, extractDataCatalogRows } from "../../../infra/llm/model-catalog-resolution.js";
import { COPILOT_STATIC_HEADERS, copilotTokensToCredential, isCopilotTokenExpired, type CopilotStoredTokens } from "./auth-types.js";
import { getGitHubCopilotBaseUrl } from "./base-url.js";
import { CopilotTokenRefreshError, refreshGitHubCopilotToken } from "./token-refresh.js";

const PROVIDER_ID = "github_copilot";

export const COPILOT_CATALOG = { limits: DEFAULT_DYNAMIC_CATALOG_LIMITS, extractRows: extractDataCatalogRows } as const;

/** Copilot tokens ride the generic OAuth slot: `access` holds the short-lived
 *  Copilot token, `refresh` the long-lived GitHub token. */
export function copilotOAuthCredential(tokens: CopilotStoredTokens): RuntimeOAuthCredential {
  return { type: "oauth", access: tokens.copilotToken, refresh: tokens.githubToken, expires: tokens.expiresAtMs, ...(tokens.enterpriseDomain === undefined ? {} : { enterpriseDomain: tokens.enterpriseDomain }) };
}

function copilotTokens(credential: RuntimeOAuthCredential): CopilotStoredTokens | undefined {
  if (credential.refresh === undefined) return undefined;
  return { githubToken: credential.refresh, copilotToken: credential.access, expiresAtMs: credential.expires, ...(credential.enterpriseDomain === undefined ? {} : { enterpriseDomain: credential.enterpriseDomain }) };
}

/** The two side effects a listing has beside the fetch itself, injectable so
 *  a test can drive the refresh and the rotation without the network. */
export interface CopilotCatalogDependencies {
  readonly refreshToken: (githubToken: Redacted.Redacted<string>, enterpriseDomain?: string, signal?: AbortSignal) => Promise<CopilotStoredTokens>;
  readonly replaceCredentialInstance: (instanceId: string, expected: Credential, credential: Credential, authDir: string, classifySlot: AccessProviderCatalogFetchInput["classifySlot"], signal?: AbortSignal) => Promise<boolean>;
}

function refreshDiscovery(error: unknown): AccessProviderCatalogFetchResult["discovery"] {
  if (!(error instanceof CopilotTokenRefreshError)) return classifyFetchFailure(error);
  return error.reason.kind === "http" && (error.reason.status === 401 || error.reason.status === 403)
    ? { kind: "auth-invalid" }
    : { kind: "failed", reason: "transport" };
}

const DEFAULT_DEPENDENCIES: CopilotCatalogDependencies = {
  refreshToken: refreshGitHubCopilotToken,
  replaceCredentialInstance: (instanceId, expected, credential, authDir, classifySlot, signal) => replaceCredentialInstance(PROVIDER_ID, instanceId, expected, credential, authDir, classifySlot, signal),
};

/** Lists the account's models, rotating an expired Copilot token first so the
 *  listing and the credential it settles on agree. */
export function createCopilotCatalogFetch(dependencies: CopilotCatalogDependencies = DEFAULT_DEPENDENCIES): (input: AccessProviderCatalogFetchInput) => Promise<AccessProviderCatalogFetchResult> {
  async function fetchAccount(credential: RuntimeOAuthCredential, instance: CapturedSubscriptionCredential, authDir: string, classifySlot: AccessProviderCatalogFetchInput["classifySlot"], oauthPersistence: AccessProviderCatalogFetchInput["oauthPersistence"], signal: AbortSignal): Promise<AccessProviderCatalogFetchResult> {
    const tokens = copilotTokens(credential);
    if (!tokens) return { discovery: { kind: "auth-invalid" }, credential };
    try {
      let current = tokens;
      let currentCredential = credential;
      if (isCopilotTokenExpired(current)) {
        if (oauthPersistence === "access-only") return { discovery: { kind: "auth-invalid" }, credential };
        current = await dependencies.refreshToken(current.githubToken, current.enterpriseDomain, signal);
        if (oauthPersistence === "profile") {
          const replaced = await dependencies.replaceCredentialInstance(instance.instanceId, oauthCredentialDto(currentCredential), copilotTokensToCredential(current), authDir, classifySlot, signal);
          if (!replaced) return { discovery: { kind: "auth-invalid" }, credential: currentCredential };
        }
        currentCredential = copilotOAuthCredential(current);
      }
      const baseUrl = getGitHubCopilotBaseUrl(current.copilotToken, current.enterpriseDomain);
      // Provider-call adapter: the token is unwrapped only into the header.
      const discovery = await fetchCatalog(`${baseUrl}/models`, { ...COPILOT_STATIC_HEADERS, Authorization: `Bearer ${Redacted.value(current.copilotToken)}` }, COPILOT_CATALOG, signal);
      return { discovery, credential: currentCredential };
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      return { discovery: refreshDiscovery(error), credential };
    }
  }
  return ({ credential, instance, authDir, classifySlot, oauthPersistence, signal }) => credential.type === "oauth" && instance !== undefined
    ? fetchAccount(credential, instance, authDir, classifySlot, oauthPersistence, signal)
    : Promise.resolve({ discovery: { kind: "not-attempted" }, credential });
}
