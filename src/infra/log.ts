import { AsyncLocalStorage } from "node:async_hooks"
import { DebugLog, formatDebugLogLine, type DebugLogRecordInput } from "./debug-log.js"
import { environmentAccountHome } from "./directory-authorities.js"
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
        // Errors land as structured detail before the record can leave the
        // thread: a forwarded record crosses by structured clone, which keeps
        // only an error's message and stack. Serialization converts the rest.
        payload[key] = value instanceof Error ? errorDetail(value) : value
      }
      const input: DebugLogRecordInput = { type: `log.${levelName.toLowerCase()}`, payload }
      if (sessionId) input.sessionId = sessionId
      if (DebugLog.isOpen() || openAccountLog()) {
        DebugLog.record(input)
        return
      }
      if (unconfigured !== "stderr") return
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

  // Why a singleton: a record written before Log.init() names the project
  // directory, as the CLI entry and the launcher write before config is
  // loaded, still needs a destination. After init(), all loggers of a thread
  // share its file.
  export const Default = create({ service: "default" })

  /** Where a record goes while this realm has no configured sink: before
   *  init, and after close. The account log is the default, so an entry that
   *  configures nothing, such as a script or a CLI verb, still records its
   *  diagnostics and never prints them on the terminal of the person who ran
   *  it. FLYWHEEL_UNCONFIGURED_LOG=drop selects no destination at module load;
   *  unset and unknown values keep the account log. Explicit init still owns
   *  its sink. Print mode keeps records on stderr, and suppress() drops them. */
  let unconfigured: "account-log" | "stderr" | "none" = process.env.FLYWHEEL_UNCONFIGURED_LOG === "drop" ? "none" : "account-log"

  /** Open the account log as this realm's destination. A home whose log
   *  directory cannot be made is reported once and the realm drops its
   *  records from then on, as a failed file write does. */
  const openAccountLog = (): boolean => {
    if (unconfigured !== "account-log") return false
    try {
      DebugLog.openDirectory({ dir: environmentAccountHome(process.env) })
      return true
    } catch (error) {
      unconfigured = "none"
      writeDiagnosticStderr(`debug log write failed: ${errorMessage(error)}\n`)
      return false
    }
  }

  /** Where this realm's records go: a file of its own under `dir`, or
   *  stderr in print mode, or `forward`, which hands each record to the thread
   *  that owns the file, for a Worker that must open no log file. */
  type Options = { readonly level?: Level } & (
    | { readonly dir: string; readonly print?: boolean }
    | { readonly forward: (record: DebugLogRecordInput) => void }
  )

  /** True while the full-screen TUI draws on the terminal. */
  let terminalDrawn = false

  /** A diagnostic line that reaches the terminal the full-screen TUI draws on
   *  overwrites the drawn screen, and a redraw does not remove it. So while
   *  the TUI holds the terminal, a line for a terminal stderr is dropped. A
   *  stderr redirected to a file or a pipe still gets every line. */
  export function holdTerminal(): () => void {
    terminalDrawn = true
    return () => {
      terminalDrawn = false
    }
  }

  const writeStderr = (msg: string): void => {
    if (terminalDrawn && process.stderr.isTTY) return
    process.stderr.write(msg)
  }

  export function writeDiagnosticStderr(msg: string): void {
    writeStderr(redactSecrets(msg))
  }

  /** Drop every record this realm writes while it has no configured sink,
   *  for a realm that must write no log file and no stderr line, such as a
   *  test process or a supervisor whose output channel is gone. */
  export function suppress() {
    unconfigured = "none"
  }

  /** Whether a record at `input` from this realm reaches a destination: it
   *  passes the level, and the realm has a sink or a stderr fallback. For a
   *  caller that durably records that a person was shown a record. The debug
   *  log stays non-durable, so true does not prove that a file write landed. */
  export function delivers(input: Level): boolean {
    return shouldLog(input) && (DebugLog.isOpen() || openAccountLog() || unconfigured === "stderr")
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
    await openDestination(options)
    const configured = process.env.FLYWHEEL_LOG_LEVEL?.trim()
    if (resolved === undefined && configured) Default.warn("FLYWHEEL_LOG_LEVEL is not a log level, so the level stays as it was", { value: configured, levels: [...VALID_LEVELS] })
  }

  const openDestination = async (options: Options): Promise<void> => {
    if ("forward" in options) {
      await DebugLog.forward(options.forward)
      return
    }
    if (options.print) {
      // Print mode keeps records on stderr and opens no file, so it creates
      // no log directory. Close a file a prior init may have opened.
      if (unconfigured !== "none") unconfigured = "stderr"
      await DebugLog.close()
      return
    }
    await DebugLog.init({ dir: options.dir })
  }

  const isLevel = (value: string): value is Level => VALID_LEVELS.has(value)

  /** The level that `FLYWHEEL_LOG_LEVEL` names, in any letter case and
   *  with surrounding spaces ignored, or undefined when it is unset or names
   *  no level. `init` warns about a value that names no level. */
  export function envLevel(): Level | undefined {
    const value = process.env.FLYWHEEL_LOG_LEVEL?.trim().toUpperCase()
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
