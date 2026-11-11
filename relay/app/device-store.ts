import type { DeviceRecord, DeviceStore, PairedRuntime, RemoteSelection } from "../../src/protocol/modules/remote/relay-device.js"
import { keyDigest } from "../../src/protocol/modules/remote/relay-protocol.js"
import type { CarriedDevice } from "./install-carry.js"

/** What this phone remembers, kept by the hosted page because it must outlive
 *  every client build: its own key, the name it pairs under, the machines it
 *  has paired with, and which project it last opened. The page hands the
 *  opened store to the phone shell it loads (`phone-bootstrap.ts`).
 *
 *  IndexedDB rather than localStorage because it holds `CryptoKey` objects.
 *  The browser's key is extractable so that the page can carry it into the
 *  app the person adds to the Home Screen (`install-carry.ts`); the installed
 *  app imports it non-extractable. Clearing site data unpairs the phone, and
 *  the client says so. */

const DB_NAME = "flywheel-remote"
const DB_VERSION = 1
const STORE = "state"

function request<T>(target: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    target.addEventListener("success", () => resolve(target.result), { once: true })
    target.addEventListener("error", () => reject(target.error ?? new Error("IndexedDB request failed")), { once: true })
  })
}

/** Resolves when the transaction has committed. A request's success fires
 *  before that, so a write that resolved on success could still be lost, and
 *  a page that loads at once could read the value from before it. */
function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true })
    // A failed request aborts its transaction, so the abort carries every failure.
    transaction.addEventListener("abort", () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")), { once: true })
  })
}

function openDatabase(): Promise<IDBDatabase> {
  const opening = indexedDB.open(DB_NAME, DB_VERSION)
  opening.addEventListener("upgradeneeded", () => {
    if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE)
  })
  return request(opening)
}

/** A phone's first name is what it is, which is all a browser can tell; the
 *  person can name it before pairing. */
function defaultLabel(): string {
  const agent = navigator.userAgent
  if (/iPhone/.test(agent)) return "iPhone"
  if (/iPad/.test(agent)) return "iPad"
  if (/Android/.test(agent)) return "Android phone"
  if (/Macintosh/.test(agent)) return "Mac browser"
  return "Browser"
}

/** Called once a `putRuntime` has committed, with the runtime written and the
 *  one with its id that it replaced. */
type RuntimePutListener = (runtime: PairedRuntime, previous: PairedRuntime | undefined) => void

/** The store as the page holds it. The page tells of every write a shell
 *  makes, also a shell from an older build, because the shell receives this
 *  same object; the notification is the page's own and not part of the
 *  `DeviceStore` contract. */
export interface PageDeviceStore extends DeviceStore {
  onRuntimePut(listener: RuntimePutListener): void
}

/** Opens the store. `carried` is the identity an installed app's start URL
 *  carries; it fills a store that has no key yet and is ignored otherwise,
 *  so it never replaces a device or what the app changed since. */
export async function openDeviceStore(carried?: CarriedDevice): Promise<PageDeviceStore> {
  const db = await openDatabase()
  const read = async <T>(key: string): Promise<T | undefined> => request<T | undefined>(db.transaction(STORE, "readonly").objectStore(STORE).get(key))
  // Async so that a synchronous IndexedDB throw, such as on a closed
  // connection, becomes a rejection that a caller which does not await can ignore.
  const write = async (key: string, value: unknown): Promise<void> => {
    const transaction = db.transaction(STORE, "readwrite")
    transaction.objectStore(STORE).put(value, key)
    await committed(transaction)
  }

  let keyPair = await read<CryptoKeyPair>("device-key")
  if (keyPair === undefined && carried !== undefined) {
    // The key goes last: a launch that stops between the writes finds no key
    // and imports the carry again.
    await write("runtimes", carried.runtimes)
    await write("device-label", carried.label)
    await write("device-key", carried.keyPair)
    keyPair = carried.keyPair
  } else if (keyPair === undefined) {
    // Extractable, so that the page can carry it into the installed app
    // (PI-REMOTE-032). A key stored before keys were extractable stays as it
    // is, because a new key would unpair the phone; that browser carries
    // nothing, and its installed app pairs once, in the app.
    const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
    if (!("privateKey" in generated)) throw new Error("expected an asymmetric key pair")
    keyPair = generated
    await write("device-key", keyPair)
  }
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
  const storedLabel = await read<string>("device-label")
  let label = storedLabel ?? defaultLabel()
  if (storedLabel === undefined) await write("device-label", label)
  const device: DeviceRecord = { keyPair, deviceId: await keyDigest(publicKey), publicKey }
  const runtimeListeners = new Set<RuntimePutListener>()

  return {
    device,
    label: () => label,
    async setLabel(next) {
      const trimmed = next.trim()
      if (trimmed.length === 0 || trimmed === label) return
      await write("device-label", trimmed)
      label = trimmed
    },
    runtimes: async () => (await read<readonly PairedRuntime[]>("runtimes")) ?? [],
    async putRuntime(runtime) {
      const current = (await read<readonly PairedRuntime[]>("runtimes")) ?? []
      await write("runtimes", [...current.filter((existing) => existing.runtimeId !== runtime.runtimeId), runtime])
      const previous = current.find((existing) => existing.runtimeId === runtime.runtimeId)
      for (const listener of runtimeListeners) listener(runtime, previous)
    },
    async removeRuntime(runtimeId) {
      const current = (await read<readonly PairedRuntime[]>("runtimes")) ?? []
      await write("runtimes", current.filter((existing) => existing.runtimeId !== runtimeId))
    },
    selection: () => read<RemoteSelection>("selection"),
    setSelection: (selection) => write("selection", selection),
    onRuntimePut: (listener) => { runtimeListeners.add(listener) },
  }
}
