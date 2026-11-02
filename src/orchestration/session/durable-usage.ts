import { parseProjectionFact } from "../../infra/event-projection.js";
import type { StoredFact } from "../../infra/event-store-types.js";
import type { UsageEntry } from "../../infra/llm/usage-entry.js";
import { Log } from "../../infra/log.js";
import { parseSessionRuntimeFact } from "../../infra/runtime-fact-parser.js";
import { currentUsageMeasurement, SESSION_RUNTIME_FACT_DEFINITIONS, type UsageMeasurement } from "../../infra/runtime-fact-types.js";

const log = Log.create({ service: "durable-usage" });

const KNOWN_USAGE_MEASURED_VERSIONS: ReadonlySet<number> = new Set(
  SESSION_RUNTIME_FACT_DEFINITIONS.flatMap((definition) => definition.type === "model.usage.measured" ? [definition.version] : []),
);
const warnedUnknownVersions = new Set<number>();

/** Reads one `model.usage.measured` fact as the settled measurement of one attempt. Version 5 entries predate
 *  coverage and read as complete. Versions 4 and earlier carry no entry and return undefined. A version that this
 *  build does not know, which a newer build wrote, also returns undefined, with one warning per version for each
 *  process. Invalid facts of a known version throw. */
export function settledUsageMeasurement(event: StoredFact): UsageMeasurement | undefined {
  if (!KNOWN_USAGE_MEASURED_VERSIONS.has(event.version)) {
    if (!warnedUnknownVersions.has(event.version)) {
      warnedUnknownVersions.add(event.version);
      log.warn("usage fact version is unknown to this build; its usage is not counted", { version: event.version, sessionId: event.sessionId });
    }
    return undefined;
  }
  const fact = parseProjectionFact(event, parseSessionRuntimeFact);
  if (fact.type !== "model.usage.measured" || (fact.version !== 5 && fact.version !== 6)) return undefined;
  return currentUsageMeasurement(fact);
}

/** Returns canonical committed UsageEntry records in fact order, read through `settledUsageMeasurement`. */
export function usageEntriesFromFacts(events: readonly StoredFact[]): UsageEntry[] {
  return events.flatMap((event) => {
    if (event.type !== "model.usage.measured") return [];
    const measurement = settledUsageMeasurement(event);
    if (measurement === undefined) return [];
    const { parentToolUseId: _parentToolUseId, budgetStreamId: _budgetStreamId, ...entry } = measurement;
    return [entry];
  });
}
