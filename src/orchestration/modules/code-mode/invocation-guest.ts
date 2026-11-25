import { Effect, Schema } from "effect"
import { CodeMode } from "../../../infra/code-mode/index.js"
import { toolError, type ToolError } from "../../../infra/code-mode/tool-error.js"
import { unknownTool, type ToolRuntimeError } from "../../../infra/code-mode/tool-runtime.js"
import { errorMessage } from "../../../infra/diagnostics/error-message.js"
import { redactDeep, redactSecrets } from "../../../infra/redact-secrets.js"
import { CodeToolResultSchema, toolTrie, type CodeToolResult } from "./descriptors.js"
import { HostMessageSchema, type CallReply, type GuestMessage, type HostMessage } from "./invocation-protocol.js"
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

function replyEffect(name: string, reply: CallReply): Effect.Effect<CodeToolResult, ToolError | ToolRuntimeError> {
  if (reply.kind === "refused") return Effect.fail(toolError(reply.message))
  if (reply.kind === "unresolved") return Effect.fail(unknownTool(name))
  // Parse before redacting: JSON escapes can hide a credential from the text
  // redactor and re-materialize it after JSON.parse.
  return Effect.sync(() => Schema.decodeUnknownSync(CodeToolResultSchema)({ outcome: reply.outcome, content: redactDeep(parseJsonDocument(reply.content)) }))
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

function heapLimitResult(maxHeapDeltaBytes: number, bash: boolean): CodeMode.Result {
  return {
    ok: false,
    error: {
      kind: "ExecutionFailure",
      message: `Execution exceeded the ${maxHeapDeltaBytes}-byte heap growth budget. ${bash ? "Keep heavy computation in Bash scratch scripts." : "Move heavy computation outside Code Mode."}`,
    },
    toolCalls: [],
  }
}

type Resume = (reply: CallReply) => void

/** The state of the one invocation a guest runs. It exists from `start`
 *  until the next `reset`, and nothing in it survives that reset. */
interface Invocation {
  /** The bridge calls that wait for a host reply, by call id. */
  readonly pending: Map<number, Resume>
  readonly logs: ReturnType<typeof createLogStream>
  /** Whether the program ended and its result was posted. */
  ended: boolean
}

/** Serves the invocations its host starts on `port`, one at a time, and
 *  posts one result for each. Every program runs in a new interpreter (the
 *  `execute` of a prepared `CodeMode` runtime), which owns the program's
 *  globals, promises, and console, so none of them outlives that execution.
 *  The guest holds the runtime of the last revision it prepared across
 *  invocations: it holds only the `tools` trie and the search index, whose
 *  calls and console lines reach the invocation that runs. Before the host
 *  reuses the Worker, it sends `reset`: the guest drops the ended invocation's
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
  let held: { readonly revision: string; readonly runtime: CodeMode.Runtime } | undefined

  // Only a running program calls a tool or logs, and its invocation exists
  // from its start until the reset after its result.
  const running = (): Invocation => {
    if (invocation === undefined) throw new Error("Code runtime received a tool call or console line outside a program.")
    return invocation
  }
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary: the argument that model-written Code Mode code passes to a tool, which the nested tool dispatch decodes
  const call = (name: string, input: unknown) => Effect.callback<CodeToolResult, ToolError | ToolRuntimeError>((resume) => {
    const current = running()
    const id = nextCallId++
    current.pending.set(id, (reply) => resume(replyEffect(name, reply)))
    current.logs.flush()
    port.postMessage({ type: "call", id, name, input })
    // An interrupted call is dropped here; the host's nested batch owns
    // the dispatched work and closes it.
    return Effect.sync(() => { current.pending.delete(id) })
  })
  const onLog = (line: string, view: CodeMode.ConsoleLogView) => running().logs.onLog(line, view)

  // A Worker serves one pool, whose limits do not change, so a held runtime
  // keeps the limits of the start that prepared it.
  const prepare = (start: Extract<HostMessage, { type: "start" }>): CodeMode.Runtime => {
    if (start.descriptors === undefined) {
      if (held === undefined || held.revision !== start.revision) throw new Error(`Code runtime does not hold the prepared tools of revision '${start.revision}'.`)
      return held.runtime
    }
    const { maxToolCalls, maxLogBytes } = start.limits
    const runtime = CodeMode.make({
      tools: toolTrie(start.descriptors, (descriptor, input) => call(descriptor.name, input)),
      limits: { maxToolCalls, maxLogBytes }, onLog, onUnknownTool: call,
    })
    if (start.revision !== undefined) held = { revision: start.revision, runtime }
    return runtime
  }

  const run = async (start: Extract<HostMessage, { type: "start" }>, current: Invocation): Promise<void> => {
    const { maxHeapDeltaBytes, heapSampleMs } = start.limits
    // The Worker runs one invocation at a time. The baseline comes from the
    // Worker's start or from the last reset, which collected every earlier
    // invocation's garbage first, so growth past it is this program's alone.
    const baseline = baselineHeapBytes
    const execution = prepare(start).execute(start.source)
      .pipe(Effect.map((result) => ({ result, ending: "returned" as const })))
    const heapWatchdog = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(heapSampleMs)
        if (process.memoryUsage().heapUsed - baseline > maxHeapDeltaBytes) return { result: heapLimitResult(maxHeapDeltaBytes, start.bash), ending: "heap-limit" as const }
      }
    })
    const { result, ending } = await Effect.runPromise(Effect.raceFirst(execution, heapWatchdog), { signal: stopped.signal })
    current.logs.flush()
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
    const message = Schema.decodeUnknownSync(HostMessageSchema)(event.data)
    if (message.type === "call-result") {
      const resume = invocation?.pending.get(message.id)
      invocation?.pending.delete(message.id)
      resume?.(message.reply)
      return
    }
    if (message.type === "reset") return reset()
    if (invocation !== undefined) throw new Error("Code runtime received a program before the previous one was reset.")
    const current: Invocation = { pending: new Map(), logs: createLogStream(port), ended: false }
    invocation = current
    run(message, current).catch((error: unknown) => {
      if (stopped.signal.aborted) return
      current.ended = true
      port.postMessage({ type: "result", outcome: "error", text: redactSecrets(`Code runtime failed: ${errorMessage(error)}`), ending: "crashed" })
    })
  })
  return () => stopped.abort()
}
