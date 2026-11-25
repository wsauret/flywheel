import { Readable } from "node:stream"
import { createInterface } from "node:readline"
import { Cause, Deferred, Effect, Fiber, Queue, Semaphore, Stream } from "effect"
import { Log } from "../../../infra/diagnostics/log.js"
import { diagnosticDetail, errorMessage } from "../../../infra/diagnostics/error-message.js"
import type { AttachedRuntimeClient, RuntimeClient, RuntimeEventFrame } from "../../../protocol/runtime/app-service-types.js"
import type { ChatSettlementOutcome, ChatSettlementResult } from "../../../protocol/session/chat-settlement-protocol-types.js"
import { lostWithLane } from "../../../protocol/client/runtime/connection-failures.js"
import { createOpenSessionKeeper, type OpenSessionKeeper } from "../../../protocol/client/session/open-session-keeper.js"
import { RUNTIME_LIVENESS_POLICY } from "../../../protocol/runtime-liveness.js"
import { runtimeEventDelivery } from "../account/connections/runtime-event-delivery.js"
import type { AgentToolInput } from "../../agent-runtime/types.js"

const log = Log.create({ service: "headless-chat" })

/** The runtime as headless chat reaches it: the calls of a client of the
 *  published protocol, whose event lane can break and attach again. The
 *  channel owns no runtime and reads settlement only through the
 *  `chatSettlement` query, so the same channel speaks for a runtime this
 *  process hosts and for the resident account service. */
export type HeadlessChatClient = Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane" | "watchOutput">

/** The client of a runtime that this process hosts. Its one lane opens at
 *  once and lasts the whole run, and its subscribers receive the output of
 *  every session, so an output watch has nothing to start. */
export function inProcessHeadlessClient(client: RuntimeClient): HeadlessChatClient {
  return {
    query: client.query,
    dispatch: client.dispatch,
    subscribe: client.subscribe,
    onLane: (listener) => {
      listener(1)
      return () => {}
    },
    watchOutput: () => () => {},
  }
}

/** A chat whose owned work ended, as the `chatSettlement` query states it. */
type HeadlessChatSettlement = Exclude<ChatSettlementResult, { readonly state: "busy" }>

export interface ChatTransport {
  readonly input: AsyncIterable<string | Uint8Array> | Iterable<string | Uint8Array>
  readonly write: (line: string) => Promise<void>
  readonly progressWriter?: (line: string) => void
  readonly framing: HeadlessChatFraming
  /** The auth profile id that the attached chat runs on. The channel selects
   *  it for the chat once it attaches, and a refusal fails the attach. A
   *  runtime that this process hosts resolves its profile itself. */
  readonly authProfile?: string
  /** The one-shot invocation of an unattended run (PI-AGENT-121). The
   *  channel binds it to the chat it attaches, and returns once the first
   *  prompt that submits work and the work it owns settle, or once its turn
   *  stopped after a cancel: complete only with the invocation's sealed
   *  result, otherwise incomplete. */
  readonly completion?: {
    bind(sessionId: string): void
    result(): AgentToolInput | undefined
  }
}

/** What the channel gives the framing that speaks for it. */
export interface HeadlessChatChannel {
  readonly client: HeadlessChatClient
  /** Attaches the channel's root chat once: the saved chat of this project
   *  that `sessionId` names, or a new chat. It selects the transport's auth
   *  profile for the chat, then holds the chat as a client that shows it: it
   *  activates the chat on this lane and on every later one, which starts no
   *  work (ARCH-SESSIONS-038). Resolves with the chat's id, or undefined when
   *  `sessionId` names no chat of this project. Rejects when the open or the
   *  profile selection fails, or when a chat is already attached. */
  attach(sessionId?: string): Promise<string | undefined>
  /** Stops holding the attached chat, which stays saved, so the runtime can
   *  end its runner once no client shows it. */
  release(): void
  /** Writes one framed line after every earlier write. A failed write fails
   *  the channel and rejects. */
  write(line: string): Promise<void>
  /** Resolves when no input line is dispatching and the runtime answers that
   *  the work the root owns has ended, after the root's totals state every
   *  usage that work recorded. While `turnOnly` says so, as after a cancel,
   *  it waits only until the root's own turn stopped, and the work that the
   *  turn launched keeps running. This is the channel's one settlement rule;
   *  any number of callers can wait on it at once. A read lost with its lane
   *  is read again on the next lane. Rejects when the channel failed or the
   *  runtime could not answer. */
  settle(turnOnly?: () => boolean): Promise<HeadlessChatSettlement>
  /** Keeps the channel from returning until `work` settles. A rejection fails
   *  the channel. */
  hold(work: Promise<void>): void
}

/** The attached framing: it turns delivered runtime frames and input lines
 *  into output lines. `request` answers a malformed line with its own error
 *  lines, and says whether the line submitted work. */
interface HeadlessChatCodec {
  frame(frame: RuntimeEventFrame): readonly string[]
  request(line: string): Promise<{ readonly lines: readonly string[]; readonly submitted: boolean }>
  /** Whether the client cancelled the prompt that submitted work last, which
   *  stops a one-shot run once that prompt's turn stopped. */
  cancelled?(): boolean
  /** Hears that input ended, so nothing can answer what the framing asked the client. */
  inputEnded?(): void
}

/** The wire framing of headless chat, Agent Client Protocol version 1
 *  (acp-chat.ts). `open` attaches it before any frame or input line reaches
 *  it, and the framing chooses when to attach the root chat. The channel's
 *  host calls `close` after it let go of the runtime. */
export interface HeadlessChatFraming {
  open(channel: HeadlessChatChannel): Promise<HeadlessChatCodec>
  close(): void
}

/** Processes ordered input lines while the ordinary runner works in the
 * background. Uses current protocol reads for settlement, never a second
 * question/session projection. Its subscriber lives until all writes settle.
 * Resolves with the outcome of the work the attached chat owns once input
 * ended, or, for a one-shot run, once its first submitted prompt settled.
 */
export async function runHeadlessChatChannel(client: HeadlessChatClient, transport: ChatTransport): Promise<ChatSettlementOutcome> {
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
  const { framing, completion } = transport
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
      runtimeEventDelivery(client, log, RUNTIME_LIVENESS_POLICY, () => subscribed.resolve(), { drain: Deferred.await(drain) }),
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
        // The runtime wakes every client that waits on a chat with a
        // content-free patch, and a new lane can follow a change that no
        // patch reached this client for, so each one reads settlement again.
        const unsubscribeWakes = client.subscribe((event) => {
          if (event.type === "patch" && event.patch.payload.kind === "settlement.changed") changed()
        })
        const stopLanes = client.onLane(changed)
        const source = transport.input instanceof Readable ? transport.input : Readable.from(transport.input)
        const held = new Set<Promise<void>>()
        let keeper: OpenSessionKeeper | undefined
        try {
          let attachedSessionId: string | undefined
          const attach = async (requested?: string): Promise<string | undefined> => {
            if (attachedSessionId !== undefined) throw new Error(`The channel already attached chat ${attachedSessionId}`)
            let sessionId = requested
            if (sessionId) {
              const detail = await client.query({ type: "sessionDetail", sessionId })
              if (detail.view?.kind !== "chat") return undefined
            } else {
              const opened = await client.dispatch({ type: "chat.open" })
              if (!opened.ok || !opened.sessionId) throw new Error(opened.ok ? "Chat open returned no session id" : opened.error)
              sessionId = opened.sessionId
            }
            if (transport.authProfile !== undefined) {
              const selected = await client.dispatch({ type: "auth.profile.select", scope: { kind: "session", sessionId }, id: transport.authProfile })
              if ("ok" in selected && !selected.ok) throw new Error(selected.error)
            }
            completion?.bind(sessionId)
            keeper = createOpenSessionKeeper({ client, onDiagnostic: (message, detail) => log.warn(message, { detail: diagnosticDetail(detail) }) })
            keeper.open(sessionId)
            attachedSessionId = sessionId
            return sessionId
          }
          let dispatching = false
          const settle = async (turnOnly: () => boolean = () => false): Promise<HeadlessChatSettlement> => {
            while (true) {
              const observed = revision
              // A channel whose framing attached no chat owns no work.
              const sessionId = attachedSessionId
              let settlement: ChatSettlementResult | undefined
              try {
                settlement = sessionId === undefined ? { state: "complete" }
                  : await client.query({ type: "chatSettlement", sessionId, ...(turnOnly() ? { scope: "turn" as const } : {}) })
              } catch (error) {
                if (!lostWithLane(error)) throw new Error(`The chat's settlement could not be read: ${errorMessage(error)}`, { cause: error })
              }
              if (outputFailure !== undefined) throw new Error(errorMessage(outputFailure))
              if (inputFailure !== undefined) throw new Error(errorMessage(inputFailure))
              if (observed !== revision) continue
              if (!dispatching && settlement !== undefined && settlement.state !== "busy") return settlement
              await new Promise<void>((resolve) => { waiters.add(resolve) })
            }
          }
          const codec = await framing.open({
            client,
            attach,
            release: () => {
              if (attachedSessionId !== undefined) keeper?.close(attachedSessionId)
            },
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
            } finally {
              codec.inputEnded?.()
              submitted.resolve()
              changed()
            }
          }
          reading = readInput()
          void reading.catch((error: unknown) => { inputFailure = new Error(errorMessage(error)); changed() })
          if (completion) await Promise.race([submitted.promise, reading])
          else await reading
          // A cancel means stop: a one-shot run then ends with its turn.
          const settled = (await settle(() => completion !== undefined && codec.cancelled?.() === true)).state
          const outcome = completion && settled === "complete" && !completion.result() ? "incomplete" : settled
          ending = true
          input.close()
          await reading
          await Promise.all(held)
          return outcome
        } finally {
          input?.close()
          if (source !== transport.input) source.destroy()
          try { await reading } finally {
            await Promise.all(held)
            keeper?.dispose()
            stopLanes()
            unsubscribeWakes()
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
