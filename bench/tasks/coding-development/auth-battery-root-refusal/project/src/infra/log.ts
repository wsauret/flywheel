import { AsyncLocalStorage } from "node:async_hooks"
import { DebugLog, formatDebugLogLine, type DebugLogRecordInput } from "./debug-log.js"
import { errorDetail, errorMessage } from "./error-message.js"
import { redactSecrets } from "./redact-secrets.js"

// Namespace singleton is intentional: logging is a cross-cutting infrastructure
// concern whose destination (file, stderr) and level are process-global by
// definition, and we need to log from any module before Log.init() runs
// (e.g., during module-load config validation). A factory would force every
// importer to thread a logger handle through its constructor; noise without
// added capability.
//
// Log is the API over the unified JSONL diagnostics stream (debug-log.ts):
// each level call emits a `log.<level>` record through the same sink that
// DebugLog.record uses, so a thread writes all its records to one file, in
// call order.
export namespace Log {
  export type Level = "DEBUG" | "INFO" | "WARN" | "ERROR"

  interface LevelPriorities { readonly DEBUG: number; readonly INFO: number; readonly WARN: number; readonly ERROR: number }
  interface LogFields { [key: string]: unknown }

  const levelPriority: LevelPriorities = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  const VALID_LEVELS: ReadonlySet<string> = new Set<Level>(["DEBUG", "INFO", "WARN", "ERROR"])

  let level: Level = "INFO"

  const shouldLog = (input: Level): boolean => {
    return levelPriority[input] >= levelPriority[level]
  }

  type Logger = {
    debug(message?: unknown, extra?: LogFields): void
    info(message?: unknown, extra?: LogFields): void
    warn(message?: unknown, extra?: LogFields): void
    error(message?: unknown, extra?: LogFields): void
    /** A logger of the same service whose every record also carries
     *  `context`, such as the project and generation of one instance. The
     *  result is not cached, so two instances never share context. */
    with(context: LogFields): Logger
  }

  const loggers = new Map<string, Logger>()

  // Declared ahead of `Default`, which binds the first logger at module load.
  const bind = (resolved: LogFields): Logger => {
    function emit(levelName: Level, message: unknown, extra?: LogFields) {
      const merged = { ...resolved, ...extra }
      const sessionId = resolveSessionId(merged)
      const payload: { [key: string]: unknown } = {}
      if (typeof merged.service === "string") payload.service = merged.service
      if (message !== undefined) {
        payload.message = message instanceof Error ? errorMessage(message) : message
        if (message instanceof Error) payload.error = errorDetail(message)
      }
      for (const [key, value] of Object.entries(merged)) {
        if (key === "service" || key === "sessionId") continue
        if (value === undefined || value === null) continue
        // Errors land as structured detail, never formatted prose: search
        // filters and readers get fields, not a re-parse of a message string.
        payload[key] = value instanceof Error ? errorDetail(value) : value
      }
      const input: DebugLogRecordInput = { type: `log.${levelName.toLowerCase()}`, payload }
      if (sessionId) input.sessionId = sessionId
      if (DebugLog.isOpen()) {
        DebugLog.record(input)
        return
      }
      // Pre-init and print mode fall back to stderr with the same record
      // shape; suppress() silences only this fallback (the TUI owns stderr).
      if (suppressed) return
      const line = formatDebugLogLine(input)
      if (line !== null) writeStderr(line)
    }

    const result: Logger = {
      debug(message?: unknown, extra?: LogFields) {
        if (shouldLog("DEBUG")) emit("DEBUG", message, extra)
      },
      info(message?: unknown, extra?: LogFields) {
        if (shouldLog("INFO")) emit("INFO", message, extra)
      },
      warn(message?: unknown, extra?: LogFields) {
        if (shouldLog("WARN")) emit("WARN", message, extra)
      },
      error(message?: unknown, extra?: LogFields) {
        if (shouldLog("ERROR")) emit("ERROR", message, extra)
      },
      with(context: LogFields) {
        return bind({ ...resolved, ...context })
      },
    }
    return result
  }

  // Why a singleton: pre-init logging (before Log.init() is called with the
  // project directory) falls back to stderr. CLI entry point and launcher use
  // this before config is loaded. After init(), all loggers of a thread share
  // its file.
  export const Default = create({ service: "default" })

  /** Where this realm's records go: a file of its own under `dir`, or
   *  stderr in print mode, or `forward`, which hands each record to the thread
   *  that owns the file, for a Worker that must open no log file. */
  type Options = { readonly level?: Level } & (
    | { readonly dir: string; readonly print?: boolean }
    | { readonly forward: (record: DebugLogRecordInput) => void }
  )

  const writeStderr = (msg: string): void => {
    process.stderr.write(msg)
  }

  export function writeDiagnosticStderr(msg: string): void {
    writeStderr(redactSecrets(msg))
  }

  let suppressed = false

  export function suppress() {
    suppressed = true
  }

  const sessionContext = new AsyncLocalStorage<string>()

  export function runWithSession<T>(sessionId: string, fn: () => T): T {
    return sessionContext.run(sessionId, fn)
  }

  export function currentSessionId(): string | undefined {
    return sessionContext.getStore()
  }

  const resolveSessionId = (merged: LogFields): string | undefined => {
    const tagged = merged.sessionId
    if (typeof tagged === "string" && tagged.length > 0) return tagged
    const ambient = sessionContext.getStore()
    if (typeof ambient === "string" && ambient.length > 0) return ambient
    return undefined
  }

  export async function init(options: Options) {
    // Each Bun Worker realm re-inits its own Log singleton; resolving the env
    // level here keeps that policy in one place instead of at every boot site.
    const resolved = options.level ?? envLevel()
    if (resolved) level = resolved
    // One control for both channels: DEBUG turns on log.debug records and the
    // verbose diagnostic fact families, which have no level of their own.
    DebugLog.setVerbose(level === "DEBUG")
    if ("forward" in options) {
      await DebugLog.forward(options.forward)
      return
    }
    if (options.print) {
      // Print mode keeps records on stderr and opens no file, so it creates
      // no log directory. Close a file a prior init may have opened.
      await DebugLog.close()
      return
    }
    await DebugLog.init({ dir: options.dir })
  }

  const isLevel = (value: string): value is Level => VALID_LEVELS.has(value)

  const envLevel = (): Level | undefined => {
    const value = process.env.FLYWHEEL_LOG_LEVEL
    return value && isLevel(value) ? value : undefined
  }

  export async function closeGlobal(): Promise<void> {
    await DebugLog.close()
  }

  /** The logger of one service. The base logger is cached per service and
   *  carries no other tag: context that belongs to one instance, such as a
   *  project or an executor generation, is added with `with()`, which makes
   *  a logger of its own. */
  export function create(tags: { readonly service: string }): Logger {
    const cached = loggers.get(tags.service)
    if (cached) return cached
    const base = bind({ service: tags.service })
    loggers.set(tags.service, base)
    return base
  }

}
