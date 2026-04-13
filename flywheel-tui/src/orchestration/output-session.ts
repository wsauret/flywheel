import { NDJSONParser } from "../infra/ndjson-parser"
import { StructuredOutputBuilder } from "../infra/output/structured-output-builder"
import { StructuredEventParser } from "../infra/output/structured-event-parser"
import type { EmitFn } from "../infra/event-bus"
import type { SessionEntryBase } from "./session-store-types"
import type { AnyBlock } from "../infra/output-blocks"

export interface OutputSessionOptions {
  updateEntry: (patch: Partial<SessionEntryBase>) => void
  emit: EmitFn
  onFlush?: () => void
  workflowId?: string
  builder?: StructuredOutputBuilder
}

export interface OutputSession {
  writeStdout(data: string, engineId?: string): void
  writeStderr(data: string, timestamp: number): void
  notifySpawned(timestamp: number): void
  notifyInjected(message: string, timestamp: number, pending?: boolean, injected?: boolean): void
  resolvePendingMessages(): boolean
  pushSystemMessage(message: string, timestamp: number): void
  resetTracking(): void
  flushContextRun(timestamp: number): void
  flushParser(): void
  getBlocks(): AnyBlock[]
  readonly sessionId: string | null
  flush(): void
  dispose(): void
}

export function createOutputSession(options: OutputSessionOptions): OutputSession {
  const { updateEntry, emit, onFlush, workflowId = "output-session" } = options

  const builder = options.builder ?? new StructuredOutputBuilder()
  const eventParser = new StructuredEventParser({ builder })
  const parser = new NDJSONParser()

  let disposed = false
  let flushIntervalId: ReturnType<typeof setInterval> | null = null

  let currentEngineId: string | undefined
  let prevBlocks = builder.getBlocks()
  let prevActivity = builder.modelActivity

  parser.onEvent = (event) => {
    emit("subprocess:ndjson", { workflowId, ndjsonEvent: event })
    eventParser.dispatch(event, currentEngineId)
  }

  parser.onRawText = (text) => {
    if (text.trim().length > 0) builder.pushText(text + "\n", Date.now())
  }

  flushIntervalId = setInterval(() => {
    const blocks = builder.getBlocks()
    const activity = builder.modelActivity
    const patch: Partial<SessionEntryBase> = {}
    if (blocks !== prevBlocks) { prevBlocks = blocks; patch.outputBlocks = blocks }
    if (activity !== prevActivity) { prevActivity = activity; patch.modelActivity = activity }
    if (patch.outputBlocks || patch.modelActivity) updateEntry(patch)
    onFlush?.()
  }, 16)

  function writeStdout(data: string, engineId?: string) {
    if (disposed) return
    if (engineId !== undefined) currentEngineId = engineId
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

  // Forwarding lambdas narrow the builder's ~15 methods to the OutputSession interface
  return {
    writeStdout,
    writeStderr,
    notifySpawned,
    notifyInjected,
    resolvePendingMessages: () => builder.resolvePendingMessages(),
    pushSystemMessage: (message: string, timestamp: number) => builder.pushSystemMessage(message, timestamp),
    resetTracking: () => builder.resetTracking(),
    flushContextRun: (timestamp: number) => builder.flushContextRun(timestamp),
    flushParser: () => parser.flush(),
    getBlocks: () => builder.getBlocks(),
    get sessionId() { return parser.sessionId },
    flush(): void {
      prevActivity = builder.modelActivity
      updateEntry({ outputBlocks: builder.getBlocks(), modelActivity: prevActivity })
      onFlush?.()
    },
    dispose(): void {
      if (disposed) return
      disposed = true
      currentEngineId = undefined
      if (flushIntervalId !== null) {
        clearInterval(flushIntervalId)
        flushIntervalId = null
      }
    },
  }
}
