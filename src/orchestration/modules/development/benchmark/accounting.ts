import { UsageEntryConflictError } from "../../../../infra/llm/usage-authority.js";
import { canonicalUsageEntry } from "../../../../infra/llm/usage-authority-migration.js";
import { decodeUsageEntry, type UsageEntry } from "../../../../infra/llm/usage-entry.js";

type BenchmarkObservation<Value> =
  | { readonly kind: "observed"; readonly value: Value }
  | { readonly kind: "unavailable"; readonly reason: string };

interface BenchmarkAccountingObservation {
  readonly estimatedUsd: BenchmarkObservation<number>;
  readonly billedUsd: BenchmarkObservation<number>;
  readonly tokens: BenchmarkObservation<number>;
  readonly providers: BenchmarkObservation<readonly string[]>;
  readonly pricedEntryCount: number;
  readonly unpricedEntryCount: number;
}

export interface BenchmarkAccounting {
  /** Adds one usage entry after its authority committed it. Identical retries are idempotent. */
  commit(entry: UsageEntry): void;
  /** Returns totals derived only from the distinct committed entries received so far. */
  observe(): BenchmarkAccountingObservation;
}

const NO_USAGE = "the benchmark reported no committed usage";
const PRICE_UNAVAILABLE = "at least one committed usage entry has no estimated price";
const PROVIDER_UNAVAILABLE = "at least one committed usage entry has no provider attribution";
const USAGE_UNMEASURED = "at least one served attempt reported no usage";

/** Accumulates canonical committed usage without inventing values for missing measurements. */
export function createBenchmarkAccounting(): BenchmarkAccounting {
  const entries = new Map<string, { readonly bytes: string; readonly entry: UsageEntry }>();

  return {
    commit(value) {
      const entry = decodeUsageEntry(value);
      const bytes = canonicalUsageEntry(entry);
      const existing = entries.get(entry.attemptId);
      if (existing) {
        if (existing.bytes !== bytes) throw new UsageEntryConflictError(entry.attemptId);
        return;
      }
      entries.set(entry.attemptId, { bytes, entry });
    },
    observe() {
      if (entries.size === 0) {
        const unavailable = { kind: "unavailable", reason: NO_USAGE } as const;
        return {
          estimatedUsd: unavailable,
          billedUsd: unavailable,
          tokens: unavailable,
          providers: unavailable,
          pricedEntryCount: 0,
          unpricedEntryCount: 0,
        };
      }

      let estimatedUsd = 0;
      let billedUsd = 0;
      let estimatedPriceAvailable = true;
      let billedPriceAvailable = true;
      let providerAvailable = true;
      let tokens = 0;
      let pricedEntryCount = 0;
      let unpricedEntryCount = 0;
      let unmeasured = false;
      const providers = new Set<string>();
      for (const { entry } of entries.values()) {
        if (entry.attribution.kind === "candidate") providers.add(entry.attribution.providerId);
        else providerAvailable = false;
        // An unmeasured attempt makes every total unknown; a partial one counts its lower bounds.
        if (entry.coverage === "unmeasured") {
          unmeasured = true;
          unpricedEntryCount++;
          estimatedPriceAvailable = false;
          if (entry.classification === "real_spend") billedPriceAvailable = false;
          continue;
        }
        tokens += entry.tokens.input + entry.tokens.output + (entry.tokens.cacheRead ?? 0) + entry.tokens.cacheWrite + entry.tokens.reasoning;
        if (entry.price.kind === "unavailable") {
          unpricedEntryCount++;
          estimatedPriceAvailable = false;
          if (entry.classification === "real_spend") billedPriceAvailable = false;
        } else {
          pricedEntryCount++;
          estimatedUsd += entry.price.estimatedUsd;
          if (entry.classification === "real_spend") billedUsd += entry.price.estimatedUsd;
        }
      }

      return {
        estimatedUsd: estimatedPriceAvailable ? { kind: "observed", value: estimatedUsd } : { kind: "unavailable", reason: PRICE_UNAVAILABLE },
        billedUsd: billedPriceAvailable ? { kind: "observed", value: billedUsd } : { kind: "unavailable", reason: PRICE_UNAVAILABLE },
        tokens: unmeasured ? { kind: "unavailable", reason: USAGE_UNMEASURED } : { kind: "observed", value: tokens },
        providers: providerAvailable
          ? { kind: "observed", value: [...providers].sort() }
          : { kind: "unavailable", reason: PROVIDER_UNAVAILABLE },
        pricedEntryCount,
        unpricedEntryCount,
      };
    },
  };
}
