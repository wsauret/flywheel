import { isActiveActivity } from "../../protocol/app-service-types.js"
import { Log } from "../../infra/log.js"
import { recordBackgroundFailure } from "../../infra/operation-log.js"
import type { ChatRunner } from "../chat/runner-types.js"
import type { HeldRetainedOperation } from "../module-seams.js"
import { entryActivity } from "../session-store/activity.js"
import { readChatTurnEnd } from "../session/chat-session-run-evidence.js"
import { isResumableTurnEnd, isVisibleTurnEnd } from "../session/conversation/turn-end-record.js"
import { reconcileAgentInput } from "../session/agent-input-reconciliation.js"
import { activateDurableChat } from "./session-reactivation.js"
import type { SessionMutation, SessionRuntimeActorContext } from "./session-runtime-actor-types.js"
import type { ResumeChatOutcome } from "./runtime-supervisor-types.js"
import type { createBackgroundNotificationDelivery } from "./session-background-notifications.js"

const log = Log.create({ service: "session-runtime-actor" })
const ready = <A>(outcome: A): (() => Promise<A>) => () => Promise.resolve(outcome)

/** Called inside the session mailbox. Execution is returned as a tail so runner
 * attachment can enter that mailbox only after durable admission completes. */
export function createSessionContinuation(
  sessionId: string,
  ctx: SessionRuntimeActorContext,
  owner: {
    readonly isClosing: () => boolean
    readonly clearFailure: () => void
    readonly ensureChatRunner: () => Promise<ChatRunner>
    readonly ownAcceptedWork: <A>(work: Promise<A>) => Promise<A>
    readonly generation: () => number
    readonly isGenerationValid: (generation: number) => boolean
    readonly backgroundNotifications: ReturnType<typeof createBackgroundNotificationDelivery>
    /** Reads the open display again from the conversation, in the mailbox. */
    readonly refreshDisplay: () => void
  },
) {
  /** The runner's writer commits held work outside the turn's own events,
   *  so the open display shows its record only once it reads the
   *  conversation again. */
  function shown(operation: HeldRetainedOperation): HeldRetainedOperation {
    return {
      kind: operation.kind, key: operation.key, landed: owner.refreshDisplay,
      commit: async () => {
        const result = await operation.commit()
        if (result.kind !== "committed") return result
        return {
          ...result,
          dispatch: async () => {
            const dispatched = await result.dispatch()
            if (dispatched) owner.ownAcceptedWork(dispatched.settlement)
          },
        }
      },
    }
  }

  /** The module work this chat holds in cells, from every installed kind. */
  async function readRetained(conversationId: string): Promise<readonly HeldRetainedOperation[]> {
    return (await Promise.all((ctx.retainedOperations ?? []).map((authority) => authority.read({ sessionId, conversationId })))).flat()
  }

  /** Startup and admission finish outside the mailbox. A lifecycle command
   * that supersedes either prevents the committed input from waking a turn. */
  function continueCommitted(start: (runner: ChatRunner) => boolean): () => Promise<boolean> {
    return async () => {
      const forGeneration = owner.generation()
      try {
        const runner = await owner.ensureChatRunner()
        await (await ctx.runnerCapabilities()).authAdmission.admit(sessionId)
        if (!owner.isGenerationValid(forGeneration)) return false
        return start(runner)
      } catch {
        return false
      }
    }
  }

  async function resume(): Promise<() => Promise<ResumeChatOutcome>> {
    const refused = (reason: string): (() => Promise<ResumeChatOutcome>) => ready({ ok: false, reason })
    if (owner.isClosing() || ctx.isDisposed()) return refused("Session is closing")
    owner.clearFailure()
    const activation = await activateDurableChat(ctx, sessionId)
    if (activation.status === "unavailable") return refused(`Session ${sessionId} is no longer available`)
    const entry = ctx.sessionStore.get(sessionId)
    if (entry?.kind !== "chat") return refused(`Session ${sessionId} is not a chat`)
    if (entry.runner && isActiveActivity(entryActivity(entry))) return refused("A turn is already running")
    const retained = await readRetained(entry.conversationId)
    if (retained.length > 0) {
      return async () => {
        const runner = await owner.ensureChatRunner()
        if (!runner.acceptRetainedOperation) return { ok: false, reason: "The runner cannot accept retained work" }
        for (const operation of retained) await runner.acceptRetainedOperation(shown(operation))
        // Held work retires its cell in the commit that lands its record, so
        // a cell that is still there is work that did not commit.
        const waiting = await readRetained(entry.conversationId)
        if (retained.some((operation) => waiting.some((cell) => cell.kind === operation.kind && cell.key === operation.key))) {
          return { ok: false, reason: "The chat's held work did not commit. A concurrent change kept it, or it waits for the answer to an open question. Resume again to retry." }
        }
        return { ok: true }
      }
    }
    const turnEnd = (await readChatTurnEnd(ctx.projectionReader, entry.conversationId))?.end
    if (!isResumableTurnEnd(turnEnd)) return refused("Nothing to resume: the last turn finished, or the person ended it")
    await owner.backgroundNotifications.drainHeld(entry)
    if (activation.status !== "opened") {
      await reconcileAgentInput({ conversationId: entry.conversationId, sessionId, store: ctx.eventStore, projectionReader: ctx.projectionReader, writer: ctx.eventWriter })
    }
    const started = continueCommitted((runner) => runner.resume({ announce: isVisibleTurnEnd(turnEnd) }))
    return async () => await started() ? { ok: true } : { ok: false, reason: "The runner did not resume the turn" }
  }

  async function accept(operation: Extract<SessionMutation, { kind: "operation.accept" }>["operation"]): Promise<() => Promise<boolean>> {
    if (owner.isClosing() || ctx.isDisposed()) return ready(false)
    if (!ctx.sessionStore.has(sessionId) && (await activateDurableChat(ctx, sessionId)).status === "unavailable") return ready(false)
    const entry = ctx.sessionStore.get(sessionId)
    if (entry?.kind !== "chat") return ready(false)
    const authority = ctx.retainedOperations?.find((candidate) => candidate.kind === operation.kind)
    if (!authority) return ready(false)
    const held = await authority.accept({ sessionId, conversationId: entry.conversationId, operation })
    return async () => {
      void owner.ownAcceptedWork(owner.ensureChatRunner()
        .then(async (runner) => {
          if (!runner.acceptRetainedOperation) throw new Error("The runner cannot accept retained work")
          await runner.acceptRetainedOperation(shown(held))
        }))
        .catch((error: unknown) => {
          recordBackgroundFailure(log, "admit retained operation to the runner's writer", {
            sessionId,
            operationKind: held.kind,
            operationKey: held.key,
          }, error)
        })
      return true
    }
  }
  return { resume, accept, continueCommitted }
}
