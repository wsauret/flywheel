import { DebugLog } from "../../infra/debug-log.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { escapeXml, formatRuntimeNotification } from "../agent-runtime/runtime-notifications.js"
import type { ChatRunner, SessionEventKind } from "../chat/runner-types.js"
import { entryActivity } from "../session-store/activity.js"
import type { SessionEntry, SessionStore } from "../session-store/types.js"

const log = Log.create({ service: "session-event-notices" })

/** The runtime's notices to a watching chat about the chats that it watches (ARCH-SESSIONS-052). A chat's runner
 *  reports each event of its turns (`SessionEventKind`). For each chat that watches the reporting chat, the service
 *  keeps the latest kind of each watched chat while the watcher has a turn in progress, and hands the watcher's runner
 *  one silent notice when it has none. Pending events live in memory only: a report for a watcher with no attached
 *  runner, and every pending event of a watcher whose runner ended, is dropped, so a watcher that no client shows
 *  learns nothing. */
export interface SessionEventNotices {
  /** `watcherSessionId` hears the events of `watchedSessionId` from now on. Repeating it changes nothing. */
  watch(watcherSessionId: string, watchedSessionId: string): void
  /** Ends the watch and drops its pending event. */
  unwatch(watcherSessionId: string, watchedSessionId: string): void
  /** The chat `sessionId` reports `kind`. Nothing happens when no chat watches it. */
  report(sessionId: string, kind: SessionEventKind): void
  dispose(): void
}

interface PendingEvent {
  readonly kind: SessionEventKind
  readonly title: string
}

interface Watcher {
  readonly pending: Map<string, PendingEvent>
  /** A notice to the runner has not answered yet. */
  delivering: boolean
  /** The runner held the last notice: ask again only after a turn of the watcher ran and came to rest. */
  held: boolean
  /** A turn of the watcher was in progress since the hold. */
  workedSinceHold: boolean
}

/** The notice text: each watched chat's id, title, and latest kind, and no chat content. */
function formatSessionEventNotice(events: ReadonlyMap<string, PendingEvent>): string {
  return formatRuntimeNotification({
    tag: "session_event_notice",
    handling: "Chats that you watch changed state, as listed below. The person reads each chat's own question, result, or failure in that chat. You can add a short comment or recommendation for the person, or end your turn with no text. Never answer a chat's question and never speak for a chat.",
    body: [...events].map(([sessionId, event]) =>
      `<chat><session_id>${escapeXml(sessionId)}</session_id><title>${escapeXml(event.title)}</title><event>${event.kind}</event></chat>`).join("\n"),
  })
}

/** The fields of a store entry that the service reads. */
type WatchedEntry = Pick<SessionEntry, "kind" | "runnerState" | "streamPhase" | "waitingOnBackgroundWork" | "description"> & {
  readonly runner: Pick<ChatRunner, "deliverSilentNotice"> | null
}

export function createSessionEventNotices(input: {
  readonly sessionStore: { get(sessionId: string): WatchedEntry | undefined; readonly onChange: SessionStore["onChange"] }
}): SessionEventNotices {
  const { sessionStore } = input
  const watchersOf = new Map<string, Set<string>>()
  const watchers = new Map<string, Watcher>()
  // A change offers pending events only to the watchers among the changed sessions.
  const unsubscribe = sessionStore.onChange((changed) => {
    for (const watcherId of changed ?? watchers.keys()) {
      const watcher = watchers.get(watcherId)
      if (watcher && watcher.pending.size > 0) offer(watcherId, watcher)
    }
  }, "session-event-notices")

  function chatEntry(sessionId: string): WatchedEntry | undefined {
    const entry = sessionStore.get(sessionId)
    return entry?.kind === "chat" ? entry : undefined
  }

  /** A turn is in progress while the chat works, waits on its background work, or waits on its own question. */
  function turnInProgress(entry: WatchedEntry): boolean {
    const activity = entryActivity(entry)
    return (activity !== "idle" && activity !== "absent") || entry.waitingOnBackgroundWork
  }

  /** A watcher lives only while it has pending events or a notice in flight, so a hold never outlives the events
   *  that it held: a later report starts from a fresh watcher. */
  function forgetIfDone(watcherId: string, watcher: Watcher): void {
    if (watcher.pending.size === 0 && !watcher.delivering && watchers.get(watcherId) === watcher) watchers.delete(watcherId)
  }

  function offer(watcherId: string, watcher: Watcher): void {
    if (watcher.delivering) return
    const entry = chatEntry(watcherId)
    const runner = entry?.runner
    if (!entry || !runner) {
      watcher.pending.clear()
      forgetIfDone(watcherId, watcher)
      return
    }
    if (turnInProgress(entry)) {
      if (watcher.held) watcher.workedSinceHold = true
      return
    }
    if (watcher.held && !watcher.workedSinceHold) return
    const events = new Map(watcher.pending)
    watcher.delivering = true
    void runner.deliverSilentNotice(formatSessionEventNotice(events)).then((answer) => {
      DebugLog.record({ type: "session.event_notice.answered", sessionId: watcherId, payload: { chats: events.size, kinds: [...new Set([...events.values()].map((event) => event.kind))], answer } })
      watcher.held = answer === "held"
      watcher.workedSinceHold = false
      if (answer === "delivered") {
        // An event that a newer report replaced meanwhile stays for the next notice.
        for (const [sessionId, event] of events) if (watcher.pending.get(sessionId) === event) watcher.pending.delete(sessionId)
      }
    }, (error: unknown) => {
      log.warn("a session event notice could not be delivered", { sessionId: watcherId, error: errorMessage(error) })
    }).finally(() => {
      watcher.delivering = false
      forgetIfDone(watcherId, watcher)
    })
  }

  return {
    watch(watcherSessionId, watchedSessionId) {
      let set = watchersOf.get(watchedSessionId)
      if (!set) watchersOf.set(watchedSessionId, set = new Set())
      set.add(watcherSessionId)
    },
    unwatch(watcherSessionId, watchedSessionId) {
      const set = watchersOf.get(watchedSessionId)
      set?.delete(watcherSessionId)
      if (set?.size === 0) watchersOf.delete(watchedSessionId)
      const watcher = watchers.get(watcherSessionId)
      if (!watcher) return
      watcher.pending.delete(watchedSessionId)
      forgetIfDone(watcherSessionId, watcher)
    },
    report(sessionId, kind) {
      const watching = watchersOf.get(sessionId)
      if (!watching) return
      const title = chatEntry(sessionId)?.description ?? ""
      for (const watcherId of watching) {
        if (!chatEntry(watcherId)?.runner) continue
        let watcher = watchers.get(watcherId)
        if (!watcher) watchers.set(watcherId, watcher = { pending: new Map(), delivering: false, held: false, workedSinceHold: false })
        watcher.pending.set(sessionId, { kind, title })
        offer(watcherId, watcher)
      }
    },
    dispose() {
      unsubscribe()
      watchersOf.clear()
      watchers.clear()
    },
  }
}
