import type { NDJSONEvent } from "./ndjson-event-types.js";

/**
 * Construct an NDJSONEvent with a memoized lazy `raw` getter.
 *
 * - Parser path: pass `precomputedRaw` (the original stdout line). No serialization cost.
 * - In-process path (harness): omit `precomputedRaw`. First `.raw` access serializes;
 *   subsequent reads return the cached string. Transcript writer is the only consumer
 *   that reads `.raw`, and only for turn-boundary events — not streaming deltas.
 */
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
