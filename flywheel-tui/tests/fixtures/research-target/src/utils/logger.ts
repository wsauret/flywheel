/**
 * Logger — structured logging utility.
 *
 * Provides namespaced logging with structured key-value context.
 * Used throughout the task queue system for observability.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogEntry {
  level: LogLevel;
  namespace: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: Date;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let globalLevel: LogLevel = "info";

export class Logger {
  private readonly namespace: string;

  constructor(namespace: string) {
    this.namespace = namespace;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log("debug", message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log("info", message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log("warn", message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log("error", message, data);
  }

  private log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[globalLevel]) return;

    const entry: LogEntry = {
      level,
      namespace: this.namespace,
      message,
      data,
      timestamp: new Date(),
    };

    const prefix = `[${entry.timestamp.toISOString()}] ${level.toUpperCase()} [${this.namespace}]`;
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";

    if (level === "error") {
      console.error(`${prefix} ${message}${dataStr}`);
    } else {
      console.log(`${prefix} ${message}${dataStr}`);
    }
  }
}

/**
 * Set the global log level.
 */
export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

/**
 * Create a logger with the given namespace.
 */
export function createLogger(namespace: string): Logger {
  return new Logger(namespace);
}
