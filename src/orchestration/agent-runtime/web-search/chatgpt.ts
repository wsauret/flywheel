/**
 * ChatGPT-backed web search provider.
 *
 * Talks to the ChatGPT backend's standalone search endpoint, authenticated
 * with the ChatGPT OAuth credential Flywheel already owns. Retrieval and all cross-call ref
 * state run server-side, and no model tokens are spent.
 *
 * Boundary contract: this is an external boundary in both directions. The
 * endpoint is undocumented and may change or refuse at any time, so responses
 * are normalized permissively and every failure surfaces as a WebSearchError
 * with a message the model can act on. Only the command the model authored is
 * sent - never conversation history, files, or prompts. The access token
 * stays Redacted until the fetch call.
 */

import { Redacted } from "effect";
import { replaceCredentialInstance } from "../../../infra/auth/auth-store-mutations.js";
import { loadAuthStoreWithDiagnostics } from "../../../infra/auth/auth-store.js";
import { isCredentialCollection, type CredentialSlotClassifier } from "../../../infra/auth/auth-store-types.js";
import { canonicalSubscriptionAccount, type ProviderConnection } from "../../../infra/auth/auth-context.js";
import { isRecord } from "../../../infra/record.js";
import { CHATGPT_BACKEND_API_BASE, credentialToStoredTokens, storedTokensToCredential } from "../../../infra/auth/openai-auth-types.js";
import { createChatGPTTokenAccessor, getConnectionChatGPTTokenAccessor } from "../llm/openai-chatgpt.js";
import { postJson } from "./http.js";
import { WebSearchError, type WebSearchProvider, type WebSearchResponse, type WebSearchResult } from "./types.js";

const SEARCH_ENDPOINT = `${CHATGPT_BACKEND_API_BASE}/alpha/search`;
/** The backend serves this alpha endpoint only to a client user agent that it recognizes. */
const CLIENT_USER_AGENT = "codex-cli/0.147.0-alpha.6.5";
/** The payload requires a model name; retrieval behavior does not vary by it
 *  and no model inference is billed. */
const PAYLOAD_MODEL = "gpt-4o";

interface ExternalResponseObject {
  [field: string]: unknown;
}
export interface ChatGptWebSearchOverrides {
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Transient-retry pause; tests shrink it so retries stay fast. */
  retryDelayMs?: number;
}

function standaloneAccessor(authDir: string, classifySlot: CredentialSlotClassifier) {
  try {
    const value = loadAuthStoreWithDiagnostics(authDir, undefined, classifySlot).store.chatgpt;
    if (!isCredentialCollection(value) || value.length !== 1) return undefined;
    const [selected] = value;
    if (!selected || selected.credential.type !== "oauth") return undefined;
    return createChatGPTTokenAccessor({
      seed: credentialToStoredTokens(selected.credential),
      persistence: "profile",
      compareAndSet: (expected, next) => replaceCredentialInstance(
        "chatgpt",
        selected.id,
        storedTokensToCredential(expected),
        storedTokensToCredential(next),
        authDir,
        classifySlot,
      ),
    });
  } catch {
    return undefined;
  }
}

export function createChatGptWebSearch(authDir: string, classifySlot: CredentialSlotClassifier, overrides?: ChatGptWebSearchOverrides, connection?: ProviderConnection): WebSearchProvider {
  const account = connection === undefined ? undefined : canonicalSubscriptionAccount(connection, "chatgpt");
  const credential = account?.credential.type === "oauth" ? account.credential : undefined;
  const tokenAccessor = connection
    ? credential && account ? getConnectionChatGPTTokenAccessor(connection, account.instanceId, (expected, next) => replaceCredentialInstance(
      "chatgpt",
      account.instanceId,
      storedTokensToCredential(expected),
      storedTokensToCredential(next),
      connection.authDir,
      classifySlot,
    )) : undefined
    : standaloneAccessor(authDir, classifySlot);
  return {
    id: "chatgpt",

    available: () => {
      if (connection) return credential !== undefined;
      return tokenAccessor !== undefined;
    },

    async run(command, options) {
      const tokens = await (tokenAccessor?.fresh({ caller: "web search" }) ?? Promise.resolve(null)).catch((error) => {
        const detail = error instanceof Error ? error.message : String(error);
        throw new WebSearchError(`ChatGPT authentication failed: ${detail}`);
      });
      if (tokens === null) {
        throw new WebSearchError("ChatGPT web search requires exactly one saved ChatGPT account; select or disconnect accounts in /auth");
      }
      const response = await postJson(SEARCH_ENDPOINT, {
        headers: {
          Authorization: `Bearer ${Redacted.value(tokens.accessToken)}`,
          "Content-Type": "application/json",
          "User-Agent": CLIENT_USER_AGENT,
          ...(tokens.accountId !== undefined ? { "ChatGPT-Account-ID": tokens.accountId } : {}),
        },
        body: JSON.stringify({ id: options.retrievalSessionId, model: PAYLOAD_MODEL, commands: command }),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(overrides?.fetchImpl ? { fetchImpl: overrides.fetchImpl } : {}),
        ...(overrides?.retryDelayMs !== undefined ? { retryDelayMs: overrides.retryDelayMs } : {}),
      });

      if (response.status === 401 || response.status === 403) {
        throw new WebSearchError("the ChatGPT login was rejected; ask the user to run /auth and sign in to ChatGPT again");
      }
      if (response.status === 429) {
        throw new WebSearchError("the search backend rate-limited this account; wait before searching again");
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new WebSearchError(`search backend returned ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
      }
      const responseBody: unknown = await response.json().catch(() => null);
      if (!isRecord(responseBody)) {
        throw new WebSearchError("the search backend returned an unreadable response body");
      }
      return normalizeResponse(responseBody);
    },
  };
}

/** Permissive external-boundary normalization: keep the fields that read as
 *  results, drop the rest. The caller has already proven the body is a
 *  record; an unrecognized shape is an empty response, not a crash. */
function normalizeResponse(record: ExternalResponseObject): WebSearchResponse {
  const results: WebSearchResult[] = [];
  if (Array.isArray(record.results)) {
    for (const item of record.results) {
      if (!isRecord(item)) continue;
      const entry = item;
      const result: WebSearchResult = {
        ...(typeof entry.ref_id === "string" ? { refId: entry.ref_id } : {}),
        ...(typeof entry.title === "string" ? { title: entry.title } : {}),
        ...(typeof entry.url === "string" ? { url: entry.url } : {}),
        ...(typeof entry.snippet === "string" ? { snippet: entry.snippet } : {}),
      };
      if (Object.keys(result).length > 0) results.push(result);
    }
  }
  return {
    ...(typeof record.output === "string" && record.output.length > 0 ? { output: record.output } : {}),
    results,
  };
}
