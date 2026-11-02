import { expect, test } from "bun:test"
import { createPushCapability } from "./push.js"

test("the phone replaces a subscription for another VAPID key, records its owner, and reuses it without prompting again", async () => {
  const originals = new Map(["navigator", "window", "Notification", "localStorage"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  const values = new Map<string, string>()
  const requested: unknown[] = []
  let permission: NotificationPermission = "default"
  let prompts = 0
  let unsubscribed = 0
  let registrations = 0
  const subscription = (key: Uint8Array) => ({
    options: { applicationServerKey: key.buffer },
    toJSON: () => ({ endpoint: "https://push.test/phone", keys: { p256dh: "p256dh", auth: "auth" } }),
    unsubscribe: async () => { unsubscribed++; return true },
  })
  let current = subscription(new Uint8Array([4, 5, 6]))
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { serviceWorker: { register: async () => { registrations++; return { pushManager: { getSubscription: async () => current, subscribe: async (options: unknown) => { requested.push(options); current = subscription(new Uint8Array([1, 2, 3])); return current } } } } } } })
  Object.defineProperty(globalThis, "window", { configurable: true, value: { PushManager: {}, Notification: {} } })
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: { get permission() { return permission }, requestPermission: async () => { prompts++; permission = "granted"; return permission } } })
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } })
  try {
    const capability = createPushCapability()
    const enabling = capability.subscribe("AQID", "studio")
    expect(prompts).toBe(1)
    expect(registrations).toBe(0)
    expect(await enabling).toMatchObject({ endpoint: "https://push.test/phone" })
    expect(unsubscribed).toBe(1)
    expect(requested).toEqual([{ userVisibleOnly: true, applicationServerKey: new Uint8Array([1, 2, 3]) }])
    expect(await capability.current()).toMatchObject({ applicationServerKey: "AQID", runtimeId: "studio" })
    await capability.subscribe("AQID", "studio")
    expect(prompts).toBe(1)
    expect(requested).toHaveLength(1)
  } finally {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})
