import type { BenchmarkAccounting } from "./evidence.js";

type BenchmarkAccountingField = "estimatedUsd" | "billedUsd" | "tokens";
type BenchmarkAccountingAggregation = "average" | "total";

interface BenchmarkAccountingSummary {
  readonly observedValues: readonly number[];
  readonly total: number;
  readonly unavailableCount: number;
}

function summarizeAccountingObservation(
  accounting: readonly BenchmarkAccounting[],
  field: BenchmarkAccountingField,
): BenchmarkAccountingSummary {
  const observedValues = accounting.flatMap((record) => record[field].kind === "observed" ? [record[field].value] : []);
  return {
    observedValues,
    total: observedValues.reduce((sum, value) => sum + value, 0),
    unavailableCount: accounting.length - observedValues.length,
  };
}

export function formatAccountingObservation(
  accounting: readonly BenchmarkAccounting[],
  field: BenchmarkAccountingField,
  aggregation: BenchmarkAccountingAggregation,
): string {
  const summary = summarizeAccountingObservation(accounting, field);
  if (summary.unavailableCount > 0) return "unavailable";
  if (aggregation === "average" && summary.observedValues.length === 0) return "n/a";
  const value = aggregation === "average" && summary.observedValues.length > 0
    ? summary.total / summary.observedValues.length
    : summary.total;
  return field === "tokens" ? String(Math.round(value)) : `$${value.toFixed(4)}`;
}
