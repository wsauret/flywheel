import micromatch from "micromatch";

const DEFAULT_EXCLUDE_PATTERNS: readonly string[] = [
  "*_API_KEY",
  "*_SECRET_KEY",
  "*_SECRET",
];

export interface EnvFilterOptions {
  readonly envExclude?: readonly string[];
  readonly envPassthrough?: readonly string[];
}

interface EnvFilter {
  filter(env: Record<string, string | undefined>): Record<string, string>;
}

export function createEnvFilter(options: EnvFilterOptions = {}): EnvFilter {
  const { envExclude = [], envPassthrough = [] } = options;

  const allPatterns: string[] = [...DEFAULT_EXCLUDE_PATTERNS, ...envExclude];

  // micromatch.matcher only accepts a single pattern, so we create one per pattern
  const matchers = allPatterns.map((p) => micromatch.matcher(p, { nocase: true }));

  const isExcluded = (key: string): boolean => matchers.some((m) => m(key));

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
