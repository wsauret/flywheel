const METRIC_LINE_PREFIX = "METRIC";
const DENIED_METRIC_NAMES = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Parses `METRIC name=value` lines from command output.
 *
 * Names contain word characters, dots, or `µ`. Values must convert to finite
 * numbers. For duplicate names, the last value wins without changing the
 * insertion order of the first occurrence.
 */
export function parseMetricLines(output: string): Map<string, number> {
  const metrics = new Map<string, number>();
  const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ]+)=(\\S+)\\s*$`, "gm");
  for (const [, name = "", rawValue] of output.matchAll(regex)) {
    if (DENIED_METRIC_NAMES.has(name)) continue;
    const value = Number(rawValue);
    if (Number.isFinite(value)) {
      metrics.set(name, value);
    }
  }
  return metrics;
}
