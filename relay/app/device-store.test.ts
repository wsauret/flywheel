import { afterEach, beforeEach, expect, test } from "bun:test"

import { deviceIdentity } from "../../src/protocol/modules/remote/relay-device.js"
import { openDeviceStore } from "./device-store.js"
import { installManifestHref, readInstallCarry } from "./install-carry.js"

/** The part of IndexedDB the store uses, with the order a browser keeps: a
 *  request's success fires before its transaction commits, and a transaction
 *  commits only after its last request. The test decides when a read-write
 *  transaction commits or aborts. */
class FakeRequest extends EventTarget {
  result: unknown
  error: DOMException | null = null
  succeed(result: unknown) {
    this.result = result
    setTimeout(() => this.dispatchEvent(new Event("success")), 0)
  }
}

class FakeTransaction extends EventTarget {
  error: DOMException | null = null
  readonly writes = new Map<string, unknown>()
  constructor(private readonly data: Map<string, unknown>) { super() }
  objectStore() {
    return {
      get: (key: string) => {
        const request = new FakeRequest()
        request.succeed(this.data.get(key))
        return request
      },
      put: (value: unknown, key: string) => {
        this.writes.set(key, value)
        const request = new FakeRequest()
        request.succeed(key)
        return request
      },
    }
  }
  commit() {
    for (const [key, value] of this.writes) this.data.set(key, value)
    this.dispatchEvent(new Event("complete"))
  }
  abort(error: DOMException) {
    this.error = error
    this.dispatchEvent(new Event("abort"))
  }
}

function fakeIndexedDb() {
  const data = new Map<string, unknown>()
  const held: FakeTransaction[] = []
  let holding = false
  let closed = false
  const database = {
    objectStoreNames: { contains: () => true },
    createObjectStore() {},
    transaction(_store: string, mode: "readonly" | "readwrite") {
      // A browser throws here, not in a request, once the connection closes.
      if (closed) throw new DOMException("The database connection is closing.", "InvalidStateError")
      const transaction = new FakeTransaction(data)
      if (mode === "readwrite") {
        if (holding) held.push(transaction)
        // A transaction commits after its requests have answered.
        else setTimeout(() => transaction.commit(), 5)
      }
      return transaction
    },
  }
  return {
    data,
    held,
    hold: () => { holding = true },
    close: () => { closed = true },
    factory: {
      open() {
        const request = new FakeRequest()
        request.succeed(database)
        return request
      },
    },
  }
}

let previous: PropertyDescriptor | undefined
let fake: ReturnType<typeof fakeIndexedDb>

beforeEach(() => {
  previous = Object.getOwnPropertyDescriptor(globalThis, "indexedDB")
  fake = fakeIndexedDb()
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fake.factory })
})

afterEach(() => {
  if (previous) Object.defineProperty(globalThis, "indexedDB", previous)
  else Reflect.deleteProperty(globalThis, "indexedDB")
})

const settle = () => new Promise((resolve) => { setTimeout(resolve, 20) })

test("a write resolves only once its transaction has committed, so a page loaded after it reads the new value", async () => {
  const store = await openDeviceStore()
  fake.hold()
  let resolved = false
  const writing = store.setSelection({ runtimeId: "desk", placementId: "p2" }).then(() => { resolved = true })
  await settle()
  // The put has answered, but nothing is on disk yet.
  expect(resolved).toBe(false)
  fake.held[0]?.commit()
  await writing
  expect(fake.data.get("selection")).toEqual({ runtimeId: "desk", placementId: "p2" })
})

test("the page hears of a machine written to the store once the write has committed, with the entry it replaced", async () => {
  const store = await openDeviceStore()
  const heard: unknown[] = []
  store.onRuntimePut((runtime, replaced) => heard.push({ runtime: runtime.label, previous: replaced?.label }))
  fake.hold()
  const writing = store.putRuntime(DESK)
  await settle()
  expect(heard).toEqual([])
  fake.held[0]?.commit()
  await writing
  expect(heard).toEqual([{ runtime: "Desk", previous: undefined }])

  const renaming = store.putRuntime({ ...DESK, label: "Studio desk" })
  await settle()
  fake.held[1]?.abort(new DOMException("The quota was exceeded.", "QuotaExceededError"))
  await expect(renaming).rejects.toThrow("The quota was exceeded.")
  expect(heard).toHaveLength(1)
  const renamed = store.putRuntime({ ...DESK, label: "Studio desk" })
  await settle()
  fake.held[2]?.commit()
  await renamed
  expect(heard.at(-1)).toEqual({ runtime: "Studio desk", previous: "Desk" })
})

test("a write whose transaction aborts fails with the transaction's error", async () => {
  const store = await openDeviceStore()
  fake.hold()
  const writing = store.setLabel("Kitchen iPad")
  await settle()
  fake.held[0]?.abort(new DOMException("The quota was exceeded.", "QuotaExceededError"))
  await expect(writing).rejects.toThrow("The quota was exceeded.")
  // The store keeps the name it had, because the new one never committed.
  expect(store.label()).not.toBe("Kitchen iPad")
})

/** The fragment of the start URL that the browser's page puts in its manifest. */
async function carriedFragment(): Promise<string> {
  const href = await installManifestHref("https://remote.flywl.sh", await openDeviceStore())
  return new URL(JSON.parse(decodeURIComponent(href.slice(href.indexOf(",") + 1))).start_url).hash
}

const DESK = { runtimeId: "desk", publicKey: "key-desk", relay: "wss://relay.flywl.sh", label: "Desk", pairedAt: 1 }

test("an installed app opens the carry its browser put in the start URL as the same device, with the same machines and name", async () => {
  const browser = await openDeviceStore()
  await browser.setLabel("Kitchen iPad")
  await browser.putRuntime(DESK)
  const fragment = await carriedFragment()

  // The installed app starts with empty storage.
  fake = fakeIndexedDb()
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fake.factory })
  const app = await openDeviceStore(await readInstallCarry(fragment))
  expect(app.device.deviceId).toBe(browser.device.deviceId)
  expect(await app.runtimes()).toEqual([DESK])
  expect(app.label()).toBe("Kitchen iPad")
  expect(app.device.keyPair.privateKey.extractable).toBe(false)
  const signature = await deviceIdentity(app.device).sign(new Uint8Array([1, 2, 3]))
  expect(await crypto.subtle.verify("Ed25519", browser.device.keyPair.publicKey, new Uint8Array(signature), new Uint8Array([1, 2, 3]))).toBe(true)
})

// iOS keeps the start URL's fragment on every launch of the installed app.
test("a store that already has a key ignores a carry, so a carry never replaces a device or its machines", async () => {
  const browser = await openDeviceStore()
  await browser.putRuntime(DESK)
  const fragment = await carriedFragment()

  fake = fakeIndexedDb()
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: fake.factory })
  const own = await openDeviceStore()
  const reopened = await openDeviceStore(await readInstallCarry(fragment))
  expect(reopened.device.deviceId).toBe(own.device.deviceId)
  expect(reopened.device.deviceId).not.toBe(browser.device.deviceId)
  expect(await reopened.runtimes()).toEqual([])
})

test("a write on a closed connection fails as a rejected promise, so a caller that does not await it still runs", async () => {
  const store = await openDeviceStore()
  // iOS Safari can close the connection while the page is in the background.
  fake.close()
  let writing: Promise<void> | undefined
  expect(() => { writing = store.setSelection({ runtimeId: "desk", placementId: "p2" }) }).not.toThrow()
  await expect(writing).rejects.toThrow("The database connection is closing.")
})
