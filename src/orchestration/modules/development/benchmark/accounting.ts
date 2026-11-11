import { UsageEntryConflictError } from "../../../../infra/llm/usage-authority.js";
import { canonicalUsageEntry } from "../../../../infra/llm/usage-authority-migration.js";
import { decodeUsageEntry, type UsageEntry } from "../../../../infra/llm/usage-entry.js";

type BenchmarkObservation<Value> =
  | { readonly kind: "observed"; readonly value: Value }
  | { readonly kind: "unavailable"; readonly reason: string };

/** A total. When the exact total is unavailable because an attempt reported no complete usage or has no price,
 *  `atLeast` holds the sum of what the committed entries did report, and the reason names those attempts. */
type BenchmarkAmount =
  | { readonly kind: "observed"; readonly value: number }
  | { readonly kind: "unavailable"; readonly reason: string; readonly atLeast?: number };

interface BenchmarkAccountingObservation {
  readonly estimatedUsd: BenchmarkAmount;
  readonly billedUsd: BenchmarkAmount;
  readonly tokens: BenchmarkAmount;
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
const PRICE_INCOMPLETE = "the total is a lower bound, because these attempts have no complete estimated price";
const PROVIDER_UNAVAILABLE = "at least one committed usage entry has no provider attribution";
const USAGE_INCOMPLETE = "the total is a lower bound, because these served attempts reported no complete usage";

function amount(value: number, missing: readonly string[], reason: string): BenchmarkAmount {
  return missing.length === 0 ? { kind: "observed", value } : { kind: "unavailable", reason: `${reason}: ${missing.join(", ")}`, atLeast: value };
}

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
      let providerAvailable = true;
      let tokens = 0;
      let pricedEntryCount = 0;
      let unpricedEntryCount = 0;
      // The attempts that each total lacks. A served attempt with no usage report, a report that ended early, and a
      // report with no rate card each leave the exact total unknown; the sums below are then lower bounds.
      const unmeasuredTokens: string[] = [];
      const unpricedEstimate: string[] = [];
      const unpricedBilled: string[] = [];
      const providers = new Set<string>();
      for (const { entry } of entries.values()) {
        if (entry.attribution.kind === "candidate") providers.add(entry.attribution.providerId);
        else providerAvailable = false;
        const priced = entry.coverage !== "unmeasured" && entry.price.kind === "priced" ? entry.price.estimatedUsd : undefined;
        if (entry.coverage !== "unmeasured") tokens += entry.tokens.input + entry.tokens.output + (entry.tokens.cacheRead ?? 0) + entry.tokens.cacheWrite + entry.tokens.reasoning;
        if (entry.coverage !== "complete") unmeasuredTokens.push(entry.attemptId);
        if (priced === undefined) unpricedEntryCount++;
        else {
          pricedEntryCount++;
          estimatedUsd += priced;
          if (entry.classification === "real_spend") billedUsd += priced;
        }
        if (priced === undefined || entry.coverage !== "complete") {
          unpricedEstimate.push(entry.attemptId);
          if (entry.classification === "real_spend") unpricedBilled.push(entry.attemptId);
        }
      }

      return {
        estimatedUsd: amount(estimatedUsd, unpricedEstimate, PRICE_INCOMPLETE),
        billedUsd: amount(billedUsd, unpricedBilled, PRICE_INCOMPLETE),
        tokens: amount(tokens, unmeasuredTokens, USAGE_INCOMPLETE),
        providers: providerAvailable
          ? { kind: "observed", value: [...providers].sort() }
          : { kind: "unavailable", reason: PROVIDER_UNAVAILABLE },
        pricedEntryCount,
        unpricedEntryCount,
      };
    },
  };
}
