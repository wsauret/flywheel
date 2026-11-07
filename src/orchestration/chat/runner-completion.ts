import { failureTerminal, type AgentFailureReason, type AgentRunTerminal, type AgentToolInput } from "../agent-runtime/types.js"
import { PersistenceWriteRefused } from "../../infra/event-store-types.js"

/** Owns the logical turn's durability barrier independently of runner attempts. */
export function createChatTurnDurability(endTurn: () => Promise<void>, onFailure: (error: unknown) => void) {
  let durable = Promise.resolve()
  let turnSettlement: PromiseWithResolvers<void> | undefined
  let settlement: Pick<PromiseWithResolvers<void>, "resolve" | "reject"> | undefined
  const settle = (error?: unknown): void => {
    const pending = settlement
    if (!pending) return
    settlement = undefined
    if (error === undefined) pending.resolve()
    else pending.reject(error)
  }
  return {
    begin(): void {
      turnSettlement ??= Promise.withResolvers<void>()
      if (settlement) return
      const pending = Promise.withResolvers<void>()
      durable = pending.promise
      void durable.catch(() => {})
      settlement = pending
    },
    settle,
    get pendingTurnSettlement(): Promise<void> | undefined { return turnSettlement?.promise },
    finish(): void {
      const pending = turnSettlement
      turnSettlement = undefined
      pending?.resolve()
    },
    awaitDurable: () => durable,
    async end(): Promise<void> {
      try {
        await endTurn()
        settle()
      } catch (error) {
        onFailure(error)
        settle(error)
        throw error
      }
    },
  }
}

/** How a turn of the root chat ended: its model answered, the provider refused the conversation content, or
 *  the run failed with `failure`. An interrupt ends no turn here: the turn waits to resume. */
export type ChatTurnEnding =
  | { readonly kind: "completed" }
  | { readonly kind: "refused" }
  | { readonly kind: "failed"; readonly failure: Exclude<AgentFailureReason["kind"], "aborted"> }

/** Owns one-shot input admission and publishes the accepted result only after durable success. The loop seals
 *  the invocation with its final reply when a turn ends and no work it owns still runs, as `claude -p` returns its
 *  final message, so a one-shot Chat needs no handoff call and writes its answer once. `onTurnEnded` hears how
 *  each turn of the root chat ended, for a headless caller that answers each turn. */
export function createChatInvocationCompletion(onCompletion: ((content: AgentToolInput) => void) | undefined, onTurnEnded?: (ending: ChatTurnEnding) => void) {
  let accepted: AgentToolInput | undefined
  let admitting = 0
  let pendingInput = () => false
  return {
    get sealed(): boolean { return accepted !== undefined },
    get hasPendingInput(): boolean { return admitting > 0 || pendingInput() },
    bindInputSource(hasPending: () => boolean): void { pendingInput = hasPending },
    /** Reserves input before its durable write. Release only after delivery or failure. */
    admitInput(): (() => void) | undefined {
      if (accepted) return undefined
      admitting++
      return () => { admitting-- }
    },
    beginAttempt(): void {
      if (accepted) throw new Error("The one-shot Chat invocation has already completed")
    },
    /** Seals the invocation with the final reply. False when input arrived first: the loop takes that input. */
    seal: onCompletion ? (finalReply: string): boolean => {
      if (accepted) throw new Error("The one-shot Chat invocation has already completed")
      if (admitting > 0 || pendingInput()) return false
      accepted = { summary: finalReply }
      return true
    } : undefined,
    /** Reports a turn that the model answered, or that the provider's content filter ended (`contentRefused`). */
    turnEnded(contentRefused: boolean): void {
      onTurnEnded?.({ kind: contentRefused ? "refused" : "completed" })
    },
    async finish(terminal: AgentRunTerminal, endDurably: () => Promise<void>): Promise<void> {
      if (onCompletion) await endDurably()
      else await endDurably().catch((error: unknown) => {
        if (error instanceof PersistenceWriteRefused) throw error
      })
      if (terminal.kind === "completed" && accepted) onCompletion?.(accepted)
      // A run ends with its turn only when it fails; an abort is a stop that a caller asked for.
      const failure = failureTerminal(terminal)
      if (failure && failure.kind !== "aborted") onTurnEnded?.(failure.kind === "api_error" && failure.contentRefused ? { kind: "refused" } : { kind: "failed", failure: failure.kind })
    },
  }
}
