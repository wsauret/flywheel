import { expect, test } from "bun:test"

test("the phone worker routes notification taps with focus recovery and reports renewed subscriptions", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "self")
  const handlers = new Map<string, (event: unknown) => void>()
  const navigated: string[] = []
  const opened: string[] = []
  const renewed: unknown[] = []
  const messages: unknown[] = []
  let refuseFocus = false
  Object.defineProperty(globalThis, "self", { configurable: true, value: {
    location: { origin: "https://phone.test" },
    addEventListener: (type: string, listener: (event: unknown) => void) => handlers.set(type, listener),
    registration: { pushManager: { subscribe: async (options: unknown) => { renewed.push(options) } } },
    clients: {
      matchAll: async () => [{ url: "https://phone.test/", focus: async () => { if (refuseFocus) throw new DOMException("not focused", "InvalidStateError") }, navigate: async (url: string) => { navigated.push(url) }, postMessage: (message: unknown) => { messages.push(message) } }],
      openWindow: async (url: string) => { opened.push(url) },
    },
  } })
  try {
    await import("./sw.js")
    const click = async () => {
      let finished = Promise.resolve()
      handlers.get("notificationclick")?.({ notification: { data: { url: "https://phone.test/#runtime=m&placement=p&session=s&attention=question" }, close() {} }, waitUntil: (work: Promise<void>) => { finished = work } })
      await finished
    }
    await click()
    const destination = new URL(navigated[0]!)
    expect(destination.origin).toBe("https://phone.test")
    expect(destination.searchParams.get("notification")).toBeTruthy()
    expect(destination.hash).toBe("#runtime=m&placement=p&session=s&attention=question")
    expect(opened).toEqual([])
    refuseFocus = true
    await click()
    expect(new URL(opened[0]!).searchParams.get("notification")).toBeTruthy()
    expect(new URL(opened[0]!).search).not.toBe(destination.search)
    expect(new URL(opened[0]!).hash).toBe(destination.hash)
    const renew = async (newSubscription?: unknown) => {
      let finished = Promise.resolve()
      handlers.get("pushsubscriptionchange")?.({ oldSubscription: { options: { applicationServerKey: "old-key", userVisibleOnly: true } }, newSubscription, waitUntil: (work: Promise<void>) => { finished = work } })
      await finished
    }
    await renew()
    await renew({ endpoint: "https://push.test/new" })
    expect(renewed).toEqual([{ applicationServerKey: "old-key", userVisibleOnly: true }])
    expect(messages).toEqual([{ type: "flywheel.push.changed" }, { type: "flywheel.push.changed" }])
  } finally {
    if (original) Object.defineProperty(globalThis, "self", original)
    else Reflect.deleteProperty(globalThis, "self")
  }
})
