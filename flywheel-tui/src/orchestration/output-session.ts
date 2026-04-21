import { NDJSONParser } from "../infra/ndjson-parser.js"
import { StructuredOutputBuilder } from "../infra/output/structured-output-builder.js"
import { StructuredEventParser } from "../infra/output/structured-event-parser.js"
import type { EmitFn } from "../infra/event-bus.js"
import type { SessionEntryBase } from "./session-store-types.js"
import type { AnyBlock } from "../infra/output-blocks.js"

export interface OutputSessionOptions {
  updateEntry: (patch: Partial<SessionEntryBase>) => void
  emit: EmitFn
  onFlush?: () => void
  workflowId?: string
  builder?: StructuredOutputBuilder
  priorBlocks?: readonly AnyBlock[]
}

export interface OutputSession {
  writeStdout(data: string): void
  writeStderr(data: string, timestamp: number): void
  notifySpawned(timestamp: number): void
  notifyInjected(message: string, timestamp: number, pending?: boolean, injected?: boolean): void
  resolvePendingMessages(): string[]
  pushSystemMessage(message: string, timestamp: number): void
  answerQuestion(toolUseId: string, answers: Record<string, string>): void
  cancelQuestion(toolUseId: string): void
  resetTracking(): void
  flushContextRun(timestamp: number): void
  flushParser(): void
  getBlocks(): AnyBlock[]
  resetActivity(): void
  readonly sessionId: string | null
  flush(): void
  dispose(): void
}

export function createOutputSession(options: OutputSessionOptions): OutputSession {
  const { updateEntry, emit, onFlush, workflowId = "output-session" } = options
  const prior = options.priorBlocks ?? []

  const builder = options.builder ?? new StructuredOutputBuilder()
  const eventParser = new StructuredEventParser(builder)
  const parser = new NDJSONParser()

  let disposed = false
  let notifyQueued = false

  function getFullBlocks(): AnyBlock[] {
    const current = builder.getBlocks()
    return prior.length > 0 ? [...prior, ...current] : current
  }

  function syncStore(): void {
    notifyQueued = false
    if (disposed) return
    updateEntry({ outputBlocks: getFullBlocks(), modelActivity: builder.modelActivity })
  }

  let debounceTimer: Timer | undefined
  const BATCH_WINDOW_MS = 200

  builder.onContentChange = () => {
    if (disposed || notifyQueued) return
    notifyQueued = true
    // Content arrival means the user is looking — flush any pending tool group batch too
    clearTimeout(debounceTimer)
    debounceTimer = undefined
    queueMicrotask(syncStore)
  }

  builder.onToolGroupChange = () => {
    if (disposed) return
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(syncStore, BATCH_WINDOW_MS)
  }

  parser.onEvent = (event) => {
    emit("engine:ndjson", { workflowId, ndjsonEvent: event })
    eventParser.dispatch(event)
  }

  parser.onRawText = (text) => {
    if (text.trim().length > 0) builder.pushText(text + "\n", Date.now())
  }

  function writeStdout(data: string) {
    if (disposed) return
    parser.write(data)
  }

  function writeStderr(data: string, timestamp: number) {
    if (disposed) return
    builder.pushSystemMessage(data, timestamp)
  }

  function notifySpawned(timestamp: number): void {
    builder.notifyThinkingStarted(timestamp)
  }

  function notifyInjected(message: string, timestamp: number, pending?: boolean, injected?: boolean): void {
    builder.pushUserMessage(message, timestamp, pending ?? false, injected ?? false)
    builder.notifyThinkingStarted(timestamp)
  }

  // These lambdas narrow the builder's ~15 methods to the OutputSession contract.
  // The forwarding is intentional: consumers depend on OutputSession, not StructuredOutputBuilder.
  // Exposing the builder directly would leak internal methods that callers shouldn't use.
  return {
    writeStdout,
    writeStderr,
    notifySpawned,
    notifyInjected,
    resolvePendingMessages: () => builder.resolvePendingMessages(),
    pushSystemMessage: (message: string, timestamp: number) => builder.pushSystemMessage(message, timestamp),
    answerQuestion: (toolUseId: string, answers: Record<string, string>) => builder.answerQuestion(toolUseId, answers),
    cancelQuestion: (toolUseId: string) => builder.cancelQuestion(toolUseId),
    resetTracking: () => builder.resetTracking(),
    flushContextRun: (timestamp: number) => builder.flushContextRun(timestamp),
    flushParser: () => parser.flush(),
    getBlocks: getFullBlocks,
    resetActivity() {
      const now = Date.now();
      builder.flushContextRun(now);
      builder.closeOpenSubagents(now);
      builder.resetActivity();
      updateEntry({ modelActivity: "idle" });
    },
    get sessionId() { return parser.sessionId },
    flush(): void {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
      updateEntry({ outputBlocks: getFullBlocks(), modelActivity: builder.modelActivity })
      onFlush?.()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      clearTimeout(debounceTimer)
      debounceTimer = undefined
      builder.onContentChange = null
      builder.onToolGroupChange = null
    },
  }
}
