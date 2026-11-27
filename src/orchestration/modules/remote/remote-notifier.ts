import { errorMessage } from "../../../infra/diagnostics/error-message.js"
import { Log } from "../../../infra/diagnostics/log.js"
import { sendWebPush, type WebPushMessage, type WebPushOutcome, type VapidKeys, type WebPushSubscription } from "../../../infra/substrate/output/notify/web-push.js"
import { stopNoticeLine } from "../../../protocol/client/chat/desktop-pages.js"
import type { FrontendEvent } from "../../../protocol/runtime/app-service-types.js"
import type { RuntimeUnreadChatsSnapshotResult, StoppedChat } from "../../../protocol/session/unread-protocol-types.js"
import type { PushTarget } from "./remote-access.js"

const log = Log.create({ service: "remote-notifier" })

/** A phone is notified when a chat waits on the person's answer and when a
 *  chat stops for the person unread (PI-REMOTE-015). Every subscribed phone
 *  gets it, attached or not, because iOS can suspend an attached page before
 *  the person sees it. */

/** A question answered, or a stop read, inside this window sends no push. */
const COALESCE_MS = 1_500

export interface RemoteNotifierOptions {
  readonly addListener: (listener: (event: FrontendEvent) => void) => void
  readonly removeListener: (listener: (event: FrontendEvent) => void) => void
  /** Reads the project's set of stopped unread chats. The notifier reads it
   *  once to start the set, which publishes nothing until something reads
   *  it; a push comes only from a stop that a live patch announces. */
  readonly readUnreadChats: () => Promise<RuntimeUnreadChatsSnapshotResult>
  readonly targets: () => readonly PushTarget[]
  readonly forgetSubscription: (deviceId: string, subscription: PushTarget["subscription"]) => Promise<void>
  /** Where a tapped notification opens; the address joins as a fragment. */
  readonly appOrigin: string
  readonly address: () => Promise<{ readonly runtimeId: string; readonly placementId: string; readonly machine: string; readonly project: string }>
  /** The VAPID subject: who a push service may contact about this sender. */
  readonly subject: string
  readonly send?: (input: { subscription: WebPushSubscription; vapid: VapidKeys; subject: string; message: WebPushMessage; signal: AbortSignal }) => Promise<WebPushOutcome>
  readonly coalesceMs?: number
}

export interface RemoteNotifier {
  /** Stops delivery admission, aborts transport work, and joins admitted delivery and storage work. */
  dispose(): Promise<void>
}

type PushKind = "question" | "stop"

interface SessionState {
  title?: string
  questionId?: string
  timer?: ReturnType<typeof setTimeout>
}

/** A stop push that waits for its delay or its address. */
interface StopPush {
  readonly stopKey: string
  readonly timer: ReturnType<typeof setTimeout>
}

export function createRemoteNotifier(options: RemoteNotifierOptions): RemoteNotifier {
  const send = options.send ?? sendWebPush
  const sessions = new Map<string, SessionState>()
  /** The stop pushes still on their way, one for each chat. */
  const stopPushes = new Map<string, StopPush>()
  const deliveries = new Set<Promise<void>>()
  const controller = new AbortController()
  const delay = options.coalesceMs ?? COALESCE_MS
  let disposed = false
  let closing: Promise<void> | undefined

  const stateOf = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId)
    if (!state) {
      state = {}
      sessions.set(sessionId, state)
    }
    return state
  }

  async function deliver(sessionId: string, kind: PushKind, message: WebPushMessage): Promise<void> {
    const targets = options.targets()
    let delivered = 0
    await Promise.all(targets.map(async (target) => {
      try {
        const outcome = await send({ subscription: target.subscription, vapid: target.vapid, subject: options.subject, message, signal: controller.signal })
        if (disposed) return
        if (outcome.kind === "delivered") delivered += 1
        if (outcome.kind === "gone") {
          log.info("push subscription reported gone", { device: target.deviceId })
          await options.forgetSubscription(target.deviceId, target.subscription)
        } else if (outcome.kind === "failed") {
          log.warn("push delivery failed", { device: target.deviceId, status: outcome.status, detail: outcome.detail })
        }
      } catch (error) {
        if (!disposed) log.warn("push delivery threw", { device: target.deviceId, error: errorMessage(error) })
      }
    }))
    // Each failed device is recorded above; this is the one record of the decision.
    if (!disposed) log.info("push sent", { sessionId, kind, tag: message.tag, delivered, notDelivered: targets.length - delivered })
  }

  async function messageFor(sessionId: string, kind: PushKind, body: string, tag: string): Promise<WebPushMessage> {
    const address = await options.address()
    const fragment = new URLSearchParams({ runtime: address.runtimeId, placement: address.placementId, session: sessionId, ...(kind === "question" ? { attention: "question" } : {}) })
    return {
      title: `${kind === "question" ? "Flywheel has a question" : "Flywheel"} · ${address.machine} · ${address.project}`,
      body,
      url: `${options.appOrigin}/#${fragment}`,
      tag,
    }
  }

  /** After the coalescing delay, sends the push that `current` builds, or
   *  none when `current` finds, once the address is read, that the person no
   *  longer needs it. */
  function admit(sessionId: string, kind: PushKind, current: () => Promise<WebPushMessage | undefined>): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const state = sessions.get(sessionId)
      if (state && kind === "question") state.timer = undefined
      if (disposed) return
      const delivery = (async () => {
        if (options.targets().length === 0) return
        const message = await current()
        if (disposed) return
        if (message) await deliver(sessionId, kind, message)
        else log.info("push suppressed", { sessionId, kind })
      })()
      deliveries.add(delivery)
      void delivery.then(() => { deliveries.delete(delivery) }, (error: unknown) => {
        deliveries.delete(delivery)
        if (!disposed) log.warn("push delivery failed", { error: errorMessage(error) })
      })
    }, delay)
    timer.unref?.()
    return timer
  }

  const cancel = (state: SessionState): void => {
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
  }

  const cancelStop = (sessionId: string): void => {
    const push = stopPushes.get(sessionId)
    if (push) clearTimeout(push.timer)
    stopPushes.delete(sessionId)
  }

  /** Pushes, after the coalescing delay, for a stop that a patch announced. */
  function pushStop(chat: StoppedChat): void {
    const { sessionId, stopKey } = chat
    cancelStop(sessionId)
    const pending: StopPush = {
      stopKey,
      timer: admit(sessionId, "stop", async (): Promise<WebPushMessage | undefined> => {
        const message = await messageFor(sessionId, "stop", stopNoticeLine(chat, sessions.get(sessionId)?.title), `${sessionId}:stop:${stopKey}`)
        // The person read the chat, or a new turn started, before it went out.
        return stopPushes.get(sessionId) === pending ? message : undefined
      }),
    }
    stopPushes.set(sessionId, pending)
  }

  /** A stop that leaves the set is read or replaced: its push is dropped,
   *  also one already reading its address, so a stop that a later mark
   *  unread returns to the set sends none. */
  function onStoppedChats(payload: Extract<Extract<FrontendEvent, { type: "patch" }>["patch"]["payload"], { kind: "unreadChats.changed" }>): void {
    for (const [sessionId, { stopKey }] of stopPushes) {
      if (!payload.stopped.some((chat) => chat.sessionId === sessionId && chat.stopKey === stopKey)) cancelStop(sessionId)
    }
    for (const chat of payload.newStops) pushStop(chat)
  }

  function onSessionPatch(sessionId: string, payload: Extract<FrontendEvent, { type: "patch" }>["patch"]["payload"]): void {
    if (payload.kind === "session.removed") {
      const state = sessions.get(sessionId)
      if (state) cancel(state)
      cancelStop(sessionId)
      sessions.delete(sessionId)
      return
    }
    const state = stateOf(sessionId)
    if (payload.kind === "session.added" || payload.kind === "session.updated") state.title = payload.row.title
    if (payload.kind === "question.removed") {
      state.questionId = undefined
      cancel(state)
      return
    }
    if (payload.kind !== "question.updated" || state.questionId === payload.question.toolUseId) return
    const questionId = payload.question.toolUseId
    state.questionId = questionId
    cancel(state)
    state.timer = admit(sessionId, "question", async () => {
      const message = await messageFor(sessionId, "question", sessions.get(sessionId)?.title ?? "Flywheel", `${sessionId}:${questionId}`)
      return sessions.get(sessionId)?.questionId === questionId ? message : undefined
    })
  }

  const listener = (event: FrontendEvent): void => {
    if (disposed || event.type !== "patch") return
    const { cursor, payload } = event.patch
    if (cursor.scope === "session") {
      onSessionPatch(cursor.sessionId, payload)
      return
    }
    if (payload.kind === "unreadChats.changed") onStoppedChats(payload)
  }

  options.addListener(listener)
  options.readUnreadChats().catch((error: unknown) => {
    if (!disposed) log.warn("unread chats not read; a stop pushes only once a client reads them", { error: errorMessage(error) })
  })
  return {
    dispose() {
      if (closing) return closing
      disposed = true
      controller.abort()
      options.removeListener(listener)
      for (const state of sessions.values()) {
        cancel(state)
      }
      for (const sessionId of stopPushes.keys()) cancelStop(sessionId)
      sessions.clear()
      closing = Promise.allSettled(deliveries).then(() => {})
      return closing
    },
  }
}
