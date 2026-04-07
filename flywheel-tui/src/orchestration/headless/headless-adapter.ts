/**
 * Headless UI Adapter
 *
 * A minimal UI adapter that logs workflow events to console or file.
 * Used for CI/CD, automation, and non-interactive environments.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { BaseEventConsumer } from "../../infra/base-event-consumer"
import type { FlywheelEvent } from "../../infra/events"
import { assertNever } from "../../infra/events"

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
  private logLevel: "minimal" | "normal" | "verbose"
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
    super.start()
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
    super.stop()
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
    switch (event.type) {
      // ── Subprocess events (normal+) ──
      case "subprocess:spawned":
        if (this.logLevel !== "minimal") {
          this.log(`  Subprocess spawned for step ${event.stepIndex}`)
        }
        break

      case "subprocess:completed":
        if (this.logLevel !== "minimal") {
          this.log("  Subprocess completed")
        }
        break

      case "subprocess:failed":
        this.log(`  Subprocess FAILED: ${event.failure.message}`)
        break

      case "subprocess:retrying":
        if (this.logLevel !== "minimal") {
          this.log(`  Subprocess retrying (${event.attempt}/${event.maxAttempts}): ${event.reason}`)
        }
        break

      case "subprocess:output":
        if (this.logLevel !== "minimal") {
          const prefix = event.stream === "stderr" ? "[stderr] " : ""
          // Trim trailing newline for cleaner log output
          const data = event.data.replace(/\n$/, "")
          if (data) this.log(`  ${prefix}${data}`)
        }
        break

      // ── Dispatcher events (verbose) ──
      case "dispatcher:invoked":
        if (this.logLevel === "verbose") {
          this.log(`  Dispatcher invoked for step ${event.stepIndex}`)
        }
        break

      case "dispatcher:completed":
        if (this.logLevel === "verbose") {
          this.log("  Dispatcher completed")
        }
        break

      case "dispatcher:failed":
        if (this.logLevel !== "minimal") {
          this.log(`  Dispatcher failed: ${event.reason}`)
        }
        break

      // ── Evaluator events (verbose) ──
      case "evaluator:invoked":
        if (this.logLevel === "verbose") {
          this.log(`  Evaluator invoked for step ${event.stepIndex}`)
        }
        break

      case "evaluator:completed":
        if (this.logLevel === "verbose") {
          const r = event.result
          this.log(`  Evaluator: ${r.passed ? "PASS" : "FAIL"} — ${r.reasoning}`)
        }
        break

      case "evaluator:failed":
        if (this.logLevel !== "minimal") {
          this.log(`  Evaluator failed: ${event.reason}`)
        }
        break

      case "evaluator:revision-requested":
        if (this.logLevel !== "minimal") {
          this.log(`  Revision requested (attempt ${event.revisionAttempt}/${event.maxRevisions}): ${event.reason}`)
        }
        break

      // ── Approval events ──
      case "approval:requested":
        this.log(`  APPROVAL REQUIRED: ${event.description}`)
        break

      case "approval:received":
        if (this.logLevel !== "minimal") {
          this.log(`  Approval: ${event.approved ? "approved" : "rejected"}${event.skipped ? " (skipped)" : ""}`)
        }
        break

      // ── Question events ──
      case "question:asked":
        if (this.logLevel !== "minimal") {
          this.log(`  Question asked (${event.questions.length} question(s))`)
        }
        break

      case "question:replied":
        if (this.logLevel !== "minimal") {
          this.log(`  Question replied`)
        }
        break

      case "question:rejected":
        if (this.logLevel !== "minimal") {
          this.log(`  Question rejected`)
        }
        break

      // ── Budget events ──
      case "budget:warning":
        if (this.logLevel !== "minimal") {
          this.log(`  Budget warning: ${event.metric} ${event.used}/${event.limit} (${event.remaining} remaining)`)
        }
        break

      case "budget:exhausted":
        this.log(`  Budget EXHAUSTED: ${event.reason}`)
        break

      // Subprocess injection events
      case "subprocess:injected":
        if (this.logLevel !== "minimal") {
          this.log(`  Subprocess stdin injected (${event.message.length} chars)`)
        }
        break

      // Dispatcher/evaluator output streaming events
      case "dispatcher:output":
      case "evaluator:output":
        // Streaming output from dispatcher/evaluator subprocesses — no-op in headless mode
        break

      // ── Queue lifecycle events ──
      case "queue:initialized":
        this.log(`Queue initialized (${event.stepIds.length} steps)`)
        break

      case "queue:completed":
        this.log(`Queue completed (${event.stepsCompleted} steps)`)
        break

      case "queue:failed":
        this.log(`Queue FAILED: ${event.reason} (${event.stepsCompleted} steps completed)`)
        break

      // ── Queue step events (normal+) ──
      case "queue:step-started":
        if (this.logLevel !== "minimal") {
          const sprintLabel = event.stepType === "verify" ? " (sprint verification)" :
            event.stepType === "work" && event.stepTitle.includes("Sprint") ? " (sprint iteration)" : ""
          this.log(`  Queue step started: [${event.stepType}] ${event.stepTitle}${sprintLabel}`)
        }
        break

      case "queue:step-completed":
        if (this.logLevel !== "minimal") {
          const sprintLabel = event.stepType === "verify" ? " (sprint verification)" :
            event.stepType === "work" && event.stepTitle.includes("Sprint") ? " (sprint iteration)" : ""
          this.log(`  Queue step completed: [${event.stepType}] ${event.stepTitle}${sprintLabel}`)
        }
        break

      case "queue:step-failed":
        this.log(`  Queue step FAILED: [${event.stepType}] ${event.stepTitle} — ${event.reason}`)
        break

      // ── Queue mutation events (normal+) ──
      case "queue:step-inserted":
        if (this.logLevel !== "minimal") {
          this.log(`  Queue step inserted: [${event.stepType}] ${event.stepTitle} (after ${event.afterStepId})`)
        }
        break

      case "queue:step-removed":
        if (this.logLevel !== "minimal") {
          this.log(`  Queue step removed: [${event.stepType}] ${event.stepTitle}`)
        }
        break

      // ── Trace events (verbose) ──
      case "trace:tool-started":
        if (this.logLevel === "verbose") {
          this.log(`  Trace: tool started — ${event.toolName} (${event.toolUseId})`)
        }
        break

      case "trace:tool-completed":
        if (this.logLevel === "verbose") {
          this.log(`  Trace: tool completed — ${event.toolUseId}${event.isError ? " [ERROR]" : ""}`)
        }
        break

      case "trace:subagent-started":
        if (this.logLevel === "verbose") {
          this.log(`  Trace: subagent started — ${event.agentType}: ${event.description} (${event.toolUseId})`)
        }
        break

      case "trace:subagent-completed":
        if (this.logLevel === "verbose") {
          this.log(`  Trace: subagent completed — ${event.toolUseId}${event.isError ? " [ERROR]" : ""}`)
        }
        break

      default:
        assertNever(event)
    }
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
