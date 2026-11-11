import { Schema } from "effect"

import type { DeviceStore, PairedRuntime } from "../../src/protocol/modules/remote/relay-device.js"
import { fromBase64Url, ownedBytes, toBase64Url } from "../../src/protocol/modules/remote/relay-protocol.js"

/** How a phone that paired in the browser stays paired when the person adds
 *  the page to the Home Screen (PI-REMOTE-032).
 *
 *  iOS copies no cookies and no storage into the installed app. It copies the
 *  manifest, once, and launches the app at the manifest's start URL with its
 *  fragment kept on every launch. So the page builds its manifest at each load
 *  and puts the browser's device identity and paired machines in the start
 *  URL's fragment, which never reaches a server. The installed app imports
 *  them on its first launch and is the same device, not a second one.
 *
 *  Every other manifest field is fixed (ARCH-PROTOCOL-070): iOS records them at
 *  Add to Home Screen and never reads them again. */

const CARRY_PREFIX = "#install="
const MANIFEST_DATA_PREFIX = "data:application/manifest+json,"
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** Version 1 of the carry. A later version gets a new `v`; an installed app
 *  that meets a version it does not know ignores it and pairs in the app. */
const CarrySchema = Schema.Struct({
  v: Schema.Literal(1),
  /** The device's Ed25519 private key, PKCS #8, base64url. */
  key: Schema.NonEmptyString,
  /** The device's raw Ed25519 public key, base64url. */
  publicKey: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  runtimes: Schema.Array(Schema.Struct({
    runtimeId: Schema.NonEmptyString,
    publicKey: Schema.NonEmptyString,
    relay: Schema.NonEmptyString,
    label: Schema.String,
    pairedAt: Schema.Number,
  })),
})
const decodeCarry = Schema.decodeUnknownSync(CarrySchema)

/** A device identity and its pairings, read from a start URL's fragment and
 *  ready for an empty device store. The private key is non-extractable. */
export interface CarriedDevice {
  readonly keyPair: CryptoKeyPair
  readonly label: string
  readonly runtimes: readonly PairedRuntime[]
}

async function startUrl(origin: string, store: DeviceStore): Promise<string> {
  const runtimes = await store.runtimes()
  const { privateKey } = store.device.keyPair
  // A key made before the carry existed is non-extractable and stays: a new
  // key would unpair the phone. Its installed app pairs once, in the app.
  if (!privateKey.extractable || runtimes.length === 0) return `${origin}/`
  const carry: typeof CarrySchema.Type = {
    v: 1,
    key: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", privateKey))),
    publicKey: toBase64Url(store.device.publicKey),
    label: store.label(),
    runtimes,
  }
  return `${origin}/${CARRY_PREFIX}${toBase64Url(textEncoder.encode(JSON.stringify(carry)))}`
}

/** The page's web app manifest for `origin` as a `data:` URL, so nothing about
 *  the device reaches a server. Its start URL carries `store`'s identity and
 *  machines when the store has an exportable key and at least one machine,
 *  else it is the origin's root. Every URL in it is absolute, because a
 *  `data:` manifest has no base to resolve a relative one against. */
export async function installManifestHref(origin: string, store: DeviceStore): Promise<string> {
  const manifest = {
    // The id a manifest without one defaults to, which the apps installed
    // before the page stated one already have.
    id: `${origin}/`,
    name: "Flywheel",
    short_name: "Flywheel",
    description: "Your Flywheel sessions, from your phone.",
    start_url: await startUrl(origin, store),
    scope: `${origin}/`,
    display: "standalone",
    background_color: "#1c1b19",
    theme_color: "#1c1b19",
    icons: [
      { src: `${origin}/icon-192.png`, sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: `${origin}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "any maskable" },
    ],
  }
  return `${MANIFEST_DATA_PREFIX}${encodeURIComponent(JSON.stringify(manifest))}`
}

/** Whether a URL fragment is a carry, which the page removes from the URL. */
export function isInstallCarry(fragment: string): boolean {
  return fragment.startsWith(CARRY_PREFIX)
}

/** Reads a carry fragment. Answers undefined for any other fragment and for a
 *  carry that is malformed in any way, because a URL is outside input. */
export async function readInstallCarry(fragment: string): Promise<CarriedDevice | undefined> {
  if (!isInstallCarry(fragment)) return undefined
  try {
    const carry = decodeCarry(JSON.parse(textDecoder.decode(fromBase64Url(fragment.slice(CARRY_PREFIX.length)))))
    const [privateKey, publicKey] = await Promise.all([
      crypto.subtle.importKey("pkcs8", ownedBytes(fromBase64Url(carry.key)), { name: "Ed25519" }, false, ["sign"]),
      crypto.subtle.importKey("raw", ownedBytes(fromBase64Url(carry.publicKey)), { name: "Ed25519" }, true, ["verify"]),
    ])
    return { keyPair: { privateKey, publicKey }, label: carry.label, runtimes: carry.runtimes }
  } catch {
    return undefined
  }
}
