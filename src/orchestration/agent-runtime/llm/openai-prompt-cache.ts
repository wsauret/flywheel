// OpenAI rejects requests with `prompt_cache_key` longer than 64 characters.
// Clamp on code points (not bytes) so multibyte characters survive correctly.
// Adapted from pi `packages/ai/src/api/openai-prompt-cache.ts` (MIT); credited in THIRD-PARTY-NOTICES.md.

const OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH = 64;

export function clampOpenAIPromptCacheKey(key: string | undefined): string | undefined {
  if (key === undefined) return undefined;
  const chars = Array.from(key);
  if (chars.length <= OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH) return key;
  return chars.slice(0, OPENAI_PROMPT_CACHE_KEY_MAX_LENGTH).join("");
}
