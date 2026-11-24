import type { AsyncEventWriter } from "../../src/infra/store/event-store-types.js"
import type { SessionFactWriter } from "../../src/orchestration/session/persistence/session-fact-writer.js"

/** A complete event writer for a subject that must not write through it.
 *  Each method that `overrides` does not replace rejects and names itself. */
export function refusingEventWriter(overrides: Partial<AsyncEventWriter> = {}): AsyncEventWriter {
  const refuse = (method: keyof AsyncEventWriter) => async (): Promise<never> => {
    throw new Error(`unexpected event writer call: ${method}`)
  }
  return {
    append: refuse("append"),
    appendBatch: refuse("appendBatch"),
    appendGuarded: refuse("appendGuarded"),
    appendBatchGuarded: refuse("appendBatchGuarded"),
    stageSessionContentNodes: refuse("stageSessionContentNodes"),
    pruneSupersededEvents: refuse("pruneSupersededEvents"),
    pruneSupersededKeyedEvents: refuse("pruneSupersededKeyedEvents"),
    putInFlight: refuse("putInFlight"),
    dropInFlight: refuse("dropInFlight"),
    swapInFlight: refuse("swapInFlight"),
    swapInFlightBatch: refuse("swapInFlightBatch"),
    ...overrides,
  }
}

/** A complete session fact writer that stores nothing: records resolve
 *  `null`, a transaction runs its callback, and in-flight and content writes
 *  resolve as if they were stored. `overrides` replaces the methods a test
 *  observes. */
export function discardingSessionFactWriter(overrides: Partial<SessionFactWriter> = {}): SessionFactWriter {
  return {
    record: async () => null,
    recordBatch: async () => null,
    recordGuarded: async () => null,
    transaction: async (fn) => { fn() },
    dispose: () => {},
    putInFlight: async () => {},
    dropInFlight: async () => {},
    swapInFlight: async () => true,
    stageSessionContentNodes: async () => {},
    ...overrides,
  }
}
