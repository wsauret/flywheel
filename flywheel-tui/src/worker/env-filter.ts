/**
 * Environment variable filtering for worker processes.
 *
 * Uses micromatch glob patterns to exclude sensitive variables (API keys, secrets)
 * while allowing configurable passthrough overrides.
 *
 * Exclusion patterns are pre-compiled to RegExp[] at startup to avoid
 * repeated pattern parsing per-key per-call.
 */

import micromatch from "micromatch";

/** Default glob patterns for exclusion. */
export const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
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

export interface EnvFilterReport {
  /** Keys that were passed through. */
  passed: string[];
  /** Keys that were excluded. */
  excluded: string[];
  /** Keys that were explicitly overridden via passthrough. */
  overridden: string[];
}

/**
 * Pre-compiled environment filter.
 * Create once at startup via `createEnvFilter()`, reuse for every spawn.
 */
export interface EnvFilter {
  /** Filter an environment record, returning only allowed entries. */
  filter(env: Record<string, string | undefined>): Record<string, string>;
  /** Generate a debug report of what was filtered. */
  getReport(env: Record<string, string | undefined>): EnvFilterReport;
}

/**
 * Create a pre-compiled environment filter.
 *
 * @param options - Additional exclusion patterns and passthrough overrides.
 * @returns An EnvFilter with pre-compiled patterns.
 */
export function createEnvFilter(options: EnvFilterOptions = {}): EnvFilter {
  const { envExclude = [], envPassthrough = [] } = options;

  // Merge default + additional exclusion patterns
  const allPatterns: string[] = [...DEFAULT_EXCLUDE_PATTERNS, ...envExclude];

  // Pre-compile: create a combined matcher for all patterns
  // micromatch.matcher only accepts a single pattern, so we create one per pattern
  const matchers = allPatterns.map((p) => micromatch.matcher(p, { nocase: true }));

  const isExcluded = (key: string): boolean => matchers.some((m) => m(key));

  // Build passthrough set for O(1) lookup
  const passthroughSet = new Set(envPassthrough);

  function shouldInclude(key: string): { include: boolean; overridden: boolean } {
    if (passthroughSet.has(key)) {
      return { include: true, overridden: isExcluded(key) };
    }
    if (isExcluded(key)) {
      return { include: false, overridden: false };
    }
    return { include: true, overridden: false };
  }

  return {
    filter(env: Record<string, string | undefined>): Record<string, string> {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        const { include } = shouldInclude(key);
        if (include) {
          result[key] = value;
        }
      }
      return result;
    },

    getReport(env: Record<string, string | undefined>): EnvFilterReport {
      const passed: string[] = [];
      const excluded: string[] = [];
      const overridden: string[] = [];

      for (const key of Object.keys(env)) {
        if (env[key] === undefined) continue;
        const result = shouldInclude(key);
        if (result.include) {
          passed.push(key);
          if (result.overridden) {
            overridden.push(key);
          }
        } else {
          excluded.push(key);
        }
      }

      return { passed, excluded, overridden };
    },
  };
}
