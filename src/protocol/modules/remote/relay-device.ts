import type { DeviceIdentity } from "./relay-channel.js"
import { ownedBytes } from "./relay-protocol.js"

/** What a paired device remembers, as the contract between the shared relay
 *  client (`relay-client.ts`) and the host that keeps the bytes.
 *
 *  The relay client never holds device storage itself. Each host supplies one
 *  `DeviceStore`: the phone's hosted page keeps it in IndexedDB and hands it to
 *  the shell it loads (`phone-bootstrap.ts`). This store crosses the hosted
 *  page and the shell, which can come from different builds, so every shape
 *  here is part of the host contract `HOST_CONTRACT_VERSION` numbers.
 *
 *  Bun-free and DOM-free apart from WebCrypto, which every host has. */

/** One machine this device has paired with, as the pairing exchange named it. */
export interface PairedRuntime {
  readonly runtimeId: string
  readonly publicKey: string
  readonly relay: string
  readonly label: string
  readonly pairedAt: number
}

/** The device's own key. The private half is a `CryptoKey`; the host decides
 *  whether it is extractable. The phone's browser keeps it extractable to
 *  carry it into the installed app, which imports it non-extractable. */
export interface DeviceRecord {
  readonly keyPair: CryptoKeyPair
  readonly deviceId: string
  readonly publicKey: Uint8Array
}

/** One project on one paired machine. */
export interface RemoteSelection {
  readonly runtimeId: string
  readonly placementId: string
}

/** The device's key, the name it pairs under, the machines it has paired
 *  with, and which project it last opened. Every write resolves only after
 *  the value is committed, so a reader that starts after the write reads the
 *  new value. */
export interface DeviceStore {
  readonly device: DeviceRecord
  /** The name this device sends at pairing, and the machine lists it under. */
  label(): string
  setLabel(label: string): Promise<void>
  runtimes(): Promise<readonly PairedRuntime[]>
  putRuntime(runtime: PairedRuntime): Promise<void>
  removeRuntime(runtimeId: string): Promise<void>
  selection(): Promise<RemoteSelection | undefined>
  setSelection(selection: RemoteSelection | undefined): Promise<void>
}

/** The device as the relay contract wants it: id, raw key, and a signer. */
export function deviceIdentity(record: DeviceRecord): DeviceIdentity {
  return {
    deviceId: record.deviceId,
    publicKey: record.publicKey,
    sign: async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.sign("Ed25519", record.keyPair.privateKey, ownedBytes(bytes))),
  }
}
