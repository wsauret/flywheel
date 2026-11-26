// OpenAI rejects requests with `prompt_cache_key` longer than 64 characters.
// Clamp on code points (not bytes) so multibyte characters survive correctly.
// Adapted from pi `packages/ai/src/api/openai-prompt-cache.ts` (MIT); credited in THIRD-PARTY-NOTICES.md.

import type { StreamOptions } from "../../types.js";

interface StringFields { [key: string]: string }

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}

/** Session headers for the Responses API, or none for a sessionless request.
 *  `x-client-request-id` always carries the conversation identity. The ChatGPT
 *  backend groups its prompt cache by the session-id header and ignores the
 *  body `prompt_cache_key`, so there the session headers carry the request's
 *  cache group (ARCH-PROVIDERS-026). A cache-disabled ChatGPT request joins no
 *  shared group: its session headers carry its own identity. */
export function openAISessionAffinityHeaders(
  options: Pick<StreamOptions, "providerSessionKey" | "promptCacheKey" | "cacheRetention">,
  isChatGPT: boolean,
): StringFields {
  const identity = clampOpenAIPromptCacheKey(options.providerSessionKey);
  if (!identity) return {};
  if (!isChatGPT) return { session_id: identity, "x-client-request-id": identity };
  const affinity = options.cacheRetention === "none" ? identity : clampOpenAIPromptCacheKey(options.promptCacheKey) ?? identity;
  return { "session-id": affinity, session_id: affinity, "x-client-request-id": identity };
}
