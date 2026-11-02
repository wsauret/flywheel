import { errorMessage } from "../../../infra/error-message.js"
import { Log } from "../../../infra/log.js"
import { sendWebPush, type WebPushMessage, type WebPushOutcome, type VapidKeys, type WebPushSubscription } from "../../../infra/web-push.js"
import type { FrontendEvent } from "../../../protocol/app-service-types.js"
import type { PushTarget } from "./remote-access.js"

const log = Log.create({ service: "remote-notifier" })

/** A phone is notified only when a chat waits on the person's answer
 *  (PI-REMOTE-015). Every subscribed phone gets it, attached or not, because
 *  iOS can suspend an attached page before the person sees the question. */

/** A question answered inside this window sends no push. */
const COALESCE_MS = 1_500

export interface RemoteNotifierOptions {
  readonly addListener: (listener: (event: FrontendEvent) => void) => void
  readonly removeListener: (listener: (event: FrontendEvent) => void) => void
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

interface SessionState {
  title: string
  questionId?: string
  timer?: ReturnType<typeof setTimeout>
}

export function createRemoteNotifier(options: RemoteNotifierOptions): RemoteNotifier {
  const send = options.send ?? sendWebPush
  const sessions = new Map<string, SessionState>()
  const deliveries = new Set<Promise<void>>()
  const controller = new AbortController()
  let disposed = false
  let closing: Promise<void> | undefined

  const stateOf = (sessionId: string): SessionState => {
    let state = sessions.get(sessionId)
    if (!state) {
      state = { title: "Flywheel" }
      sessions.set(sessionId, state)
    }
    return state
  }

  async function deliver(sessionId: string, questionId: string): Promise<void> {
    if (disposed) return
    const targets = options.targets()
    if (targets.length === 0) return
    const address = await options.address()
    const state = sessions.get(sessionId)
    if (disposed || !state || state.questionId !== questionId) return
    const fragment = new URLSearchParams({ runtime: address.runtimeId, placement: address.placementId, session: sessionId, attention: "question" })
    const message: WebPushMessage = {
      title: `Flywheel has a question · ${address.machine} · ${address.project}`,
      body: state.title,
      url: `${options.appOrigin}/#${fragment}`,
      tag: `${sessionId}:${questionId}`,
    }
    await Promise.all(targets.map(async (target) => {
      try {
        const outcome = await send({ subscription: target.subscription, vapid: target.vapid, subject: options.subject, message, signal: controller.signal })
        if (disposed) return
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
  }

  const cancel = (state: SessionState): void => {
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
  }

  const listener = (event: FrontendEvent): void => {
    if (disposed) return
    if (event.type !== "patch" || event.patch.cursor.scope !== "session") return
    const sessionId = event.patch.cursor.sessionId
    const { payload } = event.patch
    if (payload.kind === "session.removed") {
      const state = sessions.get(sessionId)
      if (state) cancel(state)
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
    const timer = setTimeout(() => {
      state.timer = undefined
      if (disposed) return
      const delivery = deliver(sessionId, questionId)
      deliveries.add(delivery)
      void delivery.then(() => { deliveries.delete(delivery) }, (error: unknown) => {
        deliveries.delete(delivery)
        if (!disposed) log.warn("push delivery failed", { error: errorMessage(error) })
      })
    }, options.coalesceMs ?? COALESCE_MS)
    timer.unref?.()
    state.timer = timer
  }

  options.addListener(listener)
  return {
    dispose() {
      if (closing) return closing
      disposed = true
      controller.abort()
      options.removeListener(listener)
      for (const state of sessions.values()) cancel(state)
      sessions.clear()
      closing = Promise.allSettled(deliveries).then(() => {})
      return closing
    },
  }
}
