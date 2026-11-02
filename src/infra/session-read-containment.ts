import { isSessionHistoryFailure } from "./event-store-types.js"
import { recordBackgroundFailure, type OperationLogger } from "./operation-log.js"

export interface SessionReadContainment {
  /** The value `read` gives for `sessionId`, or `fallback` when the session's
   *  history cannot be read. */
  read<T, F>(sessionId: string, read: () => Promise<T>, fallback: F): Promise<T | F>
}

/** Keeps one session's unreadable history inside that session, for a reader
 *  that answers for many sessions, such as a batch or a parent that reads its
 *  children. The reader answers that session with its fallback and goes on
 *  with the others. Each session's failure records once, and again only
 *  after a read of that session has succeeded. A request the store did not
 *  serve and an interrupted read say nothing about history, so they
 *  propagate (`isSessionHistoryFailure`). */
export function containSessionReads(log: OperationLogger, operation: string): SessionReadContainment {
  const unreadable = new Set<string>()
  return {
    async read(sessionId, read, fallback) {
      try {
        const value = await read()
        unreadable.delete(sessionId)
        return value
      } catch (error) {
        if (!isSessionHistoryFailure(error)) throw error
        if (!unreadable.has(sessionId)) recordBackgroundFailure(log, operation, { sessionId }, error)
        unreadable.add(sessionId)
        return fallback
      }
    },
  }
}
