import { randomUUID } from "node:crypto"
import { Effect, Fiber } from "effect"
import type { SideQuestionExchange, SideQuestionRequest, SideQuestionView } from "../../../protocol/modules/side-question.js"
import type { ChatModuleHost } from "../../chat-module-host.js"
import { moduleRuntimeHandle } from "../../../infra/module-runtime.js"
import { Log } from "../../../infra/log.js"
import { bridgeExternalPromise } from "../../agent-runtime/external-promise-bridge.js"
import { failureTerminal, type AgentRunResult } from "../../agent-runtime/types.js"
import { formatAgentFailure } from "../../agent-runtime/runner/failure-message.js"
import type { ConversationMessage } from "../../agent-runtime/llm/types.js"
import { sideQuestionReminder, sideQuestionSource } from "./context.js"

export interface SideQuestionRun {
  readonly id: string
  readonly messages: readonly ConversationMessage[]
  readonly signal: AbortSignal
  /** The whole answer so far, when it changed other than by growing. */
  readonly onAnswer: (answer: string) => void
  /** Text that the answer gained at its end. */
  readonly onAppend: (text: string) => void
}

/** One change a host publishes: its control state (revision, history, and
 *  request), null once the host is retired; the request alone; or text that
 *  the running answer gained. */
export type SideQuestionHostChange =
  | { readonly kind: "control"; readonly view: SideQuestionView | null }
  | { readonly kind: "request"; readonly current: SideQuestionRequest | null }
  | { readonly kind: "appended"; readonly text: string }

interface SideQuestionHostDeps {
  readonly signal: AbortSignal
  readonly capture: () => Promise<readonly ConversationMessage[]>
  readonly run: (request: SideQuestionRun) => Promise<AgentRunResult>
}

export interface SideQuestionHost extends ChatModuleHost {
  snapshot(): SideQuestionView
  subscribe(listener: (change: SideQuestionHostChange) => void): () => void
  ask(question: string): Promise<string>
  stop(requestId: string): Promise<boolean>
  clear(revision: number): Promise<boolean>
  promotion(exchangeId: string): ConversationMessage[] | undefined
  settled(): Promise<void>
}

export const sideQuestionHost = moduleRuntimeHandle<SideQuestionHost>("side-question")
const log = Log.create({ service: "side-question" })

function exchangesAsMessages(exchanges: readonly SideQuestionExchange[]): ConversationMessage[] {
  return exchanges.flatMap((exchange): ConversationMessage[] => [
    { kind: "user", origin: "human", content: exchange.question }, { kind: "assistant", content: exchange.answer },
  ])
}

/** One attached chat owns the history, serialized mutations, and independently cancellable request fiber. */
export function createSideQuestionHost(deps: SideQuestionHostDeps): SideQuestionHost {
  const history: Array<SideQuestionExchange & { source: readonly ConversationMessage[]; prefix: readonly ConversationMessage[] }> = []
  const listeners = new Set<(change: SideQuestionHostChange) => void>()
  let current: SideQuestionRequest | null = null
  let revision = 0
  let disposed = false
  let disposal: Promise<void> | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let active: { id: string; stop: () => void; done: Promise<void> } | undefined
  const snapshot = (): SideQuestionView => ({
    revision,
    exchanges: history.map(({ id, question, answer }) => ({ id, question, answer })),
    current: current ? { ...current } : null,
  })
  function publish(change: SideQuestionHostChange): void {
    for (const listener of listeners) listener(change)
  }
  function publishControl(retired = false): void {
    revision++
    publish({ kind: "control", view: retired ? null : snapshot() })
  }
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run)
    queue = result.then(() => {}, () => {})
    return result
  }
  async function stopActive(): Promise<void> {
    const pending = active
    if (!pending) return
    pending.stop()
    await pending.done
    if (active === pending) active = undefined
  }
  const abort = (): void => { active?.stop() }
  deps.signal.addEventListener("abort", abort)
  return {
    snapshot,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    ask(question) {
      if (disposed || deps.signal.aborted) return Promise.reject(new Error("Side questions are unavailable"))
      return serialize(async () => {
        if (deps.signal.aborted) throw new Error("Side questions are unavailable")
        if (!question.trim()) throw new Error("Enter a side question")
        await stopActive()
        const source = sideQuestionSource(await deps.capture())
        if (deps.signal.aborted) throw new Error("Side questions are unavailable")
        const prefix = exchangesAsMessages(history)
        const id = randomUUID()
        current = { id, question, answer: "", state: "running" }
        publishControl()
        const messages = [...source, ...prefix, { kind: "user" as const, origin: "human" as const, content: sideQuestionReminder + question }]
        const bridge = bridgeExternalPromise(async (signal) => {
          let result: AgentRunResult
          try {
            result = await deps.run({ id, messages, signal,
              onAnswer: (answer) => {
                if (current?.id !== id || signal.aborted || current.answer === answer) return
                current = { ...current, answer }
                publish({ kind: "request", current })
              },
              onAppend: (text) => {
                if (current?.id !== id || signal.aborted || text.length === 0) return
                current = { ...current, answer: current.answer + text }
                publish({ kind: "appended", text })
              },
            })
          } catch {
            result = { durationMs: 0, servedRequests: 0, terminal: { kind: "api_error", message: "Side request initialization failed", recovery: { kind: "retry" } } }
          }
          if (current?.id === id) {
            const failure = failureTerminal(result.terminal)
            const noAnswer = !failure && !current.answer.trim()
            current = { ...current, state: signal.aborted || failure?.kind === "aborted" ? "stopped" : failure || noAnswer ? "error" : "done",
              ...(failure && failure.kind !== "aborted" ? { error: failure.kind === "model_unavailable" ? formatAgentFailure(failure) : "The side request failed. Try again." } : {}),
              ...(noAnswer ? { error: "The side request returned no answer. Ask in the main conversation if the question needs tools." } : {}) }
            if (current.state === "done" && current.answer.trim()) {
              history.push({ id, question, answer: current.answer, source, prefix })
              if (history.length > 20) history.shift()
            }
            log.debug("side request settled", { requestId: id, state: current.state, durationMs: result.durationMs, exchanges: history.length })
            publishControl()
          }
        })
        const fiber = Effect.runFork(bridge.owned)
        const done = Effect.runPromise(Fiber.await(fiber)).then(() => {})
        active = { id, stop: bridge.stop, done }
        return id
      })
    },
    stop(requestId) {
      return serialize(async () => {
        if (active?.id !== requestId || current?.state !== "running") {
          log.debug("side stop refused", { requestId, currentRequestId: current?.id })
          return false
        }
        await stopActive()
        return true
      })
    },
    clear(expected) {
      return serialize(async () => {
        if (disposed || expected !== revision) {
          log.debug("side clear refused", { expectedRevision: expected, revision, disposed })
          return false
        }
        await stopActive()
        history.length = 0
        current = null
        log.info("side history cleared", { expectedRevision: expected })
        publishControl()
        return true
      })
    },
    promotion(exchangeId) {
      const exchange = history.find((candidate) => candidate.id === exchangeId)
      return exchange ? structuredClone([...exchange.source, ...exchange.prefix, ...exchangesAsMessages([exchange])]) : undefined
    },
    async settled() { await queue; await active?.done },
    dispose() {
      if (disposal) return disposal
      disposed = true
      disposal = serialize(async () => {
        await active?.done
        deps.signal.removeEventListener("abort", abort)
        active = undefined
        history.length = 0
        current = null
        log.info("side host disposed", { revision })
        publishControl(true)
        listeners.clear()
      })
      return disposal
    },
  }
}
