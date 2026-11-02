import { describe, expect, test } from "bun:test"
import { Effect, Exit, Fiber, Scope } from "effect"
import { Socket } from "effect/unstable/socket"

import { deriveSealedKeys, SEALED_FRAME_MAX_BYTES, SealedChannelError, sealedSocket, type SealedIdentity, type SealedPeer, type SealedSocket } from "../../../../../src/protocol/modules/remote/sealed-socket.js"
import { fromBase64Url, keyDigest, ownedBytes, toBase64Url } from "../../../../../src/protocol/modules/remote/relay-protocol.js"

/** The sealed socket is the one thing between a phone's transcript and a relay
 *  operator. These tests pin the cryptography to published vectors and then
 *  exercise the channel the way a relay could misbehave: wrong identity, wrong
 *  secret, replayed, reordered, and dropped frames, and a stray text frame. */

const hex = (text: string): Uint8Array => Uint8Array.from(text.match(/../g)!.map((pair) => Number.parseInt(pair, 16)))
const toHex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")

/** PKCS#8 wrapping for a raw Ed25519 seed, which is how WebCrypto imports one. */
const ED25519_PKCS8_PREFIX = hex("302e020100300506032b657004220420")
function ed25519Pkcs8(seed: Uint8Array): Uint8Array {
  const wrapped = new Uint8Array(ED25519_PKCS8_PREFIX.length + seed.length)
  wrapped.set(ED25519_PKCS8_PREFIX)
  wrapped.set(seed, ED25519_PKCS8_PREFIX.length)
  return wrapped
}

async function identityFromSeed(role: "runtime" | "device", seed: Uint8Array): Promise<SealedIdentity> {
  const privateKey = await crypto.subtle.importKey("pkcs8", ownedBytes(ed25519Pkcs8(seed)), { name: "Ed25519" }, true, ["sign"])
  const jwk = await crypto.subtle.exportKey("jwk", privateKey)
  return {
    role,
    publicKey: fromBase64Url(jwk.x!),
    sign: async (bytes) => new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, ownedBytes(bytes))),
  }
}

async function freshIdentity(role: "runtime" | "device"): Promise<SealedIdentity> {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  return identityFromSeed(role, seed)
}

/** A byte pipe with an optional tamper stage, standing in for the relay. */
type Tamper = (frame: Uint8Array, index: number, emit: (frame: Uint8Array) => void) => void | Promise<void>

function pipe(tamper?: Tamper) {
  let index = 0
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const emit = (frame: Uint8Array) => controller.enqueue(frame)
      const result = tamper ? tamper(chunk, index, emit) : emit(chunk)
      index += 1
      return result
    },
  })
  return { readable: stream.readable, writable: stream.writable }
}

interface Peer {
  readonly sealed: SealedSocket
  readonly received: Uint8Array[]
  readonly write: (bytes: Uint8Array) => Effect.Effect<void, Socket.SocketError>
  /** The run fiber's exit, once the channel ends. */
  readonly ended: Effect.Effect<Exit.Exit<void, Socket.SocketError>>
}

/** Two sealed ends over in-memory pipes. `toDevice` and `toRuntime` tamper with
 *  the frames flowing in that direction. */
async function connectPair(options: {
  runtime: SealedIdentity
  device: SealedIdentity
  runtimePeer: SealedPeer
  devicePeer: SealedPeer
  toDevice?: Tamper
  toRuntime?: Tamper
}): Promise<{ runtime: Peer; device: Peer; close: () => Promise<void> }> {
  const runtimeToDevice = pipe(options.toDevice)
  const deviceToRuntime = pipe(options.toRuntime)
  const scope = Scope.makeUnsafe()
  const start = (inner: Socket.Socket, identity: SealedIdentity, peer: SealedPeer): Effect.Effect<Peer, never, Scope.Scope> =>
    Effect.gen(function*() {
      const sealed = sealedSocket(inner, identity, peer)
      const received: Uint8Array[] = []
      const fiber = yield* Effect.forkScoped(sealed.socket.run((bytes) => { received.push(bytes) }), { startImmediately: true })
      const write = yield* sealed.socket.writer
      return { sealed, received, write, ended: Effect.exit(Fiber.join(fiber)) }
    })
  const program = Effect.gen(function*() {
    const runtimeInner = yield* Socket.fromTransformStream(Effect.succeed({ readable: deviceToRuntime.readable, writable: runtimeToDevice.writable }))
    const deviceInner = yield* Socket.fromTransformStream(Effect.succeed({ readable: runtimeToDevice.readable, writable: deviceToRuntime.writable }))
    const runtime = yield* start(runtimeInner, options.runtime, options.runtimePeer)
    const device = yield* start(deviceInner, options.device, options.devicePeer)
    return { runtime, device }
  }).pipe(Scope.provide(scope))
  const pair = await Effect.runPromise(program)
  // A pipe whose far end failed is already closed; the inner transform-stream
  // socket reports closing it again as a defect, which is teardown noise here.
  return { ...pair, close: () => Effect.runPromiseExit(Scope.close(scope, Exit.void)).then(() => undefined) }
}

/** Every byte a peer received, joined in arrival order. */
function joined(chunks: readonly Uint8Array[]): Uint8Array {
  const whole = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    whole.set(chunk, offset)
    offset += chunk.byteLength
  }
  return whole
}

const waitFor = async (condition: () => boolean, timeoutMs = 2_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition did not settle in time")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function establishedOutcome(sealed: SealedSocket): Promise<Exit.Exit<{ publicKey: Uint8Array }, SealedChannelError>> {
  return Effect.runPromise(Effect.exit(sealed.established))
}

function failureOf(exit: Exit.Exit<unknown, SealedChannelError>): string | undefined {
  return Exit.isFailure(exit) ? JSON.stringify(exit.cause).match(/"failure":"([a-z_]+)"/)?.[1] : undefined
}

describe("sealed channel cryptography against published vectors", () => {
  test("Ed25519 signs the RFC 8032 test vector", async () => {
    const identity = await identityFromSeed("runtime", hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"))
    expect(toHex(identity.publicKey)).toBe("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
    expect(toHex(await identity.sign(new Uint8Array(0)))).toBe("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
  })

  test("X25519 agrees on the RFC 7748 shared secret", async () => {
    const pkcs8 = (seed: Uint8Array) => {
      const prefix = hex("302e020100300506032b656e04220420")
      const out = new Uint8Array(prefix.length + 32)
      out.set(prefix)
      out.set(seed, prefix.length)
      return out
    }
    const alice = await crypto.subtle.importKey("pkcs8", ownedBytes(pkcs8(hex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a"))), { name: "X25519" }, false, ["deriveBits"])
    const bobPublic = await crypto.subtle.importKey("raw", ownedBytes(hex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")), { name: "X25519" }, false, [])
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: bobPublic }, alice, 256))
    expect(toHex(shared)).toBe("4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
  })

  test("HKDF-SHA256 key derivation matches RFC 5869 test case 1", async () => {
    // The vector asks for 42 bytes; HKDF output is prefix-stable, so the first
    // 42 of the 64 the channel derives must equal it.
    const keys = await deriveSealedKeys(hex("0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b"), hex("000102030405060708090a0b0c"), hex("f0f1f2f3f4f5f6f7f8f9"))
    const okm = new Uint8Array(64)
    okm.set(keys.runtimeToDevice)
    okm.set(keys.deviceToRuntime, 32)
    expect(toHex(okm.subarray(0, 42))).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
  })

  test("a key digest is the base64url SHA-256 of the key", async () => {
    expect(await keyDigest(new Uint8Array(0))).toBe("47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU")
    expect(toBase64Url(fromBase64Url("AQID_-8"))).toBe("AQID_-8")
  })
})

describe("sealed channel between paired identities", () => {
  test("carries bytes both ways and settles the peer identity", async () => {
    const runtime = await freshIdentity("runtime")
    const device = await freshIdentity("device")
    const pair = await connectPair({ runtime, device, runtimePeer: { kind: "paired", publicKey: device.publicKey }, devicePeer: { kind: "paired", publicKey: runtime.publicKey } })
    try {
      await Effect.runPromise(pair.runtime.write(new TextEncoder().encode("from runtime")))
      await Effect.runPromise(pair.device.write(new TextEncoder().encode("from device")))
      await waitFor(() => pair.runtime.received.length === 1 && pair.device.received.length === 1)
      expect(new TextDecoder().decode(pair.device.received[0])).toBe("from runtime")
      expect(new TextDecoder().decode(pair.runtime.received[0])).toBe("from device")
      const settled = await establishedOutcome(pair.runtime.sealed)
      expect(Exit.isSuccess(settled) && toHex(settled.value.publicKey)).toBe(toHex(device.publicKey))
    } finally {
      await pair.close()
    }
  })

  test("carries a large write as bounded frames that join back into it", async () => {
    // A relay socket answers its heartbeat only after the frame in front of
    // the answer has crossed whole, so a multi-megabyte frame on a slow link
    // reads as a dead socket. Bounded frames keep every frame's crossing short;
    // the protocol above frames its own messages and joins them.
    const runtime = await freshIdentity("runtime")
    const device = await freshIdentity("device")
    const wire: Uint8Array[] = []
    const pair = await connectPair({
      runtime, device,
      runtimePeer: { kind: "paired", publicKey: device.publicKey }, devicePeer: { kind: "paired", publicKey: runtime.publicKey },
      toDevice: (frame, _index, emit) => { wire.push(frame); emit(frame) },
    })
    try {
      const body = crypto.getRandomValues(new Uint8Array(3 * 1024 * 1024 + 7))
      await Effect.runPromise(pair.runtime.write(body))
      await waitFor(() => joined(pair.device.received).byteLength === body.byteLength)
      expect(joined(pair.device.received)).toEqual(body)
      const sealedFrames = wire.slice(1)
      expect(sealedFrames.length).toBe(Math.ceil(body.byteLength / SEALED_FRAME_MAX_BYTES))
      expect(pair.device.received.every((chunk) => chunk.byteLength <= SEALED_FRAME_MAX_BYTES)).toBe(true)
    } finally {
      await pair.close()
    }
  })

  test("concurrent writes of unequal size arrive in write order", async () => {
    // WebCrypto finishes a small encryption before a large one that started
    // earlier. The RPC server writes a snapshot response and an event patch
    // concurrently, so the counters must follow the order the writes were
    // made in, not the order their ciphertext became ready.
    const runtime = await freshIdentity("runtime")
    const device = await freshIdentity("device")
    const pair = await connectPair({ runtime, device, runtimePeer: { kind: "paired", publicKey: device.publicKey }, devicePeer: { kind: "paired", publicKey: runtime.publicKey } })
    try {
      const large = crypto.getRandomValues(new Uint8Array(4 * 1024 * 1024))
      const small = new TextEncoder().encode("heartbeat")
      await Effect.runPromise(Effect.all([pair.runtime.write(large), pair.runtime.write(small)], { concurrency: "unbounded" }))
      await waitFor(() => joined(pair.device.received).byteLength === large.byteLength + small.byteLength)
      expect(joined(pair.device.received)).toEqual(joined([large, small]))
      expect(Exit.isSuccess(await establishedOutcome(pair.device.sealed))).toBe(true)
    } finally {
      await pair.close()
    }
  })

  test("a write interrupted mid-seal still reaches the wire before the next one", async () => {
    // The RPC server interrupts a request fiber when the client cancels, and
    // the response write runs inside that fiber. A counter that was claimed
    // and never sent would make the next frame a gap the peer refuses.
    const runtime = await freshIdentity("runtime")
    const device = await freshIdentity("device")
    const pair = await connectPair({ runtime, device, runtimePeer: { kind: "paired", publicKey: device.publicKey }, devicePeer: { kind: "paired", publicKey: runtime.publicKey } })
    try {
      const large = crypto.getRandomValues(new Uint8Array(4 * 1024 * 1024))
      const small = new TextEncoder().encode("after the interrupt")
      // Once established, a write reaches the permit synchronously, so the
      // interrupt lands while the holder is inside the seal.
      expect(Exit.isSuccess(await establishedOutcome(pair.runtime.sealed))).toBe(true)
      await Effect.runPromise(Effect.gen(function*() {
        const holder = yield* Effect.forkChild(pair.runtime.write(large), { startImmediately: true })
        const waiter = yield* Effect.forkChild(pair.runtime.write(small), { startImmediately: true })
        yield* Fiber.interrupt(holder)
        yield* Fiber.join(waiter)
      }))
      await waitFor(() => joined(pair.device.received).byteLength === large.byteLength + small.byteLength)
      expect(joined(pair.device.received)).toEqual(joined([large, small]))
    } finally {
      await pair.close()
    }
  })

  test("a pending transport write fails when its sealed run ends", async () => {
    const runtime = await freshIdentity("runtime")
    const device = await freshIdentity("device")
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const pair = await connectPair({
      runtime,
      device,
      runtimePeer: { kind: "paired", publicKey: device.publicKey },
      devicePeer: { kind: "paired", publicKey: runtime.publicKey },
      toDevice: async (frame, index, emit) => {
        if (index === 1) {
          entered.resolve()
          await release.promise
        }
        emit(frame)
      },
    })
    try {
      const write = Effect.runPromiseExit(pair.runtime.write(new TextEncoder().encode("closing")))
      await entered.promise
      const close = pair.close()
      const outcome = await Promise.race([
        write,
        Bun.sleep(25).then(() => { throw new Error("pending write did not settle when the run ended") }),
      ])
      expect(Exit.isFailure(outcome)).toBe(true)
      release.resolve()
      await close
    } finally {
      release.resolve()
      await pair.close()
    }
  })

  test("the relay sees only the hello and sealed frames, never the plaintext", async () => {
    const runtime = await freshIdentity("runtime")
    const device = await freshIdentity("device")
    const captured: Uint8Array[] = []
    const pair = await connectPair({
      runtime, device,
      runtimePeer: { kind: "paired", publicKey: device.publicKey }, devicePeer: { kind: "paired", publicKey: runtime.publicKey },
      toDevice: (frame, _index, emit) => { captured.push(frame); emit(frame) },
    })
    try {
      const secret = "the user's private transcript text"
      await Effect.runPromise(pair.runtime.write(new TextEncoder().encode(secret)))
      await waitFor(() => pair.device.received.length === 1)
      expect(captured.length).toBe(2)
      expect(captured[0]![0]).toBe(0x01)
      expect(captured[1]![0]).toBe(0x02)
      const wire = captured.map((frame) => new TextDecoder("utf-8", { fatal: false }).decode(frame)).join("")
      expect(wire).not.toContain("transcript")
    } finally {
      await pair.close()
    }
  })

  test("refuses an identity that is not the one it was opened for", async () => {
    const runtime = await freshIdentity("runtime")
    const device = await freshIdentity("device")
    const stranger = await freshIdentity("device")
    const pair = await connectPair({ runtime, device, runtimePeer: { kind: "paired", publicKey: stranger.publicKey }, devicePeer: { kind: "paired", publicKey: runtime.publicKey } })
    try {
      expect(failureOf(await establishedOutcome(pair.runtime.sealed))).toBe("unexpected_identity")
      const exit = await Effect.runPromise(pair.runtime.ended)
      expect(Exit.isFailure(exit)).toBe(true)
    } finally {
      await pair.close()
    }
  })

  test("refuses a hello whose signature does not verify", async () => {
    const runtime = await freshIdentity("runtime")
    const device = await freshIdentity("device")
    const pair = await connectPair({
      runtime, device,
      runtimePeer: { kind: "paired", publicKey: device.publicKey }, devicePeer: { kind: "paired", publicKey: runtime.publicKey },
      toRuntime: (frame, index, emit) => {
        if (index !== 0) return emit(frame)
        // Flip one character of the signature inside the device's hello.
        const text = new TextDecoder().decode(frame.subarray(1))
        const flipped = text.replace(/"signature":"(.)/, (_match, first: string) => `"signature":"${first === "A" ? "B" : "A"}`)
        const body = new TextEncoder().encode(flipped)
        const forged = new Uint8Array(1 + body.length)
        forged[0] = 0x01
        forged.set(body, 1)
        emit(forged)
      },
    })
    try {
      expect(failureOf(await establishedOutcome(pair.runtime.sealed))).toBe("bad_signature")
    } finally {
      await pair.close()
    }
  })
})

describe("sealed channel under a hostile relay", () => {
  async function pairedWith(toDevice: Tamper) {
    const runtime = await freshIdentity("runtime")
    const device = await freshIdentity("device")
    return connectPair({ runtime, device, runtimePeer: { kind: "paired", publicKey: device.publicKey }, devicePeer: { kind: "paired", publicKey: runtime.publicKey }, toDevice })
  }

  /** Writes past the point where the far end has already refused a frame, so
   *  a later write may find the pipe closed; that is the far end's verdict
   *  arriving, not a finding about the writer. */
  const sendThree = async (peer: Peer) => {
    for (const text of ["one", "two", "three"]) await Effect.runPromiseExit(peer.write(new TextEncoder().encode(text)))
  }

  test("a replayed frame ends the channel", async () => {
    const pair = await pairedWith((frame, index, emit) => { emit(frame); if (index === 1) emit(frame) })
    try {
      await sendThree(pair.runtime)
      const exit = await Effect.runPromise(pair.device.ended)
      expect(JSON.stringify(exit)).toContain("out_of_order")
      expect(pair.device.received.length).toBe(1)
    } finally {
      await pair.close()
    }
  })

  test("reordered frames end the channel", async () => {
    let held: Uint8Array | undefined
    const pair = await pairedWith((frame, index, emit) => {
      if (index === 1) { held = frame; return }
      emit(frame)
      if (index === 2 && held) emit(held)
    })
    try {
      await sendThree(pair.runtime)
      const exit = await Effect.runPromise(pair.device.ended)
      expect(JSON.stringify(exit)).toContain("out_of_order")
    } finally {
      await pair.close()
    }
  })

  test("a dropped frame ends the channel", async () => {
    const pair = await pairedWith((frame, index, emit) => { if (index !== 1) emit(frame) })
    try {
      await sendThree(pair.runtime)
      const exit = await Effect.runPromise(pair.device.ended)
      expect(JSON.stringify(exit)).toContain("out_of_order")
    } finally {
      await pair.close()
    }
  })

  test("a tampered ciphertext ends the channel", async () => {
    const pair = await pairedWith((frame, index, emit) => {
      if (index !== 1) return emit(frame)
      const forged = new Uint8Array(frame)
      forged[forged.length - 1] = (forged[forged.length - 1] ?? 0) ^ 0xff
      emit(forged)
    })
    try {
      await sendThree(pair.runtime)
      const exit = await Effect.runPromise(pair.device.ended)
      expect(JSON.stringify(exit)).toContain("open_failed")
    } finally {
      await pair.close()
    }
  })
})

describe("sealed channel in pairing mode", () => {
  test("two ends holding the same secret establish and learn each other's identity", async () => {
    const runtime = await freshIdentity("runtime")
    const device = await freshIdentity("device")
    const secret = crypto.getRandomValues(new Uint8Array(16))
    const pair = await connectPair({ runtime, device, runtimePeer: { kind: "pairing", secret }, devicePeer: { kind: "pairing", secret } })
    try {
      await Effect.runPromise(pair.device.write(new TextEncoder().encode("pair me")))
      await waitFor(() => pair.runtime.received.length === 1)
      const settled = await establishedOutcome(pair.runtime.sealed)
      expect(Exit.isSuccess(settled) && toHex(settled.value.publicKey)).toBe(toHex(device.publicKey))
    } finally {
      await pair.close()
    }
  })

  test("an end without the secret cannot open a single frame", async () => {
    const runtime = await freshIdentity("runtime")
    const device = await freshIdentity("device")
    const pair = await connectPair({ runtime, device, runtimePeer: { kind: "pairing", secret: new Uint8Array([1, 2, 3]) }, devicePeer: { kind: "pairing", secret: new Uint8Array([4, 5, 6]) } })
    try {
      await Effect.runPromise(pair.device.write(new TextEncoder().encode("pair me")))
      const exit = await Effect.runPromise(pair.runtime.ended)
      expect(JSON.stringify(exit)).toContain("open_failed")
      expect(pair.runtime.received.length).toBe(0)
    } finally {
      await pair.close()
    }
  })
})
