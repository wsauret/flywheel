/**
 * Headless UI Adapter
 *
 * A minimal UI adapter that logs workflow events to console or file.
 * Used for CI/CD, automation, and non-interactive environments.
 *
 * Event handling uses a data-driven mapping (EVENT_HANDLERS) instead of a
 * switch statement. Adding a new event type requires one line in the record.
 * Exhaustiveness is enforced at compile time via `satisfies`.
 */

import { mkdirSync, existsSync } from "node:fs"
import * as path from "node:path"
import type { EventBus, Unsubscribe } from "../../infra/event-bus.js"
import type { FlywheelEvent } from "../../infra/events"
import { Log } from "../../infra/log.js"

export interface HeadlessAdapterOptions {
  /** Path to log file (if not set, logs to console) */
  logFile?: string

  /** Log level: 'minimal' | 'normal' | 'verbose' */
  logLevel?: "minimal" | "normal" | "verbose"

  /** Custom log function (for testing) */
  logger?: (message: string) => void

  /** Show timestamps in logs */
  timestamps?: boolean
}

// Data-driven event handler mapping

type LogLevel = "minimal" | "normal" | "verbose"

// `any` on the format callback is intentional: `satisfies` enforces exhaustive
// coverage per event type; handlers access variant-specific properties that
// TypeScript can't narrow through a record lookup.
type EventSpec = {
  minLevel: LogLevel
  format: ((event: any) => string | null) | null
}

/** Numeric ordering so we can do `>=` comparisons. */
const LEVEL_ORDER: Record<LogLevel, number> = { minimal: 0, normal: 1, verbose: 2 }

function sprintLabel(stepType: string, stepTitle: string): string {
  if (stepType === "verify") return " (sprint verification)"
  if (stepType === "work" && stepTitle.includes("Sprint")) return " (sprint iteration)"
  return ""
}

/**
 * Exhaustive mapping from every FlywheelEvent type to its headless log spec.
 * `satisfies` enforces that every member of the discriminated union is covered —
 * adding a new event type without updating this record is a compile error.
 */
const EVENT_HANDLERS = {
  // ── Subprocess ──
  "subprocess:spawned":    { minLevel: "normal",  format: (e) => `  Subprocess spawned for step ${e.stepIndex}` },
  "subprocess:output":     { minLevel: "normal",  format: (e) => { const d = e.data.replace(/\n$/, ""); return d ? `  ${e.stream === "stderr" ? "[stderr] " : ""}${d}` : null } },
  "subprocess:ndjson":     { minLevel: "verbose", format: null },
  "subprocess:injected":   { minLevel: "normal",  format: (e) => `  Subprocess stdin injected (${e.message.length} chars)` },

  // ── Dispatcher ──
  "dispatcher:invoked":    { minLevel: "verbose", format: (e) => `  Dispatcher invoked for step ${e.stepIndex}` },
  "dispatcher:completed":  { minLevel: "verbose", format: () => `  Dispatcher completed` },
  "dispatcher:failed":     { minLevel: "normal",  format: (e) => `  Dispatcher failed: ${e.reason}` },
  "dispatcher:output":     { minLevel: "verbose", format: null },

  // ── Evaluator ──
  "evaluator:invoked":     { minLevel: "verbose", format: (e) => `  Evaluator invoked for step ${e.stepIndex}` },
  "evaluator:completed":   { minLevel: "verbose", format: (e) => `  Evaluator: ${e.result.passed ? "PASS" : "FAIL"} — ${e.result.reasoning}` },
  "evaluator:failed":      { minLevel: "normal",  format: (e) => `  Evaluator failed: ${e.reason}` },
  "evaluator:revision-requested": { minLevel: "normal", format: (e) => `  Revision requested (attempt ${e.revisionAttempt}/${e.maxRevisions}): ${e.reason}` },
  "evaluator:output":      { minLevel: "verbose", format: null },

  // ── Budget ──
  "budget:metrics-changed": { minLevel: "verbose", format: (e) => `  Budget: ${e.tokens} tokens, $${e.cost.toFixed(4)}` },
  "budget:exhausted":      { minLevel: "minimal", format: (e) => `  Budget EXHAUSTED: ${e.reason}` },

  // ── Queue lifecycle ──
  "queue:initialized":     { minLevel: "minimal", format: (e) => `Queue initialized (${e.stepIds.length} steps)` },
  "queue:completed":       { minLevel: "minimal", format: (e) => `Queue completed (${e.stepsCompleted} steps)` },
  "queue:failed":          { minLevel: "minimal", format: (e) => `Queue FAILED: ${e.reason} (${e.stepsCompleted} steps completed)` },

  // ── Queue steps ──
  "queue:step-started":    { minLevel: "normal",  format: (e) => `  Queue step started: [${e.stepType}] ${e.stepTitle}${sprintLabel(e.stepType, e.stepTitle)}` },
  "queue:step-completed":  { minLevel: "normal",  format: (e) => `  Queue step completed: [${e.stepType}] ${e.stepTitle}${sprintLabel(e.stepType, e.stepTitle)}` },
  "queue:step-failed":     { minLevel: "minimal", format: (e) => `  Queue step FAILED: [${e.stepType}] ${e.stepTitle} — ${e.reason}` },

  // ── Trace ──
  "trace:tool-started":       { minLevel: "verbose", format: (e) => `  Trace: tool started — ${e.toolName} (${e.toolUseId})` },
  "trace:tool-completed":     { minLevel: "verbose", format: (e) => `  Trace: tool completed — ${e.toolUseId}${e.isError ? " [ERROR]" : ""}` },
  "trace:subagent-started":   { minLevel: "verbose", format: (e) => `  Trace: subagent started — ${e.agentType}: ${e.description} (${e.toolUseId})` },
  "trace:subagent-completed": { minLevel: "verbose", format: (e) => `  Trace: subagent completed — ${e.toolUseId}${e.isError ? " [ERROR]" : ""}` },
} satisfies Record<FlywheelEvent["type"], EventSpec>

// Adapter class

/**
 * HeadlessAdapter - Logs workflow events without visual UI
 *
 * Log levels:
 * - minimal: workflow start/end + errors only
 * - normal: + step/step + output
 * - verbose: + dispatcher/evaluator events + trace events
 */
export class HeadlessAdapter {
  private eventBus: EventBus | null = null
  private unsubscribe: Unsubscribe | null = null
  private logFile: string | null = null
  private logWriter: import("bun").FileSink | null = null
  private logLevel: LogLevel
  private customLogger: ((message: string) => void) | null = null
  private showTimestamps: boolean

  constructor(options: HeadlessAdapterOptions = {}) {
    this.logFile = options.logFile ?? null
    this.logLevel = options.logLevel ?? "normal"
    this.customLogger = options.logger ?? null
    this.showTimestamps = options.timestamps ?? true
  }

  connect(eventBus: EventBus): void {
    if (this.eventBus) this.disconnect()
    this.eventBus = eventBus
    this.unsubscribe = eventBus.subscribe((event) => this.handleEvent(event))
  }

  start(): void {
    if (this.logFile) {
      const dir = path.dirname(this.logFile)
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true })
      }
      this.logWriter = Bun.file(this.logFile).writer()
    }
    this.log("Workflow adapter started (headless)")
  }

  stop(): void {
    this.log("Workflow adapter stopped")
    this.closeLogStream()
  }

  disconnect(): void {
    this.closeLogStream()
    if (this.unsubscribe) { this.unsubscribe(); this.unsubscribe = null }
    this.eventBus = null
  }

  private closeLogStream(): void {
    if (this.logWriter) {
      this.logWriter.flush()
      this.logWriter.end()
      this.logWriter = null
    }
  }

  private handleEvent(event: FlywheelEvent): void {
    const spec = EVENT_HANDLERS[event.type]
    if (!spec.format) return
    if (LEVEL_ORDER[this.logLevel] < LEVEL_ORDER[spec.minLevel]) return
    const message = spec.format(event)
    if (message) this.log(message)
  }

  /**
   * Log a message to console or file
   */
  private log(message: string): void {
    const timestamp = this.showTimestamps
      ? `[${new Date().toISOString()}] `
      : ""
    const fullMessage = `${timestamp}${message}`

    if (this.customLogger) {
      this.customLogger(fullMessage)
    } else if (this.logWriter) {
      this.logWriter.write(fullMessage + "\n")
    } else {
      Log.create({ service: "headless-adapter" }).info(fullMessage)
    }
  }
}

/**
 * Factory function to create a headless adapter
 */
export function createHeadlessAdapter(options?: HeadlessAdapterOptions): HeadlessAdapter {
  return new HeadlessAdapter(options)
}
