import { errorMessage } from "../../infra/error-message.js"
import type { CapacityContinuation } from "./capacity-wait-continuation.js"
import type { ProjectExecutorEvent } from "./project-executor-protocol.js"

/** The executor's answer to one request of the account. */
type ExecutorReply = Extract<ProjectExecutorEvent, { readonly kind: "handoff" | "capacity_continued" }>

/** The commands whose answer comes later, under the command's id. */
const ANSWERED_LATER = new Set(["interrupt_for_replacement", "continue_after_replacement", "continue_capacity_waits"])

type Send = (message: unknown) => Promise<void>

/** The requests between the account and one executor generation whose
 *  answers arrive later on the lifecycle channel, each under the id it was
 *  sent with: the account's handoff and capacity continuation, and the
 *  executor's capacity wake, which the account answers once it holds it. */
export interface ExecutorLifecycleRequests {
  /** Sends one half of a planned replacement's handoff; resolves with the
   *  sessions the executor interrupted or resumed. */
  handoff(send: Send, kind: "interrupt_for_replacement" | "continue_after_replacement", handoffId: string, failure: Promise<never>): Promise<readonly string[]>
  /** Asks the executor to continue its capacity waits. */
  continueCapacityWaits(send: Send, failure: Promise<never>): Promise<CapacityContinuation>
  /** One lifecycle frame: an answer settles the request it names, a
   *  failed command rejects it, and a capacity wake is recorded and
   *  answered through `send`. */
  hear(frame: ProjectExecutorEvent, send: Send): void
  /** The lifecycle transport was lost. A capacity continuation in flight on
   *  it has an unknown outcome, so it rejects, and the account's wake tries
   *  it again; a repeated continuation finds the waits it started held. A
   *  handoff is never asked again, so it keeps waiting for its answer. */
  detached(reason: Error): void
}

/** Requests reject when the executor reports that it could not do the
 *  command or when `failure` rejects first, such as when the generation ends.
 *  `recordWake` records the project's capacity wake in the account. */
export function createExecutorLifecycleRequests(recordWake: ((at: number | null) => Promise<void>) | undefined): ExecutorLifecycleRequests {
  let lastId = 0
  const waiting = new Map<number, { readonly reply: PromiseWithResolvers<ExecutorReply>; readonly failsOnDetach: boolean }>()
  const ask = async (send: Send, message: (id: number) => object, failure: Promise<never>, failsOnDetach = false): Promise<ExecutorReply> => {
    const id = ++lastId
    const reply = Promise.withResolvers<ExecutorReply>()
    waiting.set(id, { reply, failsOnDetach })
    try {
      await send({ ...message(id), id })
      return await Promise.race([reply.promise, failure])
    } finally {
      waiting.delete(id)
    }
  }
  return {
    async handoff(send, kind, handoffId, failure) {
      const reply = await ask(send, () => ({ kind, handoffId }), failure)
      if (reply.kind !== "handoff") throw new Error("project executor answered a handoff with another reply")
      if ("error" in reply) throw new Error(reply.error)
      return reply.sessionIds
    },
    async continueCapacityWaits(send, failure) {
      const reply = await ask(send, () => ({ kind: "continue_capacity_waits" }), failure, true)
      if (reply.kind !== "capacity_continued") throw new Error("project executor answered a capacity continuation with another reply")
      return { pending: reply.pending, at: reply.at, next: reply.next }
    },
    hear(frame, send) {
      if (frame.kind === "handoff" || frame.kind === "capacity_continued") waiting.get(frame.id)?.reply.resolve(frame)
      else if (frame.kind === "command_failed" && frame.id !== undefined && frame.command !== undefined && ANSWERED_LATER.has(frame.command)) {
        waiting.get(frame.id)?.reply.reject(new Error(frame.reason))
      } else if (frame.kind === "capacity_wake") {
        const { id } = frame
        void Promise.resolve(recordWake?.(frame.at)).then(
          () => send({ kind: "capacity_wake_recorded", id }),
          (error: unknown) => send({ kind: "capacity_wake_recorded", id, error: errorMessage(error) || "the capacity wake was not recorded" }),
        ).catch(() => {})
      }
    },
    detached(reason) {
      for (const { reply, failsOnDetach } of waiting.values()) if (failsOnDetach) reply.reject(reason)
    },
  }
}
