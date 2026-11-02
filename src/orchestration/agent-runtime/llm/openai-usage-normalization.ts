/** Reads an undeclared provider cache-write extension without letting malformed values enter accounting. */
export function cacheWriteTokens(details: unknown): number {
  if (typeof details !== "object" || details === null || !("cache_write_tokens" in details)) return 0;
  const value = details.cache_write_tokens;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
