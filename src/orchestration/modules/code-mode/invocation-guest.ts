import { Effect, Schema } from "effect"
import { CodeMode } from "../../../infra/code-mode/index.js"
import { toolError, type ToolError } from "../../../infra/code-mode/tool-error.js"
import { errorMessage } from "../../../infra/error-message.js"
import { redactDeep, redactSecrets } from "../../../infra/redact-secrets.js"
import { CodeToolResult, toolTrie } from "./descriptors.js"
import { GuestMessage, HostMessage, type CallReply } from "./invocation-protocol.js"
import { formatCodeModeResult } from "./result-format.js"

/** The guest's side of its Worker's channel: the Worker global scope, or a
 *  message port when a test hosts the guest on its own thread. */
export interface GuestPort {
  postMessage(message: GuestMessage): void
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
type JsonDocument = JsonValue[] | { [key: string]: JsonValue }

/** MCP servers and structured tools serialize JSON documents into text.
 *  Hand scripts the parsed object or array so projection is plain property
 *  access; anything else (plain text, scalar JSON, malformed JSON) stays a
 *  string. */
function parseJsonDocument(content: string): string | JsonDocument {
  const first = content.trimStart()[0]
  if (first !== "{" && first !== "[") return content
  try {
    return JSON.parse(content)
  } catch {
    return content
  }
}

function replyEffect(reply: CallReply): Effect.Effect<CodeToolResult, ToolError> {
  if (reply.kind === "refused") return Effect.fail(toolError(reply.message))
  // Parse before redacting: JSON escapes can hide a credential from the text
  // redactor and re-materialize it after JSON.parse.
  return Effect.sync(() => Schema.decodeUnknownSync(CodeToolResult)({ outcome: reply.outcome, content: redactDeep(parseJsonDocument(reply.content)) }))
}

/** Streams newly retained console lines to the host. Lines leave in a
 *  microtask and before every call or result, so a nested row the host
 *  records always lands after the console lines that preceded its call. The
 *  drop marker is read once per flush, never once per dropped line. */
function createLogStream(port: GuestPort) {
  let view: CodeMode.ConsoleLogView | undefined
  let sentLines = 0
  let lines: string[] = []
  let droppedSinceFlush = false
  let scheduled = false
  const flush = (): void => {
    scheduled = false
    if (lines.length === 0 && !droppedSinceFlush) return
    const dropped = droppedSinceFlush ? view?.snapshot().logs?.at(-1) : undefined
    port.postMessage({ type: "log", lines, ...(dropped === undefined ? {} : { dropped }) })
    lines = []
    droppedSinceFlush = false
  }
  return {
    flush,
    onLog: (line: string, latest: CodeMode.ConsoleLogView) => Effect.sync(() => {
      view = latest
      if (latest.retainedLineCount > sentLines) {
        sentLines = latest.retainedLineCount
        lines.push(line)
      } else {
        droppedSinceFlush = true
      }
      if (scheduled) return
      scheduled = true
      queueMicrotask(flush)
    }),
  }
}

function heapLimitResult(maxHeapDeltaBytes: number): CodeMode.Result {
  return {
    ok: false,
    error: {
      kind: "ExecutionFailure",
      message: `Execution exceeded the ${maxHeapDeltaBytes}-byte heap growth budget. Keep heavy computation in Bash scratch scripts.`,
    },
    toolCalls: [],
  }
}

type Resume = (effect: Effect.Effect<CodeToolResult, ToolError>) => void

/** The state of the one invocation a guest runs. It exists from `start`
 *  until the next `reset`, and nothing in it survives that reset. */
interface Invocation {
  /** The bridge calls that wait for a host reply, by call id. */
  readonly pending: Map<number, Resume>
  /** Whether the program ended and its result was posted. */
  ended: boolean
}

/** Serves the invocations its host starts on `port`, one at a time, and
 *  posts one result for each. Every program runs in a new interpreter
 *  (`CodeMode.execute`), which owns the program's globals, promises, and
 *  console, so none of them outlives that execution. Before the host reuses
 *  the Worker, it sends `reset`: the guest drops the ended invocation's
 *  registries, collects its heap, and takes the heap baseline that the next
 *  invocation's watchdog measures against. The guest never closes its own
 *  Worker: the host terminates it, because terminating a Worker that already
 *  exited is unsafe. The returned stop interrupts the program for a host that
 *  shares the guest's thread; a Worker host stops the guest by terminating
 *  the thread instead. */
export function runGuest(port: GuestPort): () => void {
  const stopped = new AbortController()
  // Call ids stay unique for the Worker's whole life, so a late reply to a
  // call of an ended invocation can never resolve a call of a later one.
  let nextCallId = 0
  let baselineHeapBytes = process.memoryUsage().heapUsed
  let invocation: Invocation | undefined

  const run = async (start: Extract<HostMessage, { type: "start" }>, current: Invocation): Promise<void> => {
    const logs = createLogStream(port)
    const call = (name: string, input: unknown) => Effect.callback<CodeToolResult, ToolError>((resume) => {
      const id = nextCallId++
      current.pending.set(id, resume)
      logs.flush()
      port.postMessage({ type: "call", id, name, input })
      // An interrupted call is dropped here; the host's nested batch owns
      // the dispatched work and closes it.
      return Effect.sync(() => { current.pending.delete(id) })
    })
    const tools = toolTrie(start.descriptors, (descriptor, input) => call(descriptor.name, input))
    const { maxToolCalls, maxLogBytes, maxHeapDeltaBytes, heapSampleMs } = start.limits
    // The Worker runs one invocation at a time. The baseline comes from the
    // Worker's start or from the last reset, which collected every earlier
    // invocation's garbage first, so growth past it is this program's alone.
    const baseline = baselineHeapBytes
    const execution = CodeMode.execute({
      code: start.source, tools, limits: { maxToolCalls, maxLogBytes }, onLog: logs.onLog,
      onUnknownTool: call,
    })
      .pipe(Effect.map((result) => ({ result, ending: "returned" as const })))
    const heapWatchdog = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(heapSampleMs)
        if (process.memoryUsage().heapUsed - baseline > maxHeapDeltaBytes) return { result: heapLimitResult(maxHeapDeltaBytes), ending: "heap-limit" as const }
      }
    })
    const { result, ending } = await Effect.runPromise(Effect.raceFirst(execution, heapWatchdog), { signal: stopped.signal })
    logs.flush()
    current.ended = true
    port.postMessage({ type: "result", outcome: result.ok ? "ok" : "error", text: formatCodeModeResult(result), ending })
  }

  const reset = (): void => {
    if (invocation !== undefined && !invocation.ended) throw new Error("Code runtime received a reset while a program was running.")
    invocation?.pending.clear()
    invocation = undefined
    Bun.gc(true)
    baselineHeapBytes = process.memoryUsage().heapUsed
    port.postMessage({ type: "ready", heapBytes: baselineHeapBytes })
  }

  port.addEventListener("message", (event) => {
    const message = Schema.decodeUnknownSync(HostMessage)(event.data)
    if (message.type === "call-result") {
      const resume = invocation?.pending.get(message.id)
      invocation?.pending.delete(message.id)
      resume?.(replyEffect(message.reply))
      return
    }
    if (message.type === "reset") return reset()
    if (invocation !== undefined) throw new Error("Code runtime received a program before the previous one was reset.")
    const current: Invocation = { pending: new Map(), ended: false }
    invocation = current
    run(message, current).catch((error: unknown) => {
      if (stopped.signal.aborted) return
      current.ended = true
      port.postMessage({ type: "result", outcome: "error", text: redactSecrets(`Code runtime failed: ${errorMessage(error)}`), ending: "crashed" })
    })
  })
  return () => stopped.abort()
}
