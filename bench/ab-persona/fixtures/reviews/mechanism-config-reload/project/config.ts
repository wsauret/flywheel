export interface Limits {
  requestsPerMinute: number;
  burst: number;
}

export interface Config {
  limits: Limits;
  features: Record<string, boolean>;
}

const DEFAULT_LIMITS: Limits = { requestsPerMinute: 600, burst: 50 };

export class ConfigError extends Error {}

function parseConfig(text: string): Config {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`config is not valid JSON: ${(error as Error).message}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ConfigError("config must be a JSON object");
  return value as Config;
}

/** Fill absent sections. Mutates the freshly parsed object it is given. */
function withDefaults(config: Config): void {
  config.limits = { ...DEFAULT_LIMITS, ...config.limits };
  config.features ??= {};
}

function validate(config: Config): void {
  const { requestsPerMinute, burst } = config.limits;
  if (!Number.isInteger(requestsPerMinute) || requestsPerMinute <= 0) throw new ConfigError("limits.requestsPerMinute must be a positive integer");
  if (!Number.isInteger(burst) || burst < 0 || burst > requestsPerMinute) throw new ConfigError("limits.burst must be an integer between 0 and requestsPerMinute");
}

type Listener = (config: Config) => void;

/** The process-wide configuration. current() is the one way to read it. */
export class ConfigStore {
  private snapshot: Config;
  private readonly listeners: Listener[] = [];

  constructor(text: string) {
    this.snapshot = ConfigStore.build(text);
  }

  current(): Config {
    return this.snapshot;
  }

  /** Replace the configuration from new file text. Throws ConfigError and
   *  keeps the current configuration when the text is invalid. */
  reload(text: string): void {
    const next = ConfigStore.build(text);
    this.snapshot = next;
    for (const listener of this.listeners) listener(next);
  }

  onChange(listener: Listener): void {
    this.listeners.push(listener);
  }

  private static build(text: string): Config {
    const config = parseConfig(text);
    withDefaults(config);
    validate(config);
    return config;
  }
}
