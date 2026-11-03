import { hostname } from "node:os"
import { Effect, Exit } from "effect"
import { Socket } from "effect/socket"

import type { ServeLane } from "../../../infra/cli-subprocess.js"
import type { RelayChannelStreams } from "../../../protocol/modules/remote/relay-channel.js"
import { decodeJsonFrame, decodePairingRequest, keyDigest, pairingCodeUrl, toBase64Url, type PairingResult } from "../../../protocol/modules/remote/relay-protocol.js"
import { runSealedExchange, SealedChannelError, sealedSocket } from "../../../protocol/modules/remote/sealed-socket.js"
import { mutateRemotePairingStore, type PairedDevice } from "./remote-pairing-store.js"
import type { RemoteIdentity } from "./remote-identity.js"

/** How long a pairing code is good for. Long enough to unlock a phone and
 *  point it at a screen; short enough that a code left on a screen is not a
 *  standing credential. */
export const PAIRING_WINDOW_MS = 5 * 60_000
/** How long a pairing channel may take to present its request once sealed. */
const PAIRING_EXCHANGE_TIMEOUT_MS = 30_000

/** One pairing window: the code a device scans, and the secret its channel
 *  is sealed under. The relay knows the window only by its id. */
export interface PairingWindow {
  readonly windowId: string
  readonly secret: Uint8Array
  readonly expiresAt: number
  readonly code: string
}

/** The name a device lists the machine under, apart from its projects: the
 *  host name, and for a source run `dev (<host>)`, so the second machine
 *  that a developer pairs reads as dev mode, not as a project. */
export function machineName(lane: ServeLane): string {
  const name = hostname().replace(/\.local$/, "")
  return lane === "dev" ? `dev (${name})` : name
}

/** A new window whose code names `relayUrl`, the runtime's key, and `label`. */
export function createPairingWindow(options: { readonly appOrigin: string; readonly relayUrl: string; readonly identity: RemoteIdentity; readonly label: string; readonly expiresAt: number }): PairingWindow {
  const windowId = toBase64Url(crypto.getRandomValues(new Uint8Array(9)))
  const secret = crypto.getRandomValues(new Uint8Array(16))
  const code = pairingCodeUrl(options.appOrigin, { v: 1, relay: options.relayUrl, publicKey: toBase64Url(options.identity.publicKey), windowId, secret: toBase64Url(secret), label: options.label, expiresAt: options.expiresAt })
  return { windowId, secret, expiresAt: options.expiresAt, code }
}

/** The pairing exchange on one channel the relay opened for `window`: seal
 *  it under the window's secret and read the device's request. Then, only if
 *  `claim` answers that the window is still open (which takes it for this
 *  device, so no close can end it as anything else), it records the device
 *  with the relay it paired through, calls `onCommitted`, and answers the
 *  device. Interruption before the claim commits nothing; from the claim to
 *  the answer the exchange is uninterruptible, so a scope that closes over it
 *  joins the commit and the answer and nothing after. Fails when the
 *  device does not complete the exchange in time, when it leaves first, when
 *  the window closed first, or when the store write fails. A device that
 *  leaves after the claim stays recorded, and the answer it can no longer
 *  hear fails at once. The caller owns the channel's socket and the window. */
export function exchangePairing(options: {
  readonly userDataRoot: string
  readonly lane: ServeLane
  readonly relayUrl: string
  readonly identity: RemoteIdentity
  readonly window: PairingWindow
  readonly streams: RelayChannelStreams
  readonly now: () => number
  readonly claim: () => boolean
  readonly onCommitted: (device: PairedDevice) => void
}): Effect.Effect<PairedDevice, unknown> {
  const { identity, streams } = options
  return Effect.scoped(Effect.gen(function*() {
    const inner = yield* Socket.fromTransformStream(Effect.succeed(streams))
    const sealed = sealedSocket(inner, { role: "runtime", publicKey: identity.publicKey, sign: identity.sign }, { kind: "pairing", secret: options.window.secret })
    // The device closes the channel once it has the answer, or leaves early.
    const exchange = yield* runSealedExchange(sealed, new Error("the device left before the pairing exchange finished"), (bytes) => Exit.succeed(decodeJsonFrame(decodePairingRequest, new TextDecoder().decode(bytes)).label))
    const peer = yield* sealed.established.pipe(Effect.timeoutOrElse({ duration: PAIRING_EXCHANGE_TIMEOUT_MS, orElse: () => Effect.fail(new SealedChannelError({ failure: "hello_malformed", message: "the device did not complete the handshake in time" })) }))
    const label = yield* exchange.outcome.pipe(Effect.timeoutOrElse({ duration: PAIRING_EXCHANGE_TIMEOUT_MS, orElse: () => Effect.fail(new Error("the device did not send its pairing request in time")) }))
    const device: PairedDevice = { id: yield* Effect.promise(() => keyDigest(peer.publicKey)), label, publicKey: toBase64Url(peer.publicKey), pairedAt: options.now() }
    yield* Effect.uninterruptible(Effect.gen(function*() {
      if (!options.claim()) return yield* Effect.fail(new Error("the pairing window closed before the device paired"))
      yield* Effect.tryPromise(() => mutateRemotePairingStore(options.userDataRoot, options.lane, (store) => {
        store.relayUrl = options.relayUrl
        const previous = store.devices.find((existing) => existing.id === device.id)
        store.devices = [...store.devices.filter((existing) => existing.id !== device.id), { ...previous, ...device }]
      }))
      options.onCommitted(device)
      // A label stored by an earlier pairing stays until the device pairs again.
      const result: PairingResult = { type: "pair.accepted", runtimeLabel: machineName(options.lane) }
      // The writer returns once the WebSocket has taken the bytes, and a
      // WebSocket sends what it took before its close frame, so the close
      // that ends the exchange never cuts the answer off.
      yield* exchange.send(new TextEncoder().encode(JSON.stringify(result)))
    }))
    return device
  }))
}
