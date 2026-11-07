import { Readable } from "node:stream"
import { createInterface } from "node:readline"
import { Cause, Deferred, Effect, Fiber, Queue, Schema, Semaphore, Stream } from "effect"
import { Log } from "../../infra/log.js"
import { errorMessage } from "../../infra/error-message.js"
import type { FrontendMutation, RuntimeClient, RuntimeEventFrame } from "../../protocol/app-service-types.js"
import { HeadlessChatRecordSchema, HeadlessChatRequestSchema, type HeadlessChatOutcome, type HeadlessChatRecord } from "../../protocol/headless-chat.js"
import { RUNTIME_LIVENESS_POLICY } from "../../protocol/runtime-liveness.js"
import { runtimeEventDelivery } from "../app-service/runtime-event-delivery.js"
import { assembleProjectRuntime, type RuntimeComposition, type RuntimeCompositionOptions } from "../app-service/project-execution-runtime.js"
import { createRuntimeChatKernel } from "../app-service/runtime-chat-kernel.js"
import { claimHeadlessProjectExecution } from "../app-service/project-serving-lane.js"
import type { AgentToolInput } from "../agent-runtime/types.js"
import { createChatInvocationCompletion } from "../chat/runner-completion.js"

interface ChatTransport {
  readonly input: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>
  readonly write: (line: string) => Promise<void>
  readonly progressWriter?: (line: string) => void
  readonly sessionId?: string
  readonly oneShot?: boolean
  /** The wire framing; the versioned JSONL channel when absent. */
  readonly framing?: HeadlessChatFraming
  readonly completion?: {
    readonly invocation: ReturnType<typeof createChatInvocationCompletion>
    bind(sessionId: string): void
    result(): AgentToolInput | undefined
  }
}

interface ChatChannelRuntime {
  readonly client: RuntimeClient
  readonly workSettlement: RuntimeComposition["workSettlement"]
  readonly startChatDefault: RuntimeComposition["startChatDefault"]
}

interface HeadlessChatResult {
  readonly sessionId: string | null
  readonly outcome: HeadlessChatOutcome
  readonly handoff?: AgentToolInput
}

/** What the channel gives the framing that speaks for it. */
export interface HeadlessChatChannel {
  readonly client: RuntimeClient
  /** The attached root chat. */
  readonly sessionId: string
  /** Writes one framed line after every earlier write. A failed write fails
   *  the channel and rejects. */
  write(line: string): Promise<void>
  /** Resolves when no input line is dispatching and the work the root owns is
   *  no longer busy. This is the channel's one settlement rule; any number of
   *  callers can wait on it at once. */
  settle(): Promise<HeadlessChatOutcome>
  /** Keeps the channel from returning until `work` settles. A rejection fails
   *  the channel. */
  hold(work: Promise<void>): void
}

/** One attached framing: it turns delivered runtime frames and input lines
 *  into output lines. `request` answers a malformed line with its own error
 *  lines, and says whether the line submitted work. */
export interface HeadlessChatCodec {
  frame(frame: RuntimeEventFrame): readonly string[]
  request(line: string): Promise<{ readonly lines: readonly string[]; readonly submitted: boolean }>
}

/** A wire framing of headless chat: the versioned JSONL channel or Agent
 *  Client Protocol version 1. `open` attaches it once the root chat is active,
 *  before any frame or input line reaches it. `final` is the line written
 *  after runtime disposal, if the framing has one. */
export interface HeadlessChatFraming {
  open(channel: HeadlessChatChannel): Promise<HeadlessChatCodec>
  final(result: HeadlessChatResult): string | undefined
}

/** Hosts the full production Chat runtime locally, without a public listener.
 * Owns runtime disposal, not the launcher's or persistent process manager's
 * lifetime. The CLI releases those after this function has flushed output.
 * Returns 0 for a drained conversation, 1 for failure, and 2 for a conversation
 * that needs more input. The JSONL contract is in protocol/headless-chat.ts;
 * the ACP framing is in acp-chat.ts.
 */
export async function runHeadlessChat(options: RuntimeCompositionOptions & ChatTransport): Promise<number> {
  let runtime: RuntimeComposition | undefined
  let releaseExecution: (() => void) | undefined
  let sessionId: string | null = null
  let outcome: HeadlessChatOutcome = "failed"
  let handoff: AgentToolInput | undefined
  let root: string | undefined
  const completion = options.oneShot ? {
    invocation: createChatInvocationCompletion((content) => { handoff = content }),
    bind: (id: string) => { root = id },
    result: () => handoff,
  } : undefined
  try {
    releaseExecution = await claimHeadlessProjectExecution(options.projectRoot)
    runtime = await assembleProjectRuntime({
      ...options,
      ...(completion ? { rootChatCompletion: (id: string) => id === root ? completion.invocation : undefined } : {}),
    }, (scope, lane) => createRuntimeChatKernel(options, scope, lane))
    const result = await runHeadlessChatChannel(runtime, { ...options, completion })
    sessionId = result.sessionId
    outcome = result.outcome
  } catch (error) {
    options.progressWriter?.(`Headless chat failed: ${errorMessage(error)}`)
  } finally {
    if (runtime) {
      try {
        const disposed = await runtime.dispose({ clientsHold: true })
        if (disposed.kind === "blocked") {
          outcome = "failed"
          options.progressWriter?.(`Headless chat shutdown blocked in ${disposed.phase}`)
        } else {
          releaseExecution?.()
        }
      } catch (error) {
        outcome = "failed"
        options.progressWriter?.(`Headless chat shutdown failed: ${errorMessage(error)}`)
      }
    }
    // Failed assembly reports rollback errors only to its logger. It proves
    // no settlement here, so its claim stays until this CLI process exits.
  }
  const final = (options.framing ?? jsonlFraming()).final({ sessionId, outcome, ...(handoff ? { handoff } : {}) })
  if (final !== undefined) await options.write(final)
  return outcome === "complete" ? 0 : outcome === "failed" ? 1 : 2
}

/** Processes ordered input lines while the ordinary runner works in the
 * background. Uses current protocol reads for settlement, never a second
 * question/session projection. Its subscriber lives until all writes settle.
 * The hosting function emits the framing's final line after resource disposal.
 */
export async function runHeadlessChatChannel(runtime: ChatChannelRuntime, transport: ChatTransport): Promise<HeadlessChatResult & { readonly sessionId: string }> {
  let outputFailure: Error | undefined
  let inputFailure: Error | undefined
  let input: ReturnType<typeof createInterface> | undefined
  let reading: Promise<void> | undefined
  let revision = 0
  const waiters = new Set<() => void>()
  const changed = () => {
    revision++
    for (const wake of waiters) wake()
    waiters.clear()
  }
  const failed = (cause: Cause.Cause<unknown>) => {
    outputFailure ??= new Error(errorMessage(Cause.squash(cause)))
    input?.close()
    changed()
  }
  const framing = transport.framing ?? jsonlFraming(transport.completion?.invocation)
  return Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const writer = yield* Semaphore.make(1)
    const write = (line: string) => writer.withPermit(Effect.tryPromise({
      try: () => transport.write(line),
      catch: (error) => new Error(errorMessage(error)),
    }))
    // One completed command may wait behind the writer. Admission then pauses
    // stdin, not the event consumer, so the first Interrupt can still dispatch.
    const responses = yield* Effect.acquireRelease(Queue.bounded<string | null>(1), (queue) => Queue.shutdown(queue))
    const emit = (line: string) => Effect.runPromise(Queue.offer(responses, line))
    const failOutput = (cause: Cause.Cause<unknown>) => Effect.sync(() => failed(cause)).pipe(Effect.andThen(Queue.shutdown(responses)))
    const drain = yield* Deferred.make<void>()
    const ready = yield* Deferred.make<HeadlessChatCodec>()
    const subscribed = Promise.withResolvers<void>()
    const eventFiber = yield* Stream.runForEach(
      runtimeEventDelivery(runtime.client, Log.create({ service: "headless-chat" }), RUNTIME_LIVENESS_POLICY, () => subscribed.resolve(), { drain: Deferred.await(drain) }),
      (event) => Deferred.await(ready).pipe(Effect.flatMap((codec) => Effect.forEach(codec.frame(event), write, { discard: true }))),
    ).pipe(Effect.catchCause(failOutput), Effect.forkScoped)
    const responseFiber = yield* Stream.fromQueue(responses).pipe(
      Stream.takeWhile((line): line is string => line !== null),
      Stream.runForEach(write),
      Effect.catchCause(failOutput),
      Effect.forkScoped,
    )
    yield* Effect.tryPromise({ try: () => subscribed.promise, catch: (error) => new Error(errorMessage(error)) })
    const channelResult = yield* Effect.tryPromise({
      try: async () => {
        const unsubscribeWork = runtime.workSettlement.onChange(changed)
        runtime.startChatDefault()
        const source = transport.input instanceof Readable ? transport.input : Readable.from(transport.input)
        const held = new Set<Promise<void>>()
        try {
          let sessionId = transport.sessionId
          if (sessionId) {
            const detail = await runtime.client.query({ type: "sessionDetail", sessionId })
            if (detail.view?.kind !== "chat") throw new Error(`Chat session not found: ${sessionId}`)
          } else {
            const opened = await runtime.client.dispatch({ type: "chat.open" })
            if (!opened.ok || !opened.sessionId) throw new Error(opened.ok ? "Chat open returned no session id" : opened.error)
            sessionId = opened.sessionId
          }
          transport.completion?.bind(sessionId)
          const activated = await runtime.client.dispatch({ type: "session.activate", sessionId })
          if (!activated.ok) throw new Error(activated.error)
          const attachedSessionId = sessionId
          let dispatching = false
          const settle = async (): Promise<HeadlessChatOutcome> => {
            while (true) {
              const observed = revision
              const state = await runtime.workSettlement.read(attachedSessionId)
              if (outputFailure !== undefined) throw new Error(errorMessage(outputFailure))
              if (inputFailure !== undefined) throw new Error(errorMessage(inputFailure))
              if (observed !== revision) continue
              if (!dispatching && state !== "busy") return state
              await new Promise<void>((resolve) => { waiters.add(resolve) })
            }
          }
          const codec = await framing.open({
            client: runtime.client,
            sessionId: attachedSessionId,
            write: (line) => Effect.runPromise(write(line).pipe(Effect.tapCause(failOutput))),
            settle,
            hold: (work) => {
              const owned = work.catch((error: unknown) => { outputFailure ??= new Error(errorMessage(error)); input?.close(); changed() })
                .finally(() => { held.delete(owned) })
              held.add(owned)
            },
          })
          await Effect.runPromise(Deferred.succeed(ready, codec))
          input = createInterface({ input: source, crlfDelay: Infinity })
          const submitted = Promise.withResolvers<void>()
          let ending = false
          const readInput = async (): Promise<void> => {
            if (!input) throw new Error("Headless input is unavailable")
            try {
              for await (const line of input) {
                if (ending) break
                if (!line.trim()) continue
                dispatching = true
                changed()
                try {
                  const answered = await codec.request(line)
                  for (const response of answered.lines) await emit(response)
                  if (answered.submitted) submitted.resolve()
                } finally {
                  dispatching = false
                  changed()
                }
                if (outputFailure !== undefined) throw new Error(errorMessage(outputFailure))
              }
            } finally { submitted.resolve(); changed() }
          }
          reading = readInput()
          void reading.catch((error: unknown) => { inputFailure = new Error(errorMessage(error)); changed() })
          if (transport.oneShot) await Promise.race([submitted.promise, reading])
          else await reading
          const settled = await settle()
          const handoff = transport.completion?.result()
          const outcome = transport.oneShot && settled === "complete" && !handoff ? "incomplete" : settled
          ending = true
          input.close()
          await reading
          await Promise.all(held)
          return { sessionId, outcome, ...(outcome === "complete" && handoff ? { handoff } : {}) }
        } finally {
          input?.close()
          if (source !== transport.input) source.destroy()
          try { await reading } finally {
            await Promise.all(held)
            unsubscribeWork()
          }
        }
      },
      catch: (error) => outputFailure ?? new Error(errorMessage(error)),
    })
    yield* Deferred.succeed(drain, undefined)
    yield* Fiber.join(eventFiber)
    yield* Queue.offer(responses, null)
    yield* Fiber.join(responseFiber)
    if (outputFailure) return yield* Effect.fail(outputFailure)
    return channelResult
  })))
}

/** The versioned JSONL channel of protocol/headless-chat.ts. A
 *  work-submitting dispatch first takes the one-shot invocation's admission,
 *  so a completed one-shot run refuses more work. */
function jsonlFraming(completion?: ReturnType<typeof createChatInvocationCompletion>): HeadlessChatFraming {
  return {
    open: async (channel) => {
      await channel.write(encodeRecord({ version: 1, type: "ready", sessionId: channel.sessionId }))
      return {
        frame: (event) => [encodeRecord({ version: 1, type: "event", event })],
        request: async (line) => {
          let id: string | null = null
          try {
            let raw: unknown
            try { raw = JSON.parse(line) } catch { throw new Error("Invalid headless chat JSON") }
            if (typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "string") id = raw.id
            const decoded = Schema.decodeUnknownOption(HeadlessChatRequestSchema, { onExcessProperty: "error" })(raw)
            if (decoded._tag === "None") throw new Error("Invalid headless chat request")
            const request = decoded.value
            const submitted = request.type === "dispatch" && submitsWork(request.command)
            const releaseAdmission = submitted ? completion?.admitInput() : undefined
            if (submitted && completion && !releaseAdmission) throw new Error("The one-shot Chat invocation has already completed")
            let result
            try {
              result = request.type === "dispatch"
                ? await channel.client.dispatch(request.command)
                : await channel.client.query(request.query)
            } finally { releaseAdmission?.() }
            return { lines: [encodeRecord({ version: 1, type: "result", id: request.id, result: result ?? null })], submitted }
          } catch (error) {
            return { lines: [encodeRecord({ version: 1, type: "error", id, error: errorMessage(error) })], submitted: false }
          }
        },
      }
    },
    final: ({ sessionId, outcome, handoff }) => encodeRecord({ version: 1, type: "outcome", sessionId, outcome, ...(outcome === "complete" && handoff ? { handoff } : {}) }),
  }
}

const encodeRecord = (record: HeadlessChatRecord): string =>
  `${JSON.stringify(Schema.encodeSync(HeadlessChatRecordSchema)(record))}\n`

function submitsWork(command: FrontendMutation): boolean {
  return command.type === "session.send" || command.type === "chat.resume"
    || command.type === "chat.open" && command.initialMessage !== undefined
    || command.type === "workflow.resume" || command.type === "workflow.restart"
    || command.type === "question.answer" || command.type === "question.cancel"
    || command.type === "chat.compact" || command.type === "subagent.resume"
}

