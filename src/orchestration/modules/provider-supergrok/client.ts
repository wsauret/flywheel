import OpenAI from "openai";
import { applyXaiSubscriptionHeaders, XAI_SUBSCRIPTION_BASE_URL } from "./auth-types.js";
import type { XaiTokenAccessor } from "./token-refresh.js";

/** xAI Responses-API client for one exact SuperGrok credential instance. */
export function createXaiOpenAIClient(accessor: XaiTokenAccessor): OpenAI {
  return new OpenAI({
    baseURL: XAI_SUBSCRIPTION_BASE_URL,
    apiKey: "supergrok-oauth",
    // withRetryStream owns retries; SDK retries would stack multiplicatively.
    maxRetries: 0,
    fetch: async (url: RequestInfo | URL, init?: RequestInit) => {
      const tokens = await accessor.fresh();
      const headers = new Headers(init?.headers);
      applyXaiSubscriptionHeaders(headers, tokens.accessToken);
      return fetch(url, { ...init, headers });
    },
  });
}
