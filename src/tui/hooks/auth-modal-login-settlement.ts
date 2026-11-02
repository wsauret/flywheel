import type { AuthOperationConfirmation, AuthOperationSettlement, RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import { loginSettlement } from "../../protocol/client/auth-login.js"
import type { AuthModalDeps } from "./auth-modal-types.js"

/** What a long login waits for on the auth cursor: its end, or a question it asks before it stores the account. */
type SettlementOrQuestion = AuthOperationSettlement | AuthOperationConfirmation

/** A login operation that waits for its end on the auth cursor. It shows each
 *  progress message once: a view delivered again repeats the last one. */
interface SettlementWaiter {
  readonly resolve: (settlement: SettlementOrQuestion) => void
  lastProgress?: string
}

/** Follows the long logins the modal started in the runtime, by operation id:
 *  each one's progress messages and its one end, as the auth view carries
 *  them. `observe` reads every published view. */
export function createAuthModalLoginSettlement(deps: Pick<AuthModalDeps, "auth" | "showToast">) {
  const waiters = new Map<string, SettlementWaiter>()

  /** Resolves with the runtime's settlement of one login operation, or with the question it asks before it stores
   *  the account, and shows the flow's progress messages until then; rejects when the attempt ends first. */
  function awaitSettlement(operationId: string, signal: AbortSignal): Promise<SettlementOrQuestion> {
    const published = ended(deps.auth(), operationId)
    if (published !== undefined) return Promise.resolve(published)
    if (signal.aborted) return Promise.reject(new Error("Login cancelled"))
    const waiter = Promise.withResolvers<SettlementOrQuestion>()
    waiters.set(operationId, { resolve: waiter.resolve })
    signal.addEventListener("abort", () => { waiters.delete(operationId); waiter.reject(new Error("Login cancelled")) }, { once: true })
    return waiter.promise
  }

  function observe(published: RuntimeAuthView | undefined): void {
    for (const [operationId, waiter] of waiters) {
      const settlement = ended(published, operationId)
      if (settlement !== undefined) {
        waiters.delete(operationId)
        waiter.resolve(settlement)
        continue
      }
      const progress = published?.progress
      if (progress?.operationId !== operationId || progress.message === waiter.lastProgress) continue
      waiter.lastProgress = progress.message
      deps.showToast({ message: progress.message, variant: "info" })
    }
  }

  return { awaitSettlement, observe }
}

function ended(published: RuntimeAuthView | undefined, operationId: string): SettlementOrQuestion | undefined {
  return loginSettlement(published, operationId) ?? (published?.confirmation?.operationId === operationId ? published.confirmation : undefined)
}
