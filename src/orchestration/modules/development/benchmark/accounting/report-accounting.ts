import type { BenchmarkAccounting } from "./evidence.js";

type BenchmarkAccountingField = "estimatedUsd" | "billedUsd" | "tokens";
type BenchmarkAccountingAggregation = "average" | "total";

interface BenchmarkAccountingSummary {
  /** The records that state an amount: an exact value, or the lower bound of an unavailable one. */
  readonly amountCount: number;
  readonly total: number;
  /** Records with an unavailable value. The total is at best a lower bound when there is one. */
  readonly unavailableCount: number;
}

function summarizeAccountingObservation(
  accounting: readonly BenchmarkAccounting[],
  field: BenchmarkAccountingField,
): BenchmarkAccountingSummary {
  const amounts = accounting.flatMap((record) => {
    const value = record[field];
    if (value.kind === "observed") return [value.value];
    return value.atLeast === undefined ? [] : [value.atLeast];
  });
  return {
    amountCount: amounts.length,
    total: amounts.reduce((sum, value) => sum + value, 0),
    unavailableCount: accounting.filter((record) => record[field].kind === "unavailable").length,
  };
}

/** Combines the accounting of several runs into one record. A field is exact only when every run observed it.
 *  Otherwise it stays unavailable with every contributing reason, and `atLeast` sums every exact value and every
 *  lower bound; it is absent only when no run states an amount for that field. */
export function combineBenchmarkAccounting(values: readonly BenchmarkAccounting[]): BenchmarkAccounting {
  const combine = (field: BenchmarkAccountingField): BenchmarkAccounting[BenchmarkAccountingField] => {
    const reasons = [...new Set(values.flatMap((value) => value[field].kind === "unavailable" ? [value[field].reason] : []))];
    const summary = summarizeAccountingObservation(values, field);
    if (reasons.length === 0) return { kind: "observed", value: summary.total };
    return { kind: "unavailable", reason: reasons.join("; "), ...(summary.amountCount > 0 ? { atLeast: summary.total } : {}) };
  };
  const unavailableProviders = values.find((value) => value.providers.kind === "unavailable")?.providers;
  return {
    estimatedUsd: combine("estimatedUsd"),
    billedUsd: combine("billedUsd"),
    tokens: combine("tokens"),
    providers: unavailableProviders?.kind === "unavailable"
      ? unavailableProviders
      : { kind: "observed", value: [...new Set(values.flatMap((value) => value.providers.kind === "observed" ? value.providers.value : []))].sort() },
    pricedEntryCount: values.reduce((total, value) => total + value.pricedEntryCount, 0),
    unpricedEntryCount: values.reduce((total, value) => total + value.unpricedEntryCount, 0),
  };
}

/** One overhead record as a sentence fragment, each amount exact, "at least" a lower bound, or "unavailable". */
export function formatOverheadAccounting(accounting: BenchmarkAccounting): string {
  const amount = (field: BenchmarkAccountingField) => formatAccountingObservation([accounting], field, "total");
  return `${amount("estimatedUsd")} estimated equivalent, ${amount("billedUsd")} billed, and ${amount("tokens")} tokens`;
}

/** Formats one accounting column. The amount is exact when every record observed it. When a record has only a lower
 *  bound, the cell reads "at least" that sum; when a record states no amount at all, it reads "unavailable". */
export function formatAccountingObservation(
  accounting: readonly BenchmarkAccounting[],
  field: BenchmarkAccountingField,
  aggregation: BenchmarkAccountingAggregation,
): string {
  const summary = summarizeAccountingObservation(accounting, field);
  if (summary.amountCount < accounting.length) return "unavailable";
  if (aggregation === "average" && accounting.length === 0) return "n/a";
  const value = aggregation === "average" ? summary.total / accounting.length : summary.total;
  const amount = field === "tokens" ? String(Math.round(value)) : `$${value.toFixed(4)}`;
  return summary.unavailableCount > 0 ? `at least ${amount}` : amount;
}
