import type { NDJSONEvent } from "./ndjson-event-types.js";

export function createNDJSONEvent(
  type: NDJSONEvent["type"],
  data: Record<string, unknown>,
  precomputedRaw?: string,
): NDJSONEvent {
  let cachedRaw = precomputedRaw;
  return {
    type,
    data,
    get raw(): string {
      cachedRaw ??= JSON.stringify({ type, ...data });
      return cachedRaw;
    },
  } as NDJSONEvent;
}
