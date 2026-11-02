import { hostname } from "node:os"
import { Redacted, Schema } from "effect"

import { mutateLockedJsonStore, readLockedJsonStore, type LockedJsonStoreOptions } from "../../../infra/auth/locked-json-store.js"
import { accountAuthDir, accountSecretFile, TERMINAL_DEVICE_STORE_FILE, terminalDeviceStoreFile } from "../../../infra/paths.js"
import type { DeviceStore, PairedRuntime, RemoteSelection } from "../../../protocol/modules/remote/relay-device.js"
import { asKeyPair, fromBase64Url, keyDigest, ownedBytes, toBase64Url } from "../../../protocol/modules/remote/relay-protocol.js"

/** The terminal's device store: what a terminal on another machine remembers
 *  as a paired device (PI-REMOTE-016), the terminal's half of the contract
 *  the shared relay client reads through (`relay-device.ts`).
 *
 *  It is account state, kept beside `auth.json` under the same locked,
 *  contained, owner-only file discipline (0600 on POSIX, an owner-only ACL on
 *  Windows), because the device key is a credential: whoever holds it attaches
 *  as this terminal to every machine it paired with. The private key is
 *  `Redacted` from the moment it is decoded and is imported as a
 *  non-extractable key; the one place it is in the clear is `toPersisted`,
 *  this store's serialization boundary.
 *
 *  Format version 1 is the first: earlier releases kept no terminal device
 *  store, so no earlier shape exists to convert. A file this build cannot
 *  read, such as one a later release wrote, is refused with a message and
 *  never rewritten. */

const Base64Url = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+$/))
const PairedMachineSchema = Schema.Struct({
  runtimeId: Base64Url,
  publicKey: Base64Url,
  relay: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  pairedAt: Schema.Number,
})
const PersistedDeviceStoreSchema = Schema.Struct({
  version: Schema.Literal(1),
  device: Schema.Struct({ publicKey: Base64Url, privateKey: Base64Url }),
  /** Absent until the person names the device; the host name applies. */
  label: Schema.optionalKey(Schema.NonEmptyString),
  machines: Schema.Array(PairedMachineSchema),
  selection: Schema.optionalKey(Schema.Struct({ runtimeId: Base64Url, placementId: Base64Url })),
})
type PersistedDeviceStore = typeof PersistedDeviceStoreSchema.Type
const decodePersisted = Schema.decodeUnknownSync(PersistedDeviceStoreSchema, { onExcessProperty: "error" })

interface TerminalDeviceState {
  device: { readonly publicKey: string; readonly privateKey: Redacted.Redacted<string> } | undefined
  label: string | undefined
  machines: PairedRuntime[]
  selection: RemoteSelection | undefined
}

function fromPersisted(persisted: PersistedDeviceStore): TerminalDeviceState {
  return {
    device: { publicKey: persisted.device.publicKey, privateKey: Redacted.make(persisted.device.privateKey) },
    label: persisted.label,
    machines: [...persisted.machines],
    selection: persisted.selection,
  }
}

/** The serialization boundary: the only line that unwraps the private key. */
function toPersisted(state: TerminalDeviceState): PersistedDeviceStore {
  if (state.device === undefined) throw new Error("the terminal device store has no device key to write")
  return {
    version: 1,
    device: { publicKey: state.device.publicKey, privateKey: Redacted.value(state.device.privateKey) },
    ...(state.label === undefined ? {} : { label: state.label }),
    machines: state.machines,
    ...(state.selection === undefined ? {} : { selection: state.selection }),
  }
}

function storeOptions(userDataRoot: string): LockedJsonStoreOptions<TerminalDeviceState> {
  return {
    location: accountSecretFile(accountAuthDir(userDataRoot), TERMINAL_DEVICE_STORE_FILE),
    empty: () => ({ device: undefined, label: undefined, machines: [], selection: undefined }),
    decode: (value) => fromPersisted(decodePersisted(value)),
    encode: toPersisted,
  }
}

/** The store as it is on disk, or nothing before the first pairing. */
function readState(userDataRoot: string): TerminalDeviceState | undefined {
  const state = readLockedJsonStore(storeOptions(userDataRoot))
  if (state.tag === "valid") return state.value
  if (state.tag === "malformed") throw new Error(`The terminal device store at ${terminalDeviceStoreFile(userDataRoot)} is not in a shape this Flywheel reads. A later release may have written it: update Flywheel, or move the file to pair this terminal again.`)
  return undefined
}

function mutate(userDataRoot: string, change: (state: TerminalDeviceState) => void): Promise<void> {
  return mutateLockedJsonStore(storeOptions(userDataRoot), change)
}

/** How many machines this terminal is paired with. Reads one small file and
 *  creates nothing, so a launch that only asks whether to offer remote
 *  projects leaves no device behind. */
export function terminalPairedMachineCount(userDataRoot: string): number {
  return readState(userDataRoot)?.machines.length ?? 0
}

/** Opens the store, creating the device key under the store's lock on first
 *  use so that two terminals starting together agree on one key. `hostLabel`
 *  names the device until the person names it. */
export async function openTerminalDeviceStore(userDataRoot: string, hostLabel: string = hostname()): Promise<DeviceStore> {
  if (readState(userDataRoot)?.device === undefined) {
    const pair = asKeyPair(await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]))
    const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
    const privateKey = Redacted.make(toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))))
    await mutate(userDataRoot, (state) => { state.device ??= { publicKey, privateKey } })
  }
  const opened = readState(userDataRoot)
  if (opened?.device === undefined) throw new Error("the terminal device store lost its device key while it was opened")
  const publicKey = fromBase64Url(opened.device.publicKey)
  const keyPair: CryptoKeyPair = {
    publicKey: await crypto.subtle.importKey("raw", ownedBytes(publicKey), { name: "Ed25519" }, true, ["verify"]),
    privateKey: await crypto.subtle.importKey("pkcs8", ownedBytes(fromBase64Url(Redacted.value(opened.device.privateKey))), { name: "Ed25519" }, false, ["sign"]),
  }
  let label = opened.label ?? hostLabel
  const current = (): TerminalDeviceState => readState(userDataRoot) ?? storeOptions(userDataRoot).empty()
  return {
    device: { keyPair, deviceId: await keyDigest(publicKey), publicKey },
    label: () => label,
    async setLabel(next) {
      await mutate(userDataRoot, (state) => { state.label = next })
      label = next
    },
    runtimes: async () => current().machines,
    putRuntime: (runtime) => mutate(userDataRoot, (state) => {
      state.machines = [...state.machines.filter((existing) => existing.runtimeId !== runtime.runtimeId), runtime]
    }),
    removeRuntime: (runtimeId) => mutate(userDataRoot, (state) => {
      state.machines = state.machines.filter((existing) => existing.runtimeId !== runtimeId)
    }),
    selection: async () => current().selection,
    setSelection: (selection) => mutate(userDataRoot, (state) => { state.selection = selection }),
  }
}
