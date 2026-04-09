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

import * as fs from "node:fs"
import * as path from "node:path"
import { BaseEventConsumer } from "../../infra/base-event-consumer"
import type { FlywheelEvent } from "../../infra/events"

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

// ---------------------------------------------------------------------------
// Data-driven event handler mapping
// ---------------------------------------------------------------------------

type LogLevel = "minimal" | "normal" | "verbose"

/** min level to log at, plus a format function. null format = no-op.
 *
 *  `event: any` is a deliberate tradeoff: the `satisfies` constraint on
 *  EVENT_HANDLERS enforces exhaustive key coverage (adding a new FlywheelEvent
 *  type without a handler is a compile error), while formatter functions use
 *  loose typing to avoid verbose per-event generics. The handleEvent() entry
 *  point guarantees the correct event type is routed to each handler. */
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
  "subprocess:completed":  { minLevel: "normal",  format: () => `  Subprocess completed` },
  "subprocess:failed":     { minLevel: "minimal", format: (e) => `  Subprocess FAILED: ${e.failure.message}` },
  "subprocess:retrying":   { minLevel: "normal",  format: (e) => `  Subprocess retrying (${e.attempt}/${e.maxAttempts}): ${e.reason}` },
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

  // ── Approval ──
  "approval:requested":    { minLevel: "minimal", format: (e) => `  APPROVAL REQUIRED: ${e.description}` },
  "approval:received":     { minLevel: "normal",  format: (e) => `  Approval: ${e.approved ? "approved" : "rejected"}${e.skipped ? " (skipped)" : ""}` },

  // ── Question ──
  "question:asked":        { minLevel: "normal",  format: (e) => `  Question asked (${e.questions.length} question(s))` },
  "question:replied":      { minLevel: "normal",  format: () => `  Question replied` },
  "question:rejected":     { minLevel: "normal",  format: () => `  Question rejected` },

  // ── Budget ──
  "budget:exhausted":      { minLevel: "minimal", format: (e) => `  Budget EXHAUSTED: ${e.reason}` },

  // ── Queue lifecycle ──
  "queue:initialized":     { minLevel: "minimal", format: (e) => `Queue initialized (${e.stepIds.length} steps)` },
  "queue:completed":       { minLevel: "minimal", format: (e) => `Queue completed (${e.stepsCompleted} steps)` },
  "queue:failed":          { minLevel: "minimal", format: (e) => `Queue FAILED: ${e.reason} (${e.stepsCompleted} steps completed)` },

  // ── Queue steps ──
  "queue:step-started":    { minLevel: "normal",  format: (e) => `  Queue step started: [${e.stepType}] ${e.stepTitle}${sprintLabel(e.stepType, e.stepTitle)}` },
  "queue:step-completed":  { minLevel: "normal",  format: (e) => `  Queue step completed: [${e.stepType}] ${e.stepTitle}${sprintLabel(e.stepType, e.stepTitle)}` },
  "queue:step-failed":     { minLevel: "minimal", format: (e) => `  Queue step FAILED: [${e.stepType}] ${e.stepTitle} — ${e.reason}` },

  // ── Queue mutations ──
  "queue:step-inserted":   { minLevel: "normal",  format: (e) => `  Queue step inserted: [${e.stepType}] ${e.stepTitle} (after ${e.afterStepId})` },
  "queue:step-removed":    { minLevel: "normal",  format: (e) => `  Queue step removed: [${e.stepType}] ${e.stepTitle}` },

  // ── Trace ──
  "trace:tool-started":       { minLevel: "verbose", format: (e) => `  Trace: tool started — ${e.toolName} (${e.toolUseId})` },
  "trace:tool-completed":     { minLevel: "verbose", format: (e) => `  Trace: tool completed — ${e.toolUseId}${e.isError ? " [ERROR]" : ""}` },
  "trace:subagent-started":   { minLevel: "verbose", format: (e) => `  Trace: subagent started — ${e.agentType}: ${e.description} (${e.toolUseId})` },
  "trace:subagent-completed": { minLevel: "verbose", format: (e) => `  Trace: subagent completed — ${e.toolUseId}${e.isError ? " [ERROR]" : ""}` },
} satisfies Record<FlywheelEvent["type"], EventSpec>

// ---------------------------------------------------------------------------
// Adapter class
// ---------------------------------------------------------------------------

/**
 * HeadlessAdapter - Logs workflow events without visual UI
 *
 * Log levels:
 * - minimal: workflow start/end + errors only
 * - normal: + step/step + output
 * - verbose: + dispatcher/evaluator events + trace events
 */
export class HeadlessAdapter extends BaseEventConsumer {
  private logFile: string | null = null
  private logStream: fs.WriteStream | null = null
  private logLevel: LogLevel
  private customLogger: ((message: string) => void) | null = null
  private showTimestamps: boolean
  private closingPromise: Promise<void> | null = null

  constructor(options: HeadlessAdapterOptions = {}) {
    super()
    this.logFile = options.logFile || null
    this.logLevel = options.logLevel || "normal"
    this.customLogger = options.logger || null
    this.showTimestamps = options.timestamps ?? true
  }

  start(): void {
    this.closingPromise = null
    if (this.logFile) {
      const dir = path.dirname(this.logFile)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      this.logStream = fs.createWriteStream(this.logFile, { flags: "a" })
    }
    this.log("Workflow adapter started (headless)")
  }

  stop(): void {
    this.log("Workflow adapter stopped")
    this.closeLogStream()
  }

  disconnect(): void {
    this.closeLogStream()
    super.disconnect()
  }

  /**
   * Close the log stream if open. Returns a promise that resolves
   * when the stream has fully flushed (useful for tests).
   * Safe to call multiple times — subsequent calls return the same promise.
   */
  closeLogStream(): Promise<void> {
    if (this.closingPromise) {
      return this.closingPromise
    }
    if (this.logStream) {
      const stream = this.logStream
      this.logStream = null
      this.closingPromise = new Promise((resolve) => {
        stream.end(() => resolve())
      })
      return this.closingPromise
    }
    return Promise.resolve()
  }

  protected handleEvent(event: FlywheelEvent): void {
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
    } else if (this.logStream) {
      this.logStream.write(fullMessage + "\n")
    } else {
      console.log(fullMessage)
    }
  }
}

/**
 * Factory function to create a headless adapter
 */
export function createHeadlessAdapter(options?: HeadlessAdapterOptions): HeadlessAdapter {
  return new HeadlessAdapter(options)
}
