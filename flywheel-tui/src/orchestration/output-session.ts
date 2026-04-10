/**
 * Output Session — shared output pipeline abstraction.
 *
 * Encapsulates NDJSONParser -> StructuredEventParser -> StructuredOutputBuilder
 * and a 16ms flush timer that writes blocks + modelActivity to the session store
 * via `updateEntry`. Callers (chat mode, workflow mode) use the same interface.
 *
 * Design decisions:
 * - `updateEntry` is passed directly (ADR-006 compliant).
 * - `emit` is required (supply no-op in tests).
 * - `builder` is NOT exposed — only promoted methods (resolvePendingMessages,
 *   pushSystemMessage, resetTracking) plus getBlocks().
 * - `engineId` is per-call on writeStdout, not constructor state.
 * - `flush()` is synchronous eager write for data-loss-risk events.
 * - `onFlush` is called on every 16ms flush tick. Use for display-refresh work (budget metrics, persistence).
 */

import { NDJSONParser } from "./engines/subprocess/ndjson-parser"
import { StructuredOutputBuilder } from "../infra/output/structured-output-builder"
import { StructuredEventParser } from "../infra/output/structured-event-parser"
import type { ModelActivity } from "../infra/events"
import type { EmitFn } from "../infra/event-bus"
import type { SessionEntryBase } from "./session-store"
import type { AnyBlock } from "../infra/output-blocks"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OutputSessionOptions {
  /** Store mutator — OutputSession writes outputBlocks and modelActivity here. */
  updateEntry: (patch: Partial<SessionEntryBase>) => void
  /** EventBus emit — required. Supply no-op in tests. */
  emit: EmitFn
  /** Called on every 16ms flush tick. Use for display-refresh work (budget metrics, persistence). */
  onFlush?: () => void
  /** Workflow ID used in subprocess:ndjson events. Defaults to "output-session". */
  workflowId?: string
  /**
   * Advanced: inject a shared builder when other components need to write to
   * the same block stream (e.g. NdjsonPipeline in workflow mode). When provided,
   * OutputSession uses this builder instead of creating a new one.
   */
  builder?: StructuredOutputBuilder
}

export interface OutputSession {
  /** Feed subprocess stdout data through the NDJSON pipeline. */
  writeStdout(data: string, engineId?: string): void
  /** Feed subprocess stderr data — rendered as a system block. */
  writeStderr(data: string, timestamp: number): void

  /** Signal that a subprocess was spawned (starts thinking indicator). */
  notifySpawned(timestamp: number): void
  /** Signal that a message was injected into the subprocess. */
  notifyInjected(message: string, timestamp: number, pending?: boolean): void

  /** Resolve all pending user messages. Returns true if any were resolved. */
  resolvePendingMessages(): boolean
  /** Push a system message block. */
  pushSystemMessage(message: string, timestamp: number): void
  /** Reset worker-level tracking state (agent IDs, context runs) while preserving blocks. */
  resetTracking(): void
  /** Close the current context tool run. Call at turn boundaries so the last group doesn't stay "active". */
  flushContextRun(timestamp: number): void
  /** Flush the NDJSON parser's line buffer (call on process exit to process any partial line). */
  flushParser(): void

  /** Read-only access to current blocks. */
  getBlocks(): AnyBlock[]

  /** The NDJSON parser's captured session ID (from Claude Code's first "system" event). */
  readonly sessionId: string | null

  /** Force an immediate flush (updateEntry + onFlush) regardless of the 16ms interval. */
  flush(): void

  /** Stop flush interval. MUST be called after subprocess exits. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOutputSession(options: OutputSessionOptions): OutputSession {
  const { updateEntry, emit, onFlush, workflowId = "output-session" } = options

  // ── Internal pipeline components ──

  const builder = options.builder ?? new StructuredOutputBuilder()
  const eventParser = new StructuredEventParser({ builder })
  const parser = new NDJSONParser()

  let disposed = false
  let flushIntervalId: ReturnType<typeof setInterval> | null = null

  // Track the last engineId for event dispatch
  let currentEngineId: string | undefined

  // ── Wire model activity → updateEntry ──

  builder.onModelActivityChange = (activity: ModelActivity) => {
    updateEntry({ modelActivity: activity })
  }

  // ── Wire NDJSON parser → event parser + EventBus ──

  parser.onEvent = (event) => {
    // Emit to EventBus — infra subscribers (budget, transcript, tracing) consume this
    emit("subprocess:ndjson", { workflowId, ndjsonEvent: event })
    // Dispatch to structured event parser for block rendering
    eventParser.dispatch(event, currentEngineId)
  }

  // Default raw text handler: non-JSON lines become text blocks
  parser.onRawText = (text) => {
    if (text.trim().length > 0) builder.pushText(text + "\n", Date.now())
  }

  // ── 16ms flush interval ──

  flushIntervalId = setInterval(() => {
    if (disposed) return
    if (builder.hasChanged()) {
      updateEntry({ outputBlocks: builder.getBlocks() })
    }
    onFlush?.()
  }, 16)

  // ── Public methods ──

  function writeStdout(data: string, engineId?: string): void {
    if (disposed) return
    if (engineId !== undefined) {
      currentEngineId = engineId
    }
    parser.write(data)
  }

  function writeStderr(data: string, timestamp: number): void {
    if (disposed) return
    builder.pushSystemMessage(data, timestamp)
    // Flushed by the 16ms interval — not a data-loss-risk event
  }

  function notifySpawned(timestamp: number): void {
    builder.notifyThinkingStarted(timestamp)
  }

  function notifyInjected(message: string, timestamp: number, pending?: boolean): void {
    builder.pushUserMessage(message, timestamp, pending ?? false, true)
    builder.notifyThinkingStarted(timestamp)
  }

  function resolvePendingMessages(): boolean {
    return builder.resolvePendingMessages()
  }

  function pushSystemMessage(message: string, timestamp: number): void {
    builder.pushSystemMessage(message, timestamp)
  }

  function resetTracking(): void {
    builder.resetTracking()
  }

  function flushContextRun(timestamp: number): void {
    builder.flushContextRun(timestamp)
  }

  function flushParser(): void {
    parser.flush()
  }

  function getBlocks(): AnyBlock[] {
    return builder.getBlocks()
  }

  function flush(): void {
    // Force immediate write regardless of dirty state
    updateEntry({ outputBlocks: builder.getBlocks() })
    onFlush?.()
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    currentEngineId = undefined
    if (flushIntervalId !== null) {
      clearInterval(flushIntervalId)
      flushIntervalId = null
    }
    builder.dispose()
  }

  return {
    writeStdout,
    writeStderr,
    notifySpawned,
    notifyInjected,
    resolvePendingMessages,
    pushSystemMessage,
    resetTracking,
    flushContextRun,
    flushParser,
    getBlocks,
    get sessionId() { return parser.sessionId },
    flush,
    dispose,
  }
}
