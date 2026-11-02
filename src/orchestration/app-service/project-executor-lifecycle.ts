import type { ReattachableProcessEndpoint } from "../../infra/reattachable-process-endpoint.js"
import { errorMessage } from "../../infra/error-message.js"
import type { Log } from "../../infra/log.js"
import type { RuntimeChatDefault } from "../../protocol/app-service-types.js"
import type { ProcessorClaims } from "../agent-runtime/tools/processor-claims.js"
import type { RuntimeComposition } from "./project-execution-runtime.js"
import { decodeProjectExecutorCommand, type ProjectExecutorCommand } from "./project-executor-protocol.js"

/** What the executor's lifecycle commands act on. */
interface ProjectExecutorLifecycleHandlers {
  /** Composes the runtime and answers `ready`. Rejects when the composition fails. */
  start(chatDefault: RuntimeChatDefault): Promise<void>
  /** Settles the runtime and answers `stopped`, or reports its own failure
   *  and ends the generation. `clientsHold` is the stop's word on whether a
   *  client holds the project, which decides the project's empty chats. */
  stop(clientsHold: boolean): Promise<void>
  /** The runtime a start composed, once there is one. */
  runtime(): Pick<RuntimeComposition, "startChatDefault" | "blockers" | "setReplacement" | "interruptForReplacement" | "continueAfterReplacement" | "continueCapacityWaits"> | undefined
  /** Takes the login shell PATH the account probed, as the base of every
   *  agent command's PATH. Arrives at any time, before or after the start. */
  adoptLoginShellPath(path: string): void
}

type Runtime = NonNullable<ReturnType<ProjectExecutorLifecycleHandlers["runtime"]>>

/** What the executor's side of its lifecycle channel offers the executor. */
interface ProjectExecutorLifecycle {
  /** Tells the account, unasked, the blockers list after it changed. */
  reportBlockers(): void
  /** Tells the account the project's earliest owed capacity time, or null,
   *  and resolves once the account store holds it. Rejects when the account
   *  refused it or the channel could not carry it. */
  recordCapacityWake(at: number | null): Promise<void>
}

/** The executor's side of its lifecycle channel. Each account command goes
 *  to its handler, and a command that cannot be done answers its own failure
 *  as `command_failed`: the generation keeps serving every session, because
 *  one refused request says nothing about the others. Only a start that fails
 *  ends the generation, since nothing serves until a start succeeds. A stop
 *  ends the generation on its own terms. */
export function serveProjectExecutorLifecycle(input: {
  readonly lifecycle: Pick<ReattachableProcessEndpoint<unknown, unknown>, "send" | "onMessage" | "onReattach">
  readonly handlers: ProjectExecutorLifecycleHandlers
  /** The executor's shell containers, which the account admits to processor
   *  time (ARCH-TOOLS-051). */
  readonly processor: Pick<ProcessorClaims, "claims" | "onClaimsChanged" | "applyHolds">
  readonly log: Pick<ReturnType<typeof Log.create>, "warn">
  /** Ends the generation after its start failed. */
  readonly end: (reason: string) => Promise<void>
}): ProjectExecutorLifecycle {
  const { lifecycle, handlers, log } = input
  let started = false
  const ready = (): Runtime => {
    const runtime = handlers.runtime()
    if (!runtime) throw new Error("project executor is not ready")
    return runtime
  }
  // The account keeps the last list to arrive as the latest one. So every
  // list, answer and unasked report alike, is computed only after the list
  // before it was sent, and lists arrive in the order they were computed.
  let blockersSent: Promise<void> = Promise.resolve()
  /** Sends the blockers list, as the answer to request `id` or unasked. */
  const sendBlockers = (id: number | undefined): Promise<void> => {
    const sent = blockersSent.then(async () => {
      const blockers = handlers.runtime() ? await ready().blockers() : []
      await lifecycle.send({ kind: "blockers", ...(id === undefined ? {} : { id }), blockers })
    })
    blockersSent = sent.catch(() => {})
    return sent
  }
  // The account keeps the last set to arrive as the whole set, so sets are
  // sent in order, and changes that arrive while one waits to be sent join
  // it: the set is read when it is sent.
  let claimsSent: Promise<void> = Promise.resolve()
  let claimsQueued = false
  const sendClaims = (): void => {
    if (claimsQueued) return
    claimsQueued = true
    claimsSent = claimsSent.then(async () => {
      claimsQueued = false
      await lifecycle.send({ kind: "processor_claims", claims: [...input.processor.claims()] })
    }).catch((error: unknown) => { log.warn("processor claims report failed", { error: errorMessage(error) }) })
  }
  input.processor.onClaimsChanged(sendClaims)
  // The account keeps the last time to arrive as the project's wake time,
  // so times are sent in the order they were asked.
  let wakeRequestId = 0
  const wakeRequests = new Map<number, { readonly at: number | null; readonly reply: PromiseWithResolvers<void> }>()
  let wakeSent: Promise<void> = Promise.resolve()
  const sendWake = (id: number, at: number | null): Promise<void> => {
    const sent = wakeSent.then(() => lifecycle.send({ kind: "capacity_wake", id, at }))
    wakeSent = sent.catch(() => {})
    return sent
  }
  const recordCapacityWake = (at: number | null): Promise<void> => {
    const id = ++wakeRequestId
    const reply = Promise.withResolvers<void>()
    wakeRequests.set(id, { at, reply })
    return sendWake(id, at).then(() => reply.promise).finally(() => { wakeRequests.delete(id) })
  }
  // An account that the lost transport separated from this executor may have
  // restarted, so it learns the whole set again. A wake time or its answer
  // that the lost transport carried has an unknown outcome, so each
  // unanswered time is sent again, in the order it was asked: the account
  // records a time it already holds as a no-op and answers it.
  lifecycle.onReattach(() => {
    sendClaims()
    for (const [id, { at }] of wakeRequests) sendWake(id, at).catch(() => {})
  })
  const answer = async (command: ProjectExecutorCommand): Promise<void> => {
    switch (command.kind) {
      case "start": {
        if (started) throw new Error("project executor was already started")
        started = true
        try {
          await handlers.start(command.chatDefault)
        } catch (error) {
          await lifecycle.send({ kind: "failed", reason: errorMessage(error) || "project executor start failed" }).catch(() => {})
          await input.end("project executor start failed")
        }
        return
      }
      case "stop":
        // A stop that fails has already reported it and closed the channels.
        await handlers.stop(command.clientsHold).catch((error: unknown) => { log.warn("project executor stop failed", { error: errorMessage(error) }) })
        return
      case "start_chat_default":
        ready().startChatDefault()
        return
      case "blockers":
        await sendBlockers(command.id)
        return
      case "replacement":
        ready().setReplacement(command.state)
        return
      case "login_shell_path":
        handlers.adoptLoginShellPath(command.path)
        return
      case "processor_holds":
        input.processor.applyHolds(command.held)
        return
      case "capacity_wake_recorded": {
        const reply = wakeRequests.get(command.id)?.reply
        if (command.error === undefined) reply?.resolve()
        else reply?.reject(new Error(command.error))
        return
      }
      case "continue_capacity_waits": {
        const runtime = ready()
        const { id } = command
        // Answered once every owed continuation started; the channel keeps
        // serving meanwhile.
        void runtime.continueCapacityWaits().then(async ({ pending, at, next }) => {
          await lifecycle.send({ kind: "capacity_continued", id, pending, at, next })
        }).catch((error: unknown) => {
          log.warn("capacity wait continuation failed", { error: errorMessage(error) })
          return lifecycle.send({ kind: "command_failed", command: "continue_capacity_waits", id, reason: errorMessage(error) || "capacity wait continuation failed" })
        }).catch(() => {})
        return
      }
      case "interrupt_for_replacement":
      case "continue_after_replacement": {
        const runtime = ready()
        // Answered when the work settles, which may take as long as the
        // turns it cuts or resumes; the lifecycle channel keeps serving
        // other commands meanwhile.
        const handoff = command.kind === "interrupt_for_replacement"
          ? runtime.interruptForReplacement(command.handoffId)
          : runtime.continueAfterReplacement(command.handoffId)
        const { id } = command
        void handoff.then(
          (sessionIds) => lifecycle.send({ kind: "handoff", id, sessionIds: [...sessionIds] }),
          (error: unknown) => {
            log.warn("replacement handoff failed", { kind: command.kind, error: errorMessage(error) })
            return lifecycle.send({ kind: "handoff", id, error: errorMessage(error) || "replacement handoff failed" })
          },
        ).catch(() => {})
      }
    }
  }
  lifecycle.onMessage(async (value) => {
    const command = decodeProjectExecutorCommand(value)
    try {
      if (!command) throw new Error("project executor lifecycle command is invalid")
      await answer(command)
    } catch (error) {
      const reason = errorMessage(error) || "project executor lifecycle command failed"
      log.warn("project executor lifecycle command failed", { command: command?.kind, reason })
      await lifecycle.send({
        kind: "command_failed", reason,
        ...(command === undefined ? {} : { command: command.kind }),
        ...(command !== undefined && "id" in command ? { id: command.id } : {}),
      }).catch(() => {})
    }
  })
  return {
    reportBlockers() {
      sendBlockers(undefined).catch((error: unknown) => { log.warn("replacement blocker report failed", { error: errorMessage(error) }) })
    },
    recordCapacityWake,
  }
}
