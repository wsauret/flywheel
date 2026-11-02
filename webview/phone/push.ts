import { fromBase64Url, ownedBytes, toBase64Url } from "../../src/protocol/modules/remote/relay-protocol.js"
import type { PushHostCapability } from "../src/host.js"
import { detectBrowser } from "./install-guide.js"

/** The phone host's push capability: the service worker registration and the
 *  browser's push manager, offered to the client as a few typed calls. The
 *  client decides when to ask; the browser decides whether to grant; the
 *  runtime decides what to send. iOS grants push only to an installed web
 *  app, which is why the client's copy says to add it to the Home Screen. */

const OWNER_KEY = "flywheel.push.owner"

export function createPushCapability(): PushHostCapability {
  const available = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
  // Registration is lazy: a permission request must start in the tap, not after
  // service worker startup or an asynchronous subscription read.
  let registration: Promise<ServiceWorkerRegistration> | undefined
  const worker = () => {
    registration ??= navigator.serviceWorker.register("/sw.js").catch((error: unknown) => { registration = undefined; throw error })
    return registration
  }
  const owner = (key: string | undefined): string | undefined => {
    try {
      const stored = localStorage.getItem(OWNER_KEY)
      if (stored === null) return undefined
      const saved: unknown = JSON.parse(stored)
      if (typeof saved !== "object" || saved === null || !("key" in saved) || typeof saved.key !== "string" || !("runtimeId" in saved) || typeof saved.runtimeId !== "string") throw new TypeError("unreadable push owner")
      return saved.key === key ? saved.runtimeId : undefined
    } catch (error) {
      // oxlint-disable-next-line no-console -- boundary: the phone's non-authoritative owner metadata stays untouched until the next successful registration
      console.warn("push owner metadata unavailable", { errorName: error instanceof Error ? error.name : "UnknownError" })
      return undefined
    }
  }
  const toRecord = (subscription: PushSubscription): Awaited<ReturnType<PushHostCapability["current"]>> => {
    const json = subscription.toJSON()
    if (json.endpoint === undefined || json.keys?.p256dh === undefined || json.keys.auth === undefined) return undefined
    const key = subscription.options.applicationServerKey
    const applicationServerKey = key ? toBase64Url(new Uint8Array(key)) : undefined
    return { endpoint: json.endpoint, expirationTime: json.expirationTime ?? null, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth }, applicationServerKey, runtimeId: owner(applicationServerKey) }
  }
  return {
    state: () => available ? Notification.permission : "unavailable",
    settingsInstructions: detectBrowser(navigator).os === "ios"
      ? "Open Settings > Notifications > Flywheel > Allow Notifications."
      : "Allow them for Flywheel in this phone's settings.",
    async current() {
      if (!available) return undefined
      const existing = await (await worker()).pushManager.getSubscription()
      return existing ? toRecord(existing) : undefined
    },
    async subscribe(applicationServerKey, runtimeId) {
      if (!available) throw new Error("PushUnavailable")
      const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission()
      if (permission !== "granted") return undefined
      const manager = (await worker()).pushManager
      let subscription = await manager.getSubscription()
      const key = subscription?.options.applicationServerKey
      if (subscription && (!key || toBase64Url(new Uint8Array(key)) !== applicationServerKey)) {
        await subscription.unsubscribe()
        subscription = null
      }
      subscription ??= await manager.subscribe({ userVisibleOnly: true, applicationServerKey: ownedBytes(fromBase64Url(applicationServerKey)) })
      if (runtimeId !== undefined) {
        try { localStorage.setItem(OWNER_KEY, JSON.stringify({ key: applicationServerKey, runtimeId })) } catch {
          // Storage refusal loses only the name on a later move card.
        }
      }
      return toRecord(subscription)
    },
    async unsubscribe() {
      if (!available) return
      const existing = await (await worker()).pushManager.getSubscription()
      await existing?.unsubscribe()
    },
    onChange(listener) {
      const visible = () => { if (document.visibilityState === "visible") listener() }
      const message = (event: MessageEvent) => { if (event.data?.type === "flywheel.push.changed") listener() }
      document.addEventListener("visibilitychange", visible)
      if (available) navigator.serviceWorker.addEventListener("message", message)
      return () => {
        document.removeEventListener("visibilitychange", visible)
        if (available) navigator.serviceWorker.removeEventListener("message", message)
      }
    },
  }
}
