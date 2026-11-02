import type { AgentRunTerminal, AgentToolInput } from "../agent-runtime/types.js"
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

/** Owns one-shot input admission and publishes the accepted result only after durable success. The loop seals
 *  the invocation with its final reply when a turn ends and no work it owns still runs, as `claude -p` returns its
 *  final message, so a one-shot Chat needs no handoff call and writes its answer once. */
export function createChatInvocationCompletion(onCompletion: ((content: AgentToolInput) => void) | undefined) {
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
    async finish(terminal: AgentRunTerminal, endDurably: () => Promise<void>): Promise<void> {
      if (onCompletion) await endDurably()
      else await endDurably().catch((error: unknown) => {
        if (error instanceof PersistenceWriteRefused) throw error
      })
      if (terminal.kind === "completed" && accepted) onCompletion?.(accepted)
    },
  }
}
