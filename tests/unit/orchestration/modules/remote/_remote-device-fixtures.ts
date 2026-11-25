import { Effect, Exit, Fiber, Scope, Stream } from "effect"
import { Socket } from "effect/socket"

import type { RemoteAccess } from "../../../../../src/orchestration/modules/remote/remote-access.js"
import { openPairingChannel, type DeviceChannel } from "../../../../../src/protocol/modules/remote/relay-channel.js"
import { sealedSocket, type SealedIdentity, type SealedPeer, type SealedSocket } from "../../../../../src/protocol/modules/remote/sealed-socket.js"
import { asKeyPair, decodeJsonFrame, decodePairingResult, fromBase64Url, keyDigest, ownedBytes, parsePairingCodeUrl } from "../../../../../src/protocol/modules/remote/relay-protocol.js"
import type { NotificationEpisodeInput } from "../../../../../src/infra/substrate/events/notification-episode.js"
import type { RuntimeRemoteView } from "../../../../../src/protocol/modules/remote.js"

/** A phone's side of the relay for tests of a runtime placement: its
 *  identity, its device socket, and its sealed channel. */

export const text = (value: string) => new TextEncoder().encode(value)
export const fromText = (bytes: Uint8Array) => new TextDecoder().decode(bytes)

export async function deviceIdentity(): Promise<SealedIdentity & { readonly id: string }> {
  const pair = asKeyPair(await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]))
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return {
    role: "device",
    publicKey,
    id: await keyDigest(publicKey),
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, ownedBytes(bytes))),
  }
}

/** Waits for the view to satisfy a predicate, through the change listener. */
export function viewWhere(remote: RemoteAccess, predicate: (view: RuntimeRemoteView) => boolean, timeoutMs = 5_000): Promise<RuntimeRemoteView> {
  return new Promise((resolve, reject) => {
    if (predicate(remote.view())) return resolve(remote.view())
    const timer = setTimeout(() => { unsubscribe(); reject(new Error(`remote view did not settle: ${JSON.stringify(remote.view())}`)) }, timeoutMs)
    const unsubscribe = remote.onChange((view) => {
      if (!predicate(view)) return
      clearTimeout(timer)
      unsubscribe()
      resolve(view)
    })
  })
}

export interface SealedDeviceChannel {
  readonly received: Uint8Array[]
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, Socket.SocketError>
  readonly ended: Effect.Effect<Exit.Exit<void, Socket.SocketError>>
  readonly established: SealedSocket["established"]
  readonly close: () => Promise<void>
}

/** Seals an attached device socket and runs it. */
export async function sealDevice({ ws, streams }: DeviceChannel, identity: SealedIdentity, peer: SealedPeer): Promise<SealedDeviceChannel> {
  const scope = Scope.makeUnsafe()
  const program = Effect.gen(function*() {
    const inner = yield* Socket.fromTransformStream(Effect.succeed(streams))
    const sealed = sealedSocket(inner, identity, peer)
    const received: Uint8Array[] = []
    const fiber = yield* Effect.forkScoped(Stream.runForEach(Socket.toStream(sealed.socket), (bytes) => Effect.sync(() => { received.push(bytes) })), { startImmediately: true })
    const { write } = yield* sealed.socket.writer
    return { received, write, ended: Effect.exit(Fiber.join(fiber)), established: sealed.established }
  }).pipe(Scope.provide(scope))
  const channel = await Effect.runPromise(program)
  return { ...channel, close: async () => { ws.close(1000); await Effect.runPromiseExit(Scope.close(scope, Exit.void)) } }
}

export const waitFor = async (condition: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition did not settle in time")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Pairs a fresh device through the relay at `relayUrl` with the full
 *  exchange and returns its identity. */
export async function pairDevice(relayUrl: string, remote: RemoteAccess, label = "test phone", existingDevice?: Awaited<ReturnType<typeof deviceIdentity>>) {
  const window = await remote.openPairing()
  await viewWhere(remote, (view) => view.connection === "connected")
  const code = parsePairingCodeUrl(window.code)
  const runtimeId = await keyDigest(fromBase64Url(code.publicKey))
  const device = existingDevice ?? await deviceIdentity()
  const ws = await openPairingChannel(relayUrl, runtimeId, code.windowId)
  const channel = await sealDevice(ws, device, { kind: "pairing", secret: fromBase64Url(code.secret) })
  await Effect.runPromise(channel.write(text(JSON.stringify({ type: "pair.request", label }))))
  await waitFor(() => channel.received.length === 1)
  const result = decodeJsonFrame(decodePairingResult, fromText(channel.received[0]!))
  await channel.close()
  return { device, result, runtimeId, code }
}

/** The "Remote device paired" occurrences that `operations` raise. */
export const pairedNotices = (operations: readonly NotificationEpisodeInput[]) =>
  operations.flatMap((operation) => operation.type === "raise" && operation.occurrence.title === "Remote device paired" ? [operation.occurrence] : [])
