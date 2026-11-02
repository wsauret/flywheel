/** The phone host's service worker: it exists so the installed app can
 *  receive Web Push while it is closed. A push carries the message the
 *  runtime sealed to this device's keys; the browser opened it before it got
 *  here. Tapping the notification opens the session it names, or focuses the
 *  app if it is already open. Nothing else lives here: no caching, no
 *  offline shell, because the client is useless without its runtime. */

// A module, so this declaration shadows the worker lib's narrower `self`.
export {} // oxlint-disable-line unicorn/require-module-specifiers -- boundary: the empty export is what makes this file a module
declare const self: ServiceWorkerGlobalScope

interface PushMessage {
  readonly title: string
  readonly body: string
  readonly url: string
  readonly tag?: string
}

const readMessage = (event: PushEvent): PushMessage => {
  const fallback: PushMessage = { title: "Flywheel", body: "Something needs you.", url: "/" }
  try {
    const parsed: unknown = event.data?.json()
    if (typeof parsed !== "object" || parsed === null) return fallback
    const record: { title?: unknown; body?: unknown; url?: unknown; tag?: unknown } = parsed
    return {
      title: typeof record.title === "string" ? record.title : fallback.title,
      body: typeof record.body === "string" ? record.body : fallback.body,
      url: typeof record.url === "string" ? record.url : fallback.url,
      ...(typeof record.tag === "string" ? { tag: record.tag } : {}),
    }
  } catch {
    return fallback
  }
}

self.addEventListener("install", () => {
  void self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener("push", (event) => {
  const message = readMessage(event)
  event.waitUntil(self.registration.showNotification(message.title, {
    body: message.body,
    icon: "/icon-192.png",
    data: { url: message.url },
    ...(message.tag === undefined ? {} : { tag: message.tag }),
  }))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const data: unknown = event.notification.data
  const url = typeof data === "object" && data !== null && "url" in data && typeof data.url === "string" ? data.url : "/"
  const destination = new URL(url, self.location.origin)
  // A fragment-only navigation keeps the old machine's document and client.
  destination.searchParams.set("notification", crypto.randomUUID())
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin)
    if (open) {
      try {
        await open.focus()
        // The bootstrap loads the addressed machine's matching client build.
        // Reusing this page's shell across machines can fail client admission.
        await open.navigate(destination.href)
        return
      } catch {
        // iOS can refuse focus for a suspended window. A new window still
        // delivers the tap to the exact address.
      }
    }
    await self.clients.openWindow(destination.href)
  })())
})

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    // A browser may supply the renewed subscription, or only the old options.
    if (!event.newSubscription && event.oldSubscription) await self.registration.pushManager.subscribe(event.oldSubscription.options)
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) client.postMessage({ type: "flywheel.push.changed" }) // oxlint-disable-line unicorn/require-post-message-target-origin -- boundary: Service Worker Client.postMessage has no targetOrigin argument
  })())
})
