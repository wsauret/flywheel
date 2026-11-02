import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createReadRetry } from "../../../src/protocol/client/background-reads.js"
import type { ModelSelectionSlot } from "../../../src/protocol/model-assignment-protocol-types.js"
import type { ActiveModel } from "./active-model.js"
import { readSeat, type PanelSeat } from "./session-settings.js"
import type { HeldRoles } from "./session-roles.js"

/** One seat's reading: the model and effort stops of the seat in use for one
 *  session, or for the defaults with no session open.
 *
 *  Session readings follow the runtime roles cursor. Effort options and
 *  defaults are read when shown; hidden sessions do not read. */
export interface SeatReading {
  /** The last seat read, which stays while a newer read runs. Before the
   *  first read it is the seat in use with no model, scoped to the session,
   *  so a row that writes it never edits the defaults by mistake. */
  readonly seat: PanelSeat
  /** The seat as the composer names it, or undefined until a model serves it. */
  readonly activeModel: ActiveModel | undefined
  /** Reads the seat now. A newer read supersedes one that runs. */
  refresh(): Promise<void>
  /** Says the seat may have changed: a shown seat reads at once, a hidden one
   *  when `show` runs. */
  invalidate(): void
  /** Marks the seat as shown or hidden. A seat shown that was never read, or
   *  that changed while hidden, reads. */
  show(shown: boolean): void
  dispose(): void
}

export function createSeatReading(deps: {
  readonly connection: Pick<RuntimeConnection, "query">
  readonly sessionId: string | undefined
  /** The seat in use now, which the running agent of a workflow decides. */
  readonly slot: () => ModelSelectionSlot
  readonly roles?: Pick<HeldRoles, "get" | "subscribe">
  readonly changed: () => void
}): SeatReading {
  let seat: PanelSeat | undefined
  let unread: PanelSeat | undefined
  let activeModel: ActiveModel | undefined
  let shown = false
  let stale = true
  let generation = 0
  let disposed = false
  let unsubscribe: (() => void) | undefined
  const retry = createReadRetry(deps.connection, "seat", () => { if (shown) void refresh() })

  async function refresh(): Promise<void> {
    const request = ++generation
    stale = false
    try {
      const serving = deps.sessionId === undefined ? undefined : deps.roles?.get(deps.sessionId)?.serving
      const slot = serving?.slot ?? deps.slot()
      if (deps.roles !== undefined) {
        // A model's effort stops stay while its seat is read again, so an
        // effort edit or an unrelated roles patch never drops the slider.
        const kept = seat?.seatSlot.roleId === slot.roleId && seat.seatModel === serving?.selection?.model ? seat.seatEfforts : []
        seat = {
          seatSlot: slot, seatEfforts: kept,
          ...(deps.sessionId === undefined ? {} : { seatSessionId: deps.sessionId }),
          ...(serving?.selection === undefined ? {} : { seatModel: serving.selection.model, seatEffort: serving.selection.effort }),
        }
        activeModel = serving?.selection
        deps.changed()
        if (serving === undefined) return
      }
      const next = await readSeat(deps.connection, deps.sessionId, slot, serving)
      if (disposed || request !== generation) return
      retry.succeeded()
      seat = next
      activeModel = next.seatModel === undefined || next.seatEffort === undefined ? undefined : { model: next.seatModel, effort: next.seatEffort }
      deps.changed()
    } catch (cause) {
      if (disposed || request !== generation) return
      stale = true
      if (shown) retry.failed(cause)
    }
  }

  return {
    get seat() {
      if (seat !== undefined) return seat
      const slot = deps.slot()
      if (unread?.seatSlot.roleId !== slot.roleId) unread = { seatSlot: slot, seatEfforts: [], ...(deps.sessionId === undefined ? {} : { seatSessionId: deps.sessionId }) }
      return unread
    },
    get activeModel() { return activeModel },
    refresh,
    invalidate() {
      stale = true
      if (shown) void refresh()
    },
    show(next) {
      if (shown === next) return
      shown = next
      if (shown && unsubscribe === undefined && deps.roles !== undefined && deps.sessionId !== undefined) {
        unsubscribe = deps.roles.subscribe(deps.sessionId, () => { stale = true; if (shown) void refresh() })
      }
      if (!shown) retry.succeeded()
      if (shown && stale) void refresh()
    },
    dispose() { disposed = true; unsubscribe?.(); retry.dispose() },
  }
}
