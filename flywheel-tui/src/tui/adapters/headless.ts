/**
 * Headless UI Adapter
 *
 * A minimal UI adapter that logs workflow events to console or file.
 * Used for CI/CD, automation, and non-interactive environments.
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { BaseUIAdapter } from "./base"
import type { AdapterType } from "./types"
import type { FlywheelEvent } from "../../events/types"
import { assertNever } from "../../events/types"

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
 * - normal: + phase/step + output
 * - verbose: + dispatcher/evaluator events
 */
export class HeadlessAdapter extends BaseUIAdapter {
  readonly adapterType: AdapterType = "headless"
  private logFile: string | null = null
  private logStream: fs.WriteStream | null = null
  private logLevel: "minimal" | "normal" | "verbose"
  private customLogger: ((message: string) => void) | null = null
  private showTimestamps: boolean

  constructor(options: HeadlessAdapterOptions = {}) {
    super()
    this.logFile = options.logFile || null
    this.logLevel = options.logLevel || "normal"
    this.customLogger = options.logger || null
    this.showTimestamps = options.timestamps ?? true
  }

  start(): void {
    super.start()
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
    if (this.logStream) {
      this.logStream.end()
      this.logStream = null
    }
    super.stop()
  }

  protected handleEvent(event: FlywheelEvent): void {
    switch (event.type) {
      // ── Workflow lifecycle ──
      case "workflow:started":
        this.log(`Workflow started: ${event.planPath}`)
        break

      case "workflow:completed":
        this.log("Workflow completed")
        break

      case "workflow:failed":
        this.log(`Workflow FAILED: ${event.reason}`)
        break

      case "workflow:interrupted":
        this.log(`Workflow interrupted: ${event.reason}`)
        break

      // ── Phase events (normal+) ──
      case "phase:started":
        if (this.logLevel !== "minimal") {
          this.log(`Phase ${event.phaseIndex}: ${event.phaseName} — started`)
        }
        break

      case "phase:completed":
        if (this.logLevel !== "minimal") {
          this.log(`Phase ${event.phaseIndex} — completed`)
        }
        break

      case "phase:failed":
        this.log(`Phase ${event.phaseIndex} — FAILED: ${event.reason}`)
        break

      // ── Step events (normal+) ──
      case "step:started":
        if (this.logLevel !== "minimal") {
          this.log(`  Step ${event.stepIndex}: ${event.description}`)
        }
        break

      case "step:completed":
        if (this.logLevel !== "minimal") {
          this.log(`  Step ${event.stepIndex} — done`)
        }
        break

      case "step:failed":
        this.log(`  Step ${event.stepIndex} — FAILED: ${event.reason}`)
        break

      // ── Worker events (normal+) ──
      case "worker:spawned":
        if (this.logLevel !== "minimal") {
          this.log(`  Worker spawned for step ${event.stepIndex}`)
        }
        break

      case "worker:completed":
        if (this.logLevel !== "minimal") {
          this.log("  Worker completed")
        }
        break

      case "worker:failed":
        this.log(`  Worker FAILED: ${event.failure.message}`)
        break

      case "worker:retrying":
        if (this.logLevel !== "minimal") {
          this.log(`  Worker retrying (${event.attempt}/${event.maxAttempts}): ${event.reason}`)
        }
        break

      case "worker:output":
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

      // ── Pipeline events ──
      case "pipeline:started":
        this.log(`Pipeline started: ${event.stages.join(" → ")}`)
        break

      case "pipeline:completed":
        this.log(`Pipeline completed (${event.stagesCompleted} stages)`)
        break

      case "pipeline:failed":
        this.log(`Pipeline FAILED: ${event.reason} (${event.stagesCompleted} stages completed)`)
        break

      case "pipeline:stage-transition":
        if (this.logLevel !== "minimal") {
          this.log(`Pipeline stage: ${event.from} → ${event.to}`)
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

      // Worker injection events
      case "worker:injected":
        if (this.logLevel !== "minimal") {
          this.log(`  Worker stdin injected (${event.message.length} chars)`)
        }
        break

      // Dispatcher/evaluator output streaming events
      case "dispatcher:output":
      case "evaluator:output":
        // Streaming output from dispatcher/evaluator subprocesses — no-op in headless mode
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
