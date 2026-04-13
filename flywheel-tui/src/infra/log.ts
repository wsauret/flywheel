/**
 * File-based logger for flywheel.
 *
 * Adapted from OpenCode's `src/util/log.ts`. Writes structured log lines to
 * `.flywheel/log/` so errors never leak to stderr and corrupt the TUI.
 *
 * Format: `LEVEL TIMESTAMP +DELTAms key=value ... message\n`
 *
 * Usage:
 *   import { Log } from "../utils/log"
 *   const log = Log.create({ service: "session" })
 *   log.info("started")
 *   log.error("transition failed", { from: "paused", to: "completed" })
 *
 * Call `Log.init()` once at startup (before any logging).
 * Before init, messages go to stderr as a fallback.
 *
 * Log directory: `.flywheel/log/`
 * Rotation: keeps the 10 newest files, deletes older ones.
 */

import path from "path"
import { mkdirSync, readdirSync, unlinkSync, statSync, createWriteStream } from "node:fs"
import { LOG_DIR } from "./paths"

export namespace Log {
  export type Level = "DEBUG" | "INFO" | "WARN" | "ERROR"

  const levelPriority: Record<Level, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
  }

  let level: Level = "INFO"

  function shouldLog(input: Level): boolean {
    return levelPriority[input] >= levelPriority[level]
  }

  export type Logger = {
    debug(message?: unknown, extra?: Record<string, unknown>): void
    info(message?: unknown, extra?: Record<string, unknown>): void
    warn(message?: unknown, extra?: Record<string, unknown>): void
    error(message?: unknown, extra?: Record<string, unknown>): void
    tag(key: string, value: string): Logger
    clone(): Logger
    time(message: string, extra?: Record<string, unknown>): {
      stop(): void
      [Symbol.dispose](): void
    }
  }

  const loggers = new Map<string, Logger>()

  export const Default = create({ service: "default" })

  export interface Options {
    /** Base directory for `.flywheel/log/`. Typically `process.cwd()` or `config.project_cwd`. */
    dir: string
    /** If true, log to stderr instead of file (for debugging). */
    print?: boolean
    /** Override the default log level. */
    level?: Level
  }

  let write = (msg: string) => {
    process.stderr.write(msg)
  }

  /** Silence all log output. Used by test preload. */
  export function suppress() {
    write = () => {}
  }

  export async function init(options: Options) {
    if (options.level) level = options.level
    const logDir = path.join(options.dir, LOG_DIR)
    mkdirSync(logDir, { recursive: true })
    cleanup(logDir)
    if (options.print) return
    const filepath = path.join(
      logDir,
      new Date().toISOString().split(".")[0].replace(/:/g, "") + ".log",
    )
    const stream = createWriteStream(filepath, { flags: "w" })
    write = (msg: string) => {
      stream.write(msg)
    }
  }

  function cleanup(dir: string) {
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".log"))
    } catch {
      return
    }
    if (files.length <= 10) return

    const withStats = files.map((f) => {
      const fp = path.join(dir, f)
      try {
        return { file: f, mtime: statSync(fp).mtimeMs }
      } catch {
        return { file: f, mtime: 0 }
      }
    })
    withStats.sort((a, b) => a.mtime - b.mtime)

    const toRemove = withStats.length - 10
    for (let i = 0; i < toRemove; i++) {
      try {
        unlinkSync(path.join(dir, withStats[i].file))
      } catch {
        // skip unremovable files
      }
    }
  }

  function formatError(error: Error, depth = 0): string {
    const result = error.message
    if (error.cause instanceof Error && depth < 10) {
      return result + " Caused by: " + formatError(error.cause, depth + 1)
    }
    return result
  }

  let last = Date.now()

  export function create(tags?: Record<string, unknown>): Logger {
    tags = tags || {}

    const service = tags["service"]
    if (service && typeof service === "string") {
      const cached = loggers.get(service)
      if (cached) return cached
    }

    function build(message: unknown, extra?: Record<string, unknown>) {
      const prefix = Object.entries({ ...tags, ...extra })
        .filter(([_, value]) => value !== undefined && value !== null)
        .map(([key, value]) => {
          const p = `${key}=`
          if (value instanceof Error) return p + formatError(value)
          if (typeof value === "object") return p + JSON.stringify(value)
          return p + value
        })
        .join(" ")
      const next = new Date()
      const diff = next.getTime() - last
      last = next.getTime()
      return [next.toISOString().split(".")[0], "+" + diff + "ms", prefix, message]
        .filter(Boolean)
        .join(" ") + "\n"
    }

    const result: Logger = {
      debug(message?: unknown, extra?: Record<string, unknown>) {
        if (shouldLog("DEBUG")) write("DEBUG " + build(message, extra))
      },
      info(message?: unknown, extra?: Record<string, unknown>) {
        if (shouldLog("INFO")) write("INFO  " + build(message, extra))
      },
      warn(message?: unknown, extra?: Record<string, unknown>) {
        if (shouldLog("WARN")) write("WARN  " + build(message, extra))
      },
      error(message?: unknown, extra?: Record<string, unknown>) {
        if (shouldLog("ERROR")) write("ERROR " + build(message, extra))
      },
      tag(key: string, value: string) {
        if (tags) tags[key] = value
        return result
      },
      clone() {
        return Log.create({ ...tags })
      },
      time(message: string, extra?: Record<string, unknown>) {
        const now = Date.now()
        result.info(message, { status: "started", ...extra })
        function stop() {
          result.info(message, { status: "completed", duration: Date.now() - now, ...extra })
        }
        return {
          stop,
          [Symbol.dispose]() { stop() },
        }
      },
    }

    if (service && typeof service === "string") {
      loggers.set(service, result)
    }

    return result
  }
}
