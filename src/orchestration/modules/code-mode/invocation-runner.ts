import { Cause, Effect, Exit, Schema } from "effect"
import type { Result } from "../../../infra/code-mode/codemode.js"
import { errorMessage } from "../../../infra/error-message.js"
import { probeLoopUnit } from "../../../infra/event-loop-lag.js"
import type { LlmToolOutputPart } from "../../../infra/llm/tool-output-part-schema.js"
import { redactSecretEntries, redactSecrets } from "../../../infra/redact-secrets.js"
import type { NestedToolDispatchBatch } from "../../agent-runtime/tools/nested-tool-dispatch.js"
import { boundedStringCodeModeOutput, type ToolContext, type ToolResult } from "../../agent-runtime/tools/types.js"
import { repairToolName } from "../../agent-runtime/tools/tool-dispatch.js"
import type { CodeModeToolSet } from "./descriptors.js"
import { GuestMessage, type CallReply, type HostMessage } from "./invocation-protocol.js"
import type { CodeModeLimits } from "./limits.js"
import { formatCodeModeResult } from "./result-format.js"
import type { InvocationWorker, InvocationWorkerPool, RetireReason } from "./worker-pool.js"

/** One admitted call of the `code` tool, pinned to its request. */
export interface CodeModeInvocation {
  readonly source: string
  readonly tools: CodeModeToolSet
  readonly parentToolUseId: string
  readonly createBatch: NonNullable<ToolContext["createNestedToolDispatchBatch"]>
}

export interface InvocationOwner {
  readonly limits: CodeModeLimits
  readonly workers: InvocationWorkerPool
}

type ImagePart = Extract<LlmToolOutputPart, { type: "image" }>
type Ended =
  | { readonly kind: "result"; readonly outcome: "ok" | "error"; readonly text: string; readonly ending: Extract<GuestMessage, { type: "result" }>["ending"] }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "timeout" }
  | { readonly kind: "interrupted" }

/** How an invocation ended, with the nested calls that still ran at that moment. */
interface Ending {
  readonly ended: Ended
  readonly running: ReadonlyArray<string>
}

/** What happens to the Worker of an invocation that ended this way. Only a
 *  program that returned on its own leaves a guest that a reset can clear. */
function verdictOf(ended: Ended): "reuse" | RetireReason {
  if (ended.kind === "result") return ended.ending === "returned" ? "reuse" : ended.ending
  return ended.kind
}

/** Mirrors the guest's retained console and publishes it with the nested
 *  input previews the host's batch reports, on one trailing timer. */
function createLogMirror(context: ToolContext, limits: CodeModeLimits) {
  const consoleLines: string[] = []
  let dropped: string | undefined
  const nestedRows: { readonly consolePosition: number; readonly text: string }[] = []
  let nestedBytes = 0
  let omittedNestedRows = 0
  let dirty = false
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const snapshot = (): Pick<Result, "logs" | "truncated"> => dropped !== undefined
    ? { logs: [...consoleLines, dropped], truncated: true }
    : consoleLines.length > 0 ? { logs: [...consoleLines] } : {}
  const flush = (): void => {
    if (!dirty) return
    dirty = false
    const current = snapshot()
    // Nested delimiters must never complete a console key or change its cut boundary.
    const redacted = redactSecretEntries(current.logs ?? [], current.truncated ? "prefix" : "complete")
    const lines: string[] = []
    let position = 0
    for (const row of nestedRows) {
      // SAFETY: a row records the mirror's append-only line count, so every earlier line exists.
      while (position < row.consolePosition) lines.push(redacted[position++]!)
      lines.push(row.text)
    }
    // SAFETY: the redacted snapshot is a dense array and position is below its length.
    while (position < redacted.length) lines.push(redacted[position++]!)
    // Keep count-only feedback outside cut secret text so every later start is visible.
    const omitted = omittedNestedRows > 0 ? `[${omittedNestedRows} additional nested input previews omitted]` : undefined
    context.onExecutionOutput?.([lines.join("\n"), omitted].filter((part) => part !== undefined && part !== "").join("\n"))
  }
  const cancelTimer = (): void => {
    if (timer === undefined) return
    clearTimeout(timer)
    timer = undefined
  }
  return {
    snapshot,
    receive(lines: readonly string[], marker: string | undefined): void {
      if (closed) return
      consoleLines.push(...lines)
      dropped = marker ?? dropped
      dirty = true
      timer ??= setTimeout(() => {
        timer = undefined
        flush()
      }, limits.logFlushIntervalMs)
    },
    publish(line: string): void {
      if (closed) return
      if (omittedNestedRows > 0) {
        omittedNestedRows++
      } else {
        // Nested rows are complete at this boundary; redact before measuring or retaining.
        const text = redactSecrets(line)
        const bytes = Buffer.byteLength(text, "utf8") + 1
        if (nestedBytes + bytes > limits.maxNestedPreviewBytes) {
          omittedNestedRows++
        } else {
          nestedBytes += bytes
          nestedRows.push({ consolePosition: consoleLines.length, text })
        }
      }
      dirty = true
      cancelTimer()
      flush()
    },
    close(): void {
      if (closed) return
      closed = true
      cancelTimer()
      flush()
    },
  }
}

type LogMirror = ReturnType<typeof createLogMirror>

/** Answers the guest's calls against this invocation's exact callable map
 *  and accounts their results. Only names in that map reach dispatch. An
 *  abort of `signal` ends the invocation like any other ending, so the result
 *  still names the nested calls that it leaves running. */
function attachBridge(worker: InvocationWorker, signal: AbortSignal | undefined, tools: CodeModeToolSet, batch: NestedToolDispatchBatch, logs: LogMirror, limits: CodeModeLimits, end: (ended: Ended) => void) {
  let closed = false
  let callIndex = 0
  let acceptedBytes = 0
  const collected: { readonly index: number; readonly images: readonly ImagePart[] }[] = []
  const reply = (id: number, answer: CallReply): void => {
    if (closed) return
    // The post clones the whole result on this thread, which takes several
    // milliseconds for a result of some megabytes, so it is a probed loop unit.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: Bun Worker.postMessage has no target origin
    probeLoopUnit("code-mode", "call-result-post", () => worker.postMessage({ type: "call-result", id, reply: answer } satisfies HostMessage))
  }
  const call = (id: number, name: string, input: unknown): void => {
    const index = callIndex++
    void Effect.runPromise(batch.execute(name, input)).then((result) => {
      if (closed) return
      const tool = tools.callable.get(name) ?? tools.callable.get(repairToolName(name, tools.callable) ?? "")
      if (tool === undefined) return reply(id, { kind: "refused", message: boundedStringCodeModeOutput.encode(result).content })
      const encoded = (tool.codeModeOutput ?? boundedStringCodeModeOutput).encode(result)
      const images = typeof result.content === "string" ? [] : result.content.flatMap((part) => part.type === "image" ? [part] : [])
      const bytes = Buffer.byteLength(encoded.content, "utf8") + images.reduce((total, image) => total + Buffer.byteLength(image.data, "utf8"), 0)
      if (acceptedBytes + bytes > limits.maxAggregateResultBytes) {
        return reply(id, { kind: "refused", message: `Nested tool results exceeded the ${limits.maxAggregateResultBytes}-byte aggregate limit. Process fewer or smaller results.` })
      }
      acceptedBytes += bytes
      if (images.length > 0) collected.push({ index, images })
      reply(id, { kind: "ok", outcome: encoded.outcome, content: encoded.content })
    }, (error: unknown) => reply(id, { kind: "refused", message: `Tool '${name}' failed: ${errorMessage(error)}` }))
  }
  const onMessage = (event: MessageEvent): void => {
    if (closed) return
    const decoded = Schema.decodeUnknownExit(GuestMessage)(event.data)
    if (Exit.isFailure(decoded)) return end({ kind: "failed", message: "Code runtime failed: it sent a malformed message." })
    const message = decoded.value
    if (message.type === "log") return logs.receive(message.lines, message.dropped)
    if (message.type === "call") return call(message.id, message.name, message.input)
    if (message.type === "ready") return end({ kind: "failed", message: "Code runtime failed: it reported a reset that no one requested." })
    end({ kind: "result", outcome: message.outcome, text: message.text, ending: message.ending })
  }
  const onError = (event: ErrorEvent): void => end({ kind: "failed", message: `Code runtime failed: ${event.message || "it reported no cause"}` })
  const onClose = (): void => end({ kind: "failed", message: "Code runtime failed: its Worker ended before it answered." })
  const onAbort = (): void => end({ kind: "interrupted" })
  worker.addEventListener("message", onMessage)
  worker.addEventListener("error", onError)
  worker.addEventListener("close", onClose)
  // Admission resolves asynchronously, so the abort can precede this listener.
  if (signal?.aborted === true) onAbort()
  else signal?.addEventListener("abort", onAbort, { once: true })
  return {
    images: (): ImagePart[] => collected.toSorted((left, right) => left.index - right.index).flatMap(({ images }) => images),
    detach(): void {
      closed = true
      worker.removeEventListener("message", onMessage)
      worker.removeEventListener("error", onError)
      worker.removeEventListener("close", onClose)
      signal?.removeEventListener("abort", onAbort)
    },
  }
}

function failure(kind: "ExecutionFailure" | "TimeoutExceeded", message: string, logs: LogMirror): string {
  return formatCodeModeResult({ ok: false, error: { kind, message }, ...logs.snapshot(), toolCalls: [] })
}

/** Runs one admitted invocation on a leased pool Worker. The scope acquires
 *  the log mirror, the nested batch, the lease, and the bridge in that order
 *  and releases them in reverse on every exit: the bridge detaches; the lease
 *  returns the Worker, which the pool resets for the next invocation only
 *  when the program returned on its own and otherwise terminates, so guest
 *  work stops; the batch aborts and joins every nested call and publishes
 *  missing terminals; and the logs flush once. The batch has this one close
 *  owner, so no exit path can settle before its join. */
export function runInvocation(invocation: CodeModeInvocation, context: ToolContext, owner: InvocationOwner): Effect.Effect<ToolResult> {
  const { limits } = owner
  return Effect.scoped(Effect.gen(function* () {
    const logs = yield* Effect.acquireRelease(Effect.sync(() => createLogMirror(context, limits)), (mirror) => Effect.sync(() => mirror.close()))
    const batch = yield* Effect.acquireRelease(Effect.sync(() => invocation.createBatch({
      tools: invocation.tools.callable,
      parentToolUseId: invocation.parentToolUseId,
      ...(context.modelRequestId ? { modelRequestId: context.modelRequestId } : {}),
      onNestedStart: logs.publish,
    })), (opened) => opened.close())
    // Retirement is the default: only an invocation that ends with a program
    // that returned on its own, and no interruption, hands its Worker back.
    let verdict: "reuse" | RetireReason = "failed"
    const leased = yield* Effect.exit(Effect.acquireRelease(
      Effect.try({ try: owner.workers.lease, catch: (cause) => cause }),
      (lease, exit) => Effect.promise(() => lease.release(Exit.isSuccess(exit) ? verdict : Exit.hasInterrupts(exit) ? "interrupted" : "failed")),
    ))
    if (Exit.isFailure(leased)) {
      return { outcome: "error", content: failure("ExecutionFailure", `Code runtime could not start: ${errorMessage(Cause.squash(leased.cause))}`, logs) }
    }
    const { worker } = leased.value
    // The first ending wins. Each records the calls still running as it
    // happens, before the abort that ends them can settle them.
    const finished = Promise.withResolvers<Ending>()
    const end = (ended: Ended): void => finished.resolve({ ended, running: batch.unsettled() })
    const bridge = yield* Effect.acquireRelease(
      Effect.sync(() => attachBridge(worker, context.signal, invocation.tools, batch, logs, limits, end)),
      (attached) => Effect.sync(() => attached.detach()),
    )
    const { maxToolCalls, maxLogBytes, maxHeapDeltaBytes, heapSampleMs } = limits
    const start: HostMessage = { type: "start", source: invocation.source, descriptors: invocation.tools.descriptors, limits: { maxToolCalls, maxLogBytes, maxHeapDeltaBytes, heapSampleMs } }
    // A descriptor schema that cannot be cloned fails this invocation only.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- boundary: Bun Worker.postMessage has no target origin
    const posted = yield* Effect.exit(Effect.try({ try: () => worker.postMessage(start), catch: (cause) => cause }))
    if (Exit.isFailure(posted)) end({ kind: "failed", message: `Code runtime could not start: ${errorMessage(Cause.squash(posted.cause))}` })
    // The one deadline starts once the program is handed over, so queued time
    // never counts and a Worker that never starts is still bounded.
    const { ended, running } = yield* Effect.promise(() => finished.promise).pipe(Effect.timeoutOrElse({
      duration: limits.timeoutMs,
      orElse: () => Effect.sync((): Ending => ({ ended: { kind: "timeout" }, running: batch.unsettled() })),
    }))
    verdict = verdictOf(ended)
    const ending = ended.kind === "result"
      ? ended.text
      : ended.kind === "timeout"
        ? failure("TimeoutExceeded", `Execution timed out after ${limits.timeoutMs}ms.`, logs)
        : failure("ExecutionFailure", ended.kind === "interrupted" ? "Execution was interrupted by the user." : ended.message, logs)
    // The scope release interrupts these calls, but a request may already
    // have reached its server, so every ending names them (ARCH-TOOLS-050).
    const text = running.length === 0
      ? ending
      : `${ending}\nCalls still running when the program ended, whose effects may have completed: ${running.join(", ")}. Check their effects before you run them again.`
    const images = bridge.images()
    return {
      outcome: ended.kind === "result" ? ended.outcome : ended.kind === "interrupted" ? "interrupted" : "error",
      content: images.length === 0 ? text : [{ type: "text", text }, ...images],
    } satisfies ToolResult
  }))
}
