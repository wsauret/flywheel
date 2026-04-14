// Exclusion patterns are pre-compiled to RegExp[] at startup to avoid repeated parsing per-call.

import micromatch from "micromatch";

const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  "*_API_KEY",
  "*_SECRET_KEY",
  "*_SECRET",
];

export interface EnvFilterOptions {
  /** Additional exclusion patterns (merged with defaults). */
  readonly envExclude?: readonly string[];
  /** Passthrough keys that override exclusion (exact match). */
  readonly envPassthrough?: readonly string[];
}

/**
 * Pre-compiled environment filter.
 * Create once at startup via `createEnvFilter()`, reuse for every spawn.
 */
export interface EnvFilter {
  /** Filter an environment record, returning only allowed entries. */
  filter(env: Record<string, string | undefined>): Record<string, string>;
}

/**
 * Create a pre-compiled environment filter.
 *
 * @param options - Additional exclusion patterns and passthrough overrides.
 * @returns An EnvFilter with pre-compiled patterns.
 */
export function createEnvFilter(options: EnvFilterOptions = {}): EnvFilter {
  const { envExclude = [], envPassthrough = [] } = options;

  const allPatterns: string[] = [...DEFAULT_EXCLUDE_PATTERNS, ...envExclude];

  // micromatch.matcher only accepts a single pattern, so we create one per pattern
  const matchers = allPatterns.map((p) => micromatch.matcher(p, { nocase: true }));

  const isExcluded = (key: string): boolean => matchers.some((m) => m(key));

  // Build passthrough set for O(1) lookup
  const passthroughSet = new Set(envPassthrough);

  const shouldInclude = (key: string): boolean =>
    passthroughSet.has(key) || !isExcluded(key);

  return {
    filter(env: Record<string, string | undefined>): Record<string, string> {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined && shouldInclude(key)) {
          result[key] = value;
        }
      }
      return result;
    },
  };
}
