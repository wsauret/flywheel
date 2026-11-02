import { Effect, Exit } from "effect"
import { Socket } from "effect/unstable/socket"

import type { PairedRuntime } from "./relay-device.js"
import { openPairingChannel } from "./relay-channel.js"
import { decodeJsonFrame, decodePairingResult, fromBase64Url, keyDigest, parsePairingCodeUrl } from "./relay-protocol.js"
import { runSealedExchange, sealedSocket } from "./sealed-socket.js"

const PAIRING_TIMEOUT_MS = 30_000

interface PairingDevice {
  readonly publicKey: Uint8Array
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>
  readonly label: string
}

/** Pairs a device from a code: opens the window's channel, seals it under the
 *  code's secret, sends the device's label, and returns the machine as the
 *  hello that proved it held the secret names it. Both the phone's hosted
 *  page, for the first pairing, and the phone shell, for every later one,
 *  pair through this. Throws with a message a person can act on. */
export async function pairDevice(text: string, device: PairingDevice, now: number = Date.now()): Promise<PairedRuntime> {
  const code = parsePairingCodeUrl(text)
  if (code.expiresAt < now) throw new Error("This pairing code has expired. Show a new one on the machine.")
  const runtimeId = await keyDigest(fromBase64Url(code.publicKey))
  const channel = await openPairingChannel(code.relay, runtimeId, code.windowId)
  try {
    return await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const inner = yield* Socket.fromTransformStream(Effect.succeed(channel.streams))
      const sealed = sealedSocket(inner, { role: "device", publicKey: device.publicKey, sign: device.sign }, { kind: "pairing", secret: fromBase64Url(code.secret) })
      // The machine closes the channel after its answer, or unanswered when
      // the person withdraws the code.
      const ended = new Error("The connection to the machine ended before it answered. Show a new pairing code on the machine and scan it again.")
      const exchange = yield* runSealedExchange(sealed, ended, (bytes) => Exit.succeed(new TextDecoder().decode(bytes)))
      const peer = yield* sealed.established
      yield* exchange.send(new TextEncoder().encode(JSON.stringify({ type: "pair.request", label: device.label })))
      const result = decodeJsonFrame(decodePairingResult, yield* exchange.outcome)
      if (result.type === "pair.rejected") throw new Error(`The machine refused the pairing: ${result.reason}`)
      const peerId = yield* Effect.promise(() => keyDigest(peer.publicKey))
      if (peerId !== runtimeId) throw new Error("The machine that answered is not the one the code names.")
      return { runtimeId, publicKey: code.publicKey, relay: code.relay, label: result.runtimeLabel, pairedAt: Date.now() } satisfies PairedRuntime
    })).pipe(Effect.timeoutOrElse({ duration: PAIRING_TIMEOUT_MS, orElse: () => Effect.fail(new Error("The machine did not answer in time.")) })))
  } finally {
    channel.ws.close(1000)
  }
}
