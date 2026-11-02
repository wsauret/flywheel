import { Readable } from "node:stream"
import { createInterface } from "node:readline"
import { Cause, Deferred, Effect, Fiber, Queue, Schema, Semaphore, Stream } from "effect"
import { Log } from "../../infra/log.js"
import { errorMessage } from "../../infra/error-message.js"
import type { FrontendMutation, RuntimeClient } from "../../protocol/app-service-types.js"
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

/** Hosts the full production Chat runtime locally, without a public listener.
 * Owns runtime disposal, not the launcher's or persistent process manager's
 * lifetime. The CLI releases those after this function has flushed output.
 * Returns 0 for a drained conversation, 1 for failure, and 2 for a conversation
 * that needs more input. The JSONL contract is in protocol/headless-chat.ts.
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
  await options.write(encodeRecord({ version: 1, type: "outcome", sessionId, outcome, ...(outcome === "complete" && handoff ? { handoff } : {}) }))
  return outcome === "complete" ? 0 : outcome === "failed" ? 1 : 2
}

/** Processes ordered person commands while the ordinary runner works in the
 * background. Uses current protocol reads for EOF settlement, never a second
 * question/session projection. Its subscriber lives until all writes settle.
 * The hosting function emits the final outcome after resource disposal.
 */
export async function runHeadlessChatChannel(runtime: ChatChannelRuntime, transport: ChatTransport): Promise<{ sessionId: string; outcome: HeadlessChatOutcome; handoff?: AgentToolInput }> {
  let outputFailure: Error | undefined
  let inputFailure: Error | undefined
  let input: ReturnType<typeof createInterface> | undefined
  let reading: Promise<void> | undefined
  let revision = 0
  let wake: (() => void) | undefined
  const failed = (cause: Cause.Cause<unknown>) => {
    outputFailure ??= new Error(errorMessage(Cause.squash(cause)))
    input?.close()
    wake?.()
  }
  return Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const writer = yield* Semaphore.make(1)
    const write = (record: HeadlessChatRecord) => writer.withPermit(Effect.tryPromise({
      try: () => transport.write(encodeRecord(record)),
      catch: (error) => new Error(errorMessage(error)),
    }))
    // One completed command may wait behind the writer. Admission then pauses
    // stdin, not the event consumer, so the first Interrupt can still dispatch.
    const responses = yield* Effect.acquireRelease(Queue.bounded<HeadlessChatRecord | null>(1), (queue) => Queue.shutdown(queue))
    const emit = (record: HeadlessChatRecord) => Effect.runPromise(Queue.offer(responses, record))
    const failOutput = (cause: Cause.Cause<unknown>) => Effect.sync(() => failed(cause)).pipe(Effect.andThen(Queue.shutdown(responses)))
    const drain = yield* Deferred.make<void>()
    const ready = yield* Deferred.make<void>()
    const subscribed = Promise.withResolvers<void>()
    const eventFiber = yield* Stream.runForEach(
      runtimeEventDelivery(runtime.client, Log.create({ service: "headless-chat" }), RUNTIME_LIVENESS_POLICY, () => subscribed.resolve(), { drain: Deferred.await(drain) }),
      (event) => Deferred.await(ready).pipe(Effect.andThen(write({ version: 1, type: "event", event }))),
    ).pipe(Effect.catchCause(failOutput), Effect.forkScoped)
    const responseFiber = yield* Stream.fromQueue(responses).pipe(
      Stream.takeWhile((record): record is HeadlessChatRecord => record !== null),
      Stream.runForEach((record) => write(record)),
      Effect.catchCause(failOutput),
      Effect.forkScoped,
    )
    yield* Effect.tryPromise({ try: () => subscribed.promise, catch: (error) => new Error(errorMessage(error)) })
    const channelResult = yield* Effect.tryPromise({
      try: async () => {
        const unsubscribeWork = runtime.workSettlement.onChange(() => {
          revision++
          wake?.()
        })
        runtime.startChatDefault()
        const source = transport.input instanceof Readable ? transport.input : Readable.from(transport.input)
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
          await Effect.runPromise(write({ version: 1, type: "ready", sessionId }))
          await Effect.runPromise(Deferred.succeed(ready, undefined))
          input = createInterface({ input: source, crlfDelay: Infinity })
          const attachedSessionId = sessionId
          const submitted = Promise.withResolvers<void>()
          let ending = false
          let dispatching = false
          const readInput = async (): Promise<void> => {
            if (!input) throw new Error("Headless input is unavailable")
            try {
              for await (const line of input) {
                if (ending) break
                if (!line.trim()) continue
                let id: string | null = null
                dispatching = true
                revision++
                try {
                  let raw: unknown
                  try { raw = JSON.parse(line) } catch { throw new Error("Invalid headless chat JSON") }
                  if (typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "string") id = raw.id
                  const decoded = Schema.decodeUnknownOption(HeadlessChatRequestSchema)(raw)
                  if (decoded._tag === "None") throw new Error("Invalid headless chat request")
                  const request = decoded.value
                  const completion = request.type === "dispatch" && submitsWork(request.command) ? transport.completion?.invocation : undefined
                  const releaseAdmission = completion?.admitInput()
                  if (completion && !releaseAdmission) throw new Error("The one-shot Chat invocation has already completed")
                  let result
                  try {
                    result = request.type === "dispatch"
                      ? await runtime.client.dispatch(request.command)
                      : await runtime.client.query(request.query)
                  } finally { releaseAdmission?.() }
                  await emit({ version: 1, type: "result", id: request.id, result: result ?? null })
                  if (request.type === "dispatch" && submitsWork(request.command)) submitted.resolve()
                } catch (error) {
                  await emit({ version: 1, type: "error", id, error: errorMessage(error) })
                } finally {
                  dispatching = false
                  revision++
                  wake?.()
                }
                if (outputFailure !== undefined) throw new Error(errorMessage(outputFailure))
              }
            } finally { submitted.resolve(); revision++; wake?.() }
          }
          const waitForChange = () => new Promise<void>((resolve) => { wake = resolve })
          const settle = async (): Promise<HeadlessChatOutcome> => {
            while (true) {
              const observed = revision
              const state = await runtime.workSettlement.read(attachedSessionId)
              if (outputFailure !== undefined) throw new Error(errorMessage(outputFailure))
              if (inputFailure !== undefined) throw new Error(errorMessage(inputFailure))
              if (observed !== revision) continue
              if (!dispatching && state !== "busy") return state
              await waitForChange()
              wake = undefined
            }
          }
          reading = readInput()
          void reading.catch((error: unknown) => { inputFailure = new Error(errorMessage(error)); wake?.() })
          // Only one settlement reader owns the wake continuation. EOF and the
          // one-shot submission trigger join that reader rather than racing two.
          if (transport.oneShot) await Promise.race([submitted.promise, reading])
          else await reading
          const settled = await settle()
          const handoff = transport.completion?.result()
          const outcome = transport.oneShot && settled === "complete" && !handoff ? "incomplete" : settled
          ending = true
          input.close()
          await reading
          return { sessionId, outcome, ...(outcome === "complete" && handoff ? { handoff } : {}) }
        } finally {
          input?.close()
          if (source !== transport.input) source.destroy()
          try { await reading } finally { unsubscribeWork() }
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

const encodeRecord = (record: HeadlessChatRecord): string =>
  `${JSON.stringify(Schema.encodeSync(HeadlessChatRecordSchema)(record))}\n`

function submitsWork(command: FrontendMutation): boolean {
  return command.type === "session.send" || command.type === "chat.resume"
    || command.type === "chat.open" && command.initialMessage !== undefined
    || command.type === "workflow.resume" || command.type === "workflow.restart"
    || command.type === "question.answer" || command.type === "question.cancel"
    || command.type === "chat.compact" || command.type === "subagent.resume"
}

