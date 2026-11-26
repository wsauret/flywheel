import type { DeviceRecord, DeviceStore, PairedRuntime, RemoteSelection } from "../../src/protocol/modules/remote/relay-device.js"
import { keyDigest } from "../../src/protocol/modules/remote/relay-protocol.js"
import type { CarriedDevice } from "./install-carry.js"

/** What this phone remembers, kept by the hosted page because it must outlive
 *  every client build: its own key, the name it pairs under, the machines it
 *  has paired with, and which project it last opened. The page hands the
 *  opened store to the phone shell it loads (`phone-bootstrap.ts`).
 *
 *  A phone that never pairs keeps nothing: its first pairing makes the key
 *  and records the name, unless the person named the phone before.
 *
 *  IndexedDB rather than localStorage because it holds `CryptoKey` objects.
 *  The browser's key is extractable so that the page can carry it into the
 *  app the person adds to the Home Screen (`install-carry.ts`); the installed
 *  app imports it non-extractable. Clearing site data unpairs the phone, and
 *  the client says so. */

const DB_NAME = "flywheel-remote"
const DB_VERSION = 1
const STORE = "state"

/** The value that the store keeps under each key. */
interface StoredValues {
  readonly "device-key": CryptoKeyPair
  readonly "device-label": string
  readonly runtimes: readonly PairedRuntime[]
  readonly selection: RemoteSelection | undefined
}

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
 *  makes, also a shell from an older build, because the shell's store writes
 *  through this one; the notification is the page's own and not part of the
 *  `DeviceStore` contract. */
export interface PageDeviceStore extends Omit<DeviceStore, "device"> {
  /** The device's key, undefined until this phone first pairs. */
  readonly device: DeviceRecord | undefined
  /** The device's key as it is stored now, also one that another tab of
   *  this phone stored after this store opened; undefined when the phone has
   *  never paired. It never makes a key. */
  committedDevice(): Promise<DeviceRecord | undefined>
  /** The device's key, made and stored first when the phone has none. A
   *  pairing calls it. A key that another tab stored first wins, so two tabs
   *  never give the phone two keys. */
  ensureDevice(): Promise<DeviceRecord>
  onRuntimePut(listener: RuntimePutListener): void
}

async function deviceRecord(keyPair: CryptoKeyPair): Promise<DeviceRecord> {
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey))
  return { keyPair, deviceId: await keyDigest(publicKey), publicKey }
}

/** Opens the store. `carried` is the identity an installed app's start URL
 *  carries; it fills a store that has no key yet and is ignored otherwise,
 *  so it never replaces a device or what the app changed since. */
export async function openDeviceStore(carried?: CarriedDevice): Promise<PageDeviceStore> {
  const db = await openDatabase()
  const read = async <Key extends keyof StoredValues>(key: Key): Promise<StoredValues[Key] | undefined> => request<StoredValues[Key] | undefined>(db.transaction(STORE, "readonly").objectStore(STORE).get(key))
  // Async so that a synchronous IndexedDB throw, such as on a closed
  // connection, becomes a rejection that a caller which does not await can ignore.
  const write = async <Key extends keyof StoredValues>(key: Key, value: StoredValues[Key]): Promise<void> => {
    const transaction = db.transaction(STORE, "readwrite")
    transaction.objectStore(STORE).put(value, key)
    await committed(transaction)
  }

  let keyPair = await read("device-key")
  if (keyPair === undefined && carried !== undefined) {
    // The key goes last: a launch that stops between the writes finds no key
    // and imports the carry again.
    await write("runtimes", carried.runtimes)
    await write("device-label", carried.label)
    await write("device-key", carried.keyPair)
    keyPair = carried.keyPair
  }
  let device = keyPair === undefined ? undefined : await deviceRecord(keyPair)
  let label = (await read("device-label")) ?? defaultLabel()
  const runtimeListeners = new Set<RuntimePutListener>()

  return {
    get device() { return device },
    async committedDevice() {
      if (device !== undefined) return device
      const stored = await read("device-key")
      if (stored !== undefined) device = await deviceRecord(stored)
      return device
    },
    async ensureDevice() {
      if (device !== undefined) return device
      // Extractable, so that the page can carry it into the installed app
      // (PI-REMOTE-032). A key stored before keys were extractable stays as
      // it is, because a new key would unpair the phone; that browser carries
      // nothing, and its installed app pairs once, in the app. Made before
      // the transaction, which an await on anything but its own requests
      // would commit.
      const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])
      if (!("privateKey" in generated)) throw new Error("expected an asymmetric key pair")
      // One transaction reads and writes, so a key or a name that another tab
      // stored first is kept. The machine lists the phone under the name it
      // paired with, so that name stays when the browser later describes
      // itself differently.
      const transaction = db.transaction(STORE, "readwrite")
      const state = transaction.objectStore(STORE)
      let kept: CryptoKeyPair = generated
      const storedKey = state.get("device-key")
      storedKey.addEventListener("success", () => {
        if (storedKey.result === undefined) state.put(generated, "device-key")
        else kept = storedKey.result
      }, { once: true })
      const storedLabel = state.get("device-label")
      storedLabel.addEventListener("success", () => {
        if (storedLabel.result === undefined) state.put(label, "device-label")
        else label = storedLabel.result
      }, { once: true })
      await committed(transaction)
      device = await deviceRecord(kept)
      return device
    },
    label: () => label,
    async setLabel(next) {
      const trimmed = next.trim()
      if (trimmed.length === 0 || trimmed === label) return
      await write("device-label", trimmed)
      label = trimmed
    },
    runtimes: async () => (await read("runtimes")) ?? [],
    async putRuntime(runtime) {
      const current = (await read("runtimes")) ?? []
      await write("runtimes", [...current.filter((existing) => existing.runtimeId !== runtime.runtimeId), runtime])
      const previous = current.find((existing) => existing.runtimeId === runtime.runtimeId)
      for (const listener of runtimeListeners) listener(runtime, previous)
    },
    async removeRuntime(runtimeId) {
      const current = (await read("runtimes")) ?? []
      await write("runtimes", current.filter((existing) => existing.runtimeId !== runtimeId))
    },
    selection: () => read("selection"),
    setSelection: (selection) => write("selection", selection),
    onRuntimePut: (listener) => { runtimeListeners.add(listener) },
  }
}
