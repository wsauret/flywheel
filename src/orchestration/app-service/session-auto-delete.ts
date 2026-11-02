import { DebugLog } from "../../infra/debug-log.js"
import type { RuntimeConfigOwner } from "../config/runtime-config-owner.js"
import type { SessionManager } from "../session/manager.js"

const DAY_MS = 86_400_000

interface SessionAutoDeletePorts {
  readonly config: Pick<RuntimeConfigOwner, "snapshot" | "subscribe">
  readonly sessions: Pick<SessionManager, "listMetadata">
  /** Uses ordinary recursive session deletion, conditional on state admission. */
  readonly deleteSession: (sessionId: string, inactiveBefore: number) => Promise<boolean>
  readonly now?: () => number
}

/** Resolves with the number of chats deleted in one pass. Catalog failure
 * rejects; a deletion failure is recorded and leaves other candidates eligible.
 * Catalog rows only select candidates; admission rechecks the complete tree
 * against concurrent activation and launches. */
export async function sweepUnusedSessions(ports: SessionAutoDeletePorts): Promise<number> {
  const days = ports.config.snapshot().config.auto_delete_session_days
  if (days === 0) return 0
  const now = (ports.now ?? Date.now)()
  const cutoff = now - days * DAY_MS
  const catalog = await ports.sessions.listMetadata()
  let deleted = 0
  for (const session of catalog.sessions) {
    if (ports.config.snapshot().config.auto_delete_session_days !== days) break
    if (session.kind !== "chat" || session.lifecycleState !== "inactive" || !(Date.parse(session.lastUpdated) <= cutoff)) continue
    let removed: boolean
    try {
      removed = await ports.deleteSession(session.id, cutoff)
    } catch {
      DebugLog.record({ type: "session.auto_delete.failed", sessionId: session.id, notable: true, payload: { stage: "delete", thresholdDays: days } })
      continue
    }
    if (!removed) continue
    deleted++
    DebugLog.record({ type: "session.auto_delete.deleted", sessionId: session.id, payload: { inactiveDays: Math.floor((now - Date.parse(session.lastUpdated)) / DAY_MS), thresholdDays: days } })
  }
  DebugLog.record({ type: "session.auto_delete.swept", payload: { deleted, thresholdDays: days } })
  return deleted
}

/** Account-owned project lifetime. Admission follows foreground readiness;
 * disposal cancels future passes and joins any deletion already admitted. */
export function createSessionAutoDelete(ports: SessionAutoDeletePorts) {
  let started = false
  let disposed = false
  let requested = false
  let active: Promise<void> | undefined
  const deleteSession = (id: string, cutoff: number) => disposed ? Promise.resolve(false) : ports.deleteSession(id, cutoff)
  let timer: ReturnType<typeof setInterval> | undefined
  let deferred: ReturnType<typeof setTimeout> | undefined
  const run = (): void => {
    if (disposed || !started) return
    requested = true
    if (active) return
    active = (async () => {
      while (requested) {
        if (disposed) break
        requested = false
        try {
          await sweepUnusedSessions({
            ...ports,
            deleteSession,
          })
        } catch {
          DebugLog.record({ type: "session.auto_delete.failed", notable: true, payload: { stage: "catalog", thresholdDays: ports.config.snapshot().config.auto_delete_session_days } })
        }
      }
    })().finally(() => { active = undefined; if (requested) run() })
  }
  const unsubscribe = ports.config.subscribe("autoDeleteSessionDays", run)
  return {
    start(): void {
      if (started || disposed) return
      started = true
      deferred = setTimeout(run, 0)
      deferred.unref()
      timer = setInterval(run, DAY_MS)
      timer.unref()
    },
    async dispose(): Promise<void> {
      disposed = true
      clearTimeout(deferred)
      clearInterval(timer)
      await unsubscribe()
      await active
    },
  }
}
