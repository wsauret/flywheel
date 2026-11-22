import { Readable } from "node:stream"
import { createInterface } from "node:readline"
import { Cause, Deferred, Effect, Fiber, Queue, Schema, Semaphore, Stream } from "effect"
import { Log } from "../../infra/log.js"
import { diagnosticDetail, errorMessage } from "../../infra/error-message.js"
import type { AttachedRuntimeClient, FrontendMutation, RuntimeClient, RuntimeEventFrame } from "../../protocol/app-service-types.js"
import type { ChatSettlementResult } from "../../protocol/chat-settlement-protocol-types.js"
import { lostWithLane } from "../../protocol/client/connection-failures.js"
import { createOpenSessionKeeper, type OpenSessionKeeper } from "../../protocol/client/open-session-keeper.js"
import { HeadlessChatRecordSchema, HeadlessChatRequestSchema, type HeadlessChatOutcome, type HeadlessChatRecord } from "../../protocol/headless-chat.js"
import { RUNTIME_LIVENESS_POLICY } from "../../protocol/runtime-liveness.js"
import { runtimeEventDelivery } from "../app-service/runtime-event-delivery.js"
import type { AgentToolInput } from "../agent-runtime/types.js"
import type { createChatInvocationCompletion } from "../chat/runner-completion.js"

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
  readonly sessionId?: string
  readonly oneShot?: boolean
  /** No person reads the conversation (PI-AGENT-121), so the run is one-shot: its first answered turn ends it. */
  readonly unattended?: boolean
  /** The wire framing; the versioned JSONL channel when absent. */
  readonly framing?: HeadlessChatFraming
  /** The auth profile id that the attached chat runs on. The channel selects
   *  it for the chat once it attaches, and a refusal fails the attach. A
   *  runtime that this process hosts resolves its profile itself. */
  readonly authProfile?: string
  readonly completion?: {
    readonly invocation: ReturnType<typeof createChatInvocationCompletion>
    bind(sessionId: string): void
    result(): AgentToolInput | undefined
  }
}

interface HeadlessChatResult {
  readonly sessionId: string | null
  readonly outcome: HeadlessChatOutcome
  readonly handoff?: AgentToolInput
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
   *  usage that work recorded. This is the channel's one settlement rule; any
   *  number of callers can wait on it at once. A read lost with its lane is
   *  read again on the next lane. Rejects when the channel failed or the
   *  runtime could not answer. */
  settle(): Promise<HeadlessChatSettlement>
  /** Keeps the channel from returning until `work` settles. A rejection fails
   *  the channel. */
  hold(work: Promise<void>): void
}

/** One attached framing: it turns delivered runtime frames and input lines
 *  into output lines. `request` answers a malformed line with its own error
 *  lines, and says whether the line submitted work. */
interface HeadlessChatCodec {
  frame(frame: RuntimeEventFrame): readonly string[]
  request(line: string): Promise<{ readonly lines: readonly string[]; readonly submitted: boolean }>
  /** Hears that input ended, so nothing can answer what the framing asked the client. */
  inputEnded?(): void
}

/** A wire framing of headless chat: the versioned JSONL channel or Agent
 *  Client Protocol version 1. `open` attaches it before any frame or input
 *  line reaches it, and the framing chooses when to attach the root chat.
 *  `final` is the line written after the channel's host let go of the
 *  runtime, if the framing has one. */
export interface HeadlessChatFraming {
  open(channel: HeadlessChatChannel): Promise<HeadlessChatCodec>
  final(result: HeadlessChatResult): string | undefined
}

/** Processes ordered input lines while the ordinary runner works in the
 * background. Uses current protocol reads for settlement, never a second
 * question/session projection. Its subscriber lives until all writes settle.
 * The hosting function emits the framing's final line after it let go of the
 * runtime.
 */
export async function runHeadlessChatChannel(client: HeadlessChatClient, transport: ChatTransport): Promise<HeadlessChatResult> {
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
  const framing = transport.framing ?? jsonlFraming(transport.completion?.invocation, transport.sessionId)
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
            transport.completion?.bind(sessionId)
            keeper = createOpenSessionKeeper({ client, onDiagnostic: (message, detail) => log.warn(message, { detail: diagnosticDetail(detail) }) })
            keeper.open(sessionId)
            attachedSessionId = sessionId
            return sessionId
          }
          let dispatching = false
          const settle = async (): Promise<HeadlessChatSettlement> => {
            while (true) {
              const observed = revision
              // A channel whose framing attached no chat owns no work.
              const sessionId = attachedSessionId
              let settlement: ChatSettlementResult | undefined
              try {
                settlement = sessionId === undefined ? { state: "complete" } : await client.query({ type: "chatSettlement", sessionId })
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
          if (transport.oneShot) await Promise.race([submitted.promise, reading])
          else await reading
          const settled = (await settle()).state
          const handoff = transport.completion?.result()
          const outcome = transport.oneShot && settled === "complete" && !handoff ? "incomplete" : settled
          ending = true
          input.close()
          await reading
          await Promise.all(held)
          return { sessionId: attachedSessionId ?? null, outcome, ...(outcome === "complete" && handoff ? { handoff } : {}) }
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

/** The versioned JSONL channel of protocol/headless-chat.ts. A
 *  work-submitting dispatch first takes the one-shot invocation's admission,
 *  so a completed one-shot run refuses more work. */
export function jsonlFraming(completion?: ReturnType<typeof createChatInvocationCompletion>, savedSessionId?: string): HeadlessChatFraming {
  return {
    open: async (channel) => {
      const attached = await channel.attach(savedSessionId)
      if (attached === undefined) throw new Error(`Chat session not found: ${savedSessionId}`)
      await channel.write(encodeRecord({ version: 1, type: "ready", sessionId: attached }))
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

