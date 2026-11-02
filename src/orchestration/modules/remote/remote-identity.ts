import type { ServeLane } from "../../../infra/cli-subprocess.js"
import { Redacted } from "effect"

import { importLegacyRemotePushSubscriptions, mutateRemotePairingStore, readRemotePairingStore, type RemotePairingStore, type StoredKeyPair } from "./remote-pairing-store.js"
import { asKeyPair, fromBase64Url, keyDigest, ownedBytes, toBase64Url } from "../../../protocol/modules/remote/relay-protocol.js"

/** This account's runtime identity, held ready to sign. The private key stays
 *  inside the closure; nothing above this module sees it. */
export interface RemoteIdentity {
  /** `keyDigest(publicKey)`: the id the relay and every device know this account by. */
  readonly runtimeId: string
  readonly publicKey: Uint8Array
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>
}

async function generateKeyPair(algorithm: "Ed25519" | { name: "ECDSA"; namedCurve: "P-256" }, usages: KeyUsage[]): Promise<StoredKeyPair> {
  const pair = asKeyPair(await crypto.subtle.generateKey(algorithm, true, usages))
  const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
  const privateKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey)))
  return { publicKey, privateKey: Redacted.make(privateKey) }
}

/** Loads this lane's identity and the machine's shared VAPID key.
 *  Each key is generated under its owning store's lock. */
export async function ensureRemoteIdentity(userDataRoot: string, lane: ServeLane): Promise<RemoteIdentity> {
  if (readRemotePairingStore(userDataRoot, "installed").vapid === undefined) {
    await mutateRemotePairingStore(userDataRoot, "installed", async (current) => {
      // Remove this conversion after 2027-04-24: version-2 dev stores owned a separate VAPID key.
      current.vapid ??= readRemotePairingStore(userDataRoot, "dev").vapid ?? await generateKeyPair({ name: "ECDSA", namedCurve: "P-256" }, ["sign", "verify"])
    })
  }
  await importLegacyRemotePushSubscriptions(userDataRoot, lane)
  let store = readRemotePairingStore(userDataRoot, lane)
  if (store.identity === undefined || (lane === "dev" && store.vapid !== undefined)) {
    await mutateRemotePairingStore(userDataRoot, lane, async (current) => {
      current.identity ??= await generateKeyPair("Ed25519", ["sign", "verify"])
      // Remove this conversion after 2027-04-24: the installed store now owns this key.
      if (lane === "dev") current.vapid = undefined
    })
    store = readRemotePairingStore(userDataRoot, lane)
  }
  return remoteIdentityFrom(store)
}

/** The signing identity for a store that already holds one. */
export async function remoteIdentityFrom(store: RemotePairingStore): Promise<RemoteIdentity> {
  const stored = store.identity
  if (stored === undefined) throw new Error("The remote pairing store holds no identity key")
  const publicKey = fromBase64Url(stored.publicKey)
  const privateKey = await crypto.subtle.importKey("pkcs8", ownedBytes(fromBase64Url(Redacted.value(stored.privateKey))), { name: "Ed25519" }, false, ["sign"])
  return {
    runtimeId: await keyDigest(publicKey),
    publicKey,
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, ownedBytes(bytes))),
  }
}
