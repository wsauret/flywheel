import { type Array as Arr, Deferred, Effect, Exit, Schema, type Scope, Semaphore, Stream } from "effect"
import { Socket } from "effect/socket"

import { asKeyPair, decodeJsonFrame, decodeSealedHello, fromBase64Url, ownedBytes, sealedHelloSigningBytes, toBase64Url } from "./relay-protocol.js"

/** End-to-end encryption as a `Socket` combinator.
 *
 *  The relay between a runtime and a phone copies frames it must not be able
 *  to read. This wraps any Effect `Socket` so that everything above it, the RPC
 *  protocol and MsgPack, sees plain bytes, while everything below it, the
 *  WebSocket and the relay, sees only sealed frames. Neither layer knows the
 *  other exists, which is what lets the relay be a byte pump and the protocol
 *  stay a protocol.
 *
 *  A channel opens with one hello from each end: identity key, a fresh X25519
 *  ephemeral key, and the identity's Ed25519 signature over the ephemeral. The
 *  channel key is HKDF over the X25519 shared secret and both ephemerals. In
 *  `paired` mode the peer's identity must be the key recorded at pairing; in
 *  `pairing` mode the pairing secret salts the derivation, so an end that does
 *  not hold the secret derives a different key and its first frame fails to
 *  open. A relay can therefore drop or delay a channel and can never read one
 *  or complete one it was not invited to.
 *
 *  Each direction has its own key and a counter that starts at zero and grows
 *  by exactly one per frame. A frame whose counter is not the next one is a
 *  replay, a reorder, or a loss, and all three end the channel with a typed
 *  failure that the connection above turns into an ordinary reconnect and
 *  resnapshot.
 *
 *  A write longer than `SEALED_FRAME_MAX_BYTES` goes out as consecutive
 *  frames of at most that many bytes, which the peer delivers one by one.
 *  Every relay socket answers its heartbeat only after the frame in front of
 *  the answer has crossed whole, and its far end hears nothing of a frame
 *  until all of it has arrived, so one multi-megabyte frame on a slow link
 *  reads as a dead socket; bounded frames keep each crossing short. The RPC
 *  protocol above frames its own messages in the byte stream and joins the
 *  pieces, as it does over the local socket. A reader that takes one frame as
 *  one message, as the pairing and project creation exchanges do, keeps its
 *  messages under the bound. Peers on releases that sent one frame per write
 *  read the bounded frames unchanged, because they read the same stream.
 *
 *  WebCrypto only, so the same module runs in Bun, in a browser, and in a
 *  Worker. */

type SealedRole = "runtime" | "device"

/** The local end's identity. The private key never leaves its owner: the
 *  socket asks for a signature and gets one. */
export interface SealedIdentity {
  readonly role: SealedRole
  readonly publicKey: Uint8Array
  readonly sign: (bytes: Uint8Array) => Promise<Uint8Array>
}

/** Who the other end must be. */
export type SealedPeer =
  | { readonly kind: "paired"; readonly publicKey: Uint8Array }
  | { readonly kind: "pairing"; readonly secret: Uint8Array }

type SealedChannelFailure =
  | "hello_malformed"
  | "hello_role"
  | "unexpected_identity"
  | "bad_signature"
  | "frame_before_hello"
  | "frame_malformed"
  | "out_of_order"
  | "open_failed"

export class SealedChannelError extends Schema.TaggedError<SealedChannelError>()("SealedChannelError", {
  failure: Schema.Literals(["hello_malformed", "hello_role", "unexpected_identity", "bad_signature", "frame_before_hello", "frame_malformed", "out_of_order", "open_failed"]),
  message: Schema.String,
}) {}

/** What the handshake settled: the identity the other end proved. In
 *  `pairing` mode this is the key to record. */
interface EstablishedPeer {
  readonly publicKey: Uint8Array
}

export interface SealedSocket {
  readonly socket: Socket.Socket
  /** Settles once the peer's hello verified and the channel keys exist, or
   *  fails with the reason the handshake was refused. */
  readonly established: Effect.Effect<EstablishedPeer, SealedChannelError>
}

const HELLO_TAG = 0x01
const FRAME_TAG = 0x02
const COUNTER_BYTES = 8
const HEADER_BYTES = 1 + COUNTER_BYTES
const NONCE_BYTES = 12
const KEY_BYTES = 32
const CHANNEL_INFO = "flywheel-sealed-channel-v1"
/** The most plaintext one sealed frame carries. Small next to the relay's
 *  16 MiB frame ceiling, large enough that framing costs nothing measurable,
 *  and about a second on a 2 Mbit/s link. */
export const SEALED_FRAME_MAX_BYTES = 256 * 1024

const subtle = crypto.subtle
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

interface DirectionalKeys {
  readonly send: CryptoKey
  readonly receive: CryptoKey
}

/** HKDF-SHA256 over the shared secret, then two AES-256-GCM keys, one per
 *  direction, so the two ends never share a nonce space. Exported for the known
 *  vector test; nothing else calls it directly. */
export async function deriveSealedKeys(sharedSecret: Uint8Array, salt: Uint8Array, info: Uint8Array): Promise<{ runtimeToDevice: Uint8Array; deviceToRuntime: Uint8Array }> {
  const ikm = await subtle.importKey("raw", ownedBytes(sharedSecret), "HKDF", false, ["deriveBits"])
  const bits = new Uint8Array(await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: ownedBytes(salt), info: ownedBytes(info) }, ikm, KEY_BYTES * 2 * 8))
  return { runtimeToDevice: bits.slice(0, KEY_BYTES), deviceToRuntime: bits.slice(KEY_BYTES) }
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle.importKey("raw", ownedBytes(raw), { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"])
}

async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, bytes: Uint8Array): Promise<boolean> {
  try {
    const key = await subtle.importKey("raw", ownedBytes(publicKey), { name: "Ed25519" }, false, ["verify"])
    return await subtle.verify("Ed25519", key, ownedBytes(signature), ownedBytes(bytes))
  } catch {
    return false
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false
  let difference = 0
  for (let index = 0; index < left.byteLength; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return difference === 0
}

function writeCounter(target: Uint8Array, offset: number, counter: bigint): void {
  new DataView(target.buffer, target.byteOffset + offset, COUNTER_BYTES).setBigUint64(0, counter)
}

function readCounter(frame: Uint8Array): bigint {
  return new DataView(frame.buffer, frame.byteOffset + 1, COUNTER_BYTES).getBigUint64(0)
}

function sealedError(failure: SealedChannelFailure, message: string): SealedChannelError {
  return new SealedChannelError({ failure, message })
}

/** One handshake and channel-key lifetime. Reset for every run of the socket,
 *  because every run is a new transport connection and a key must never span
 *  two of them. */
interface ChannelState {
  readonly established: Deferred.Deferred<EstablishedPeer, SealedChannelError>
  readonly ended: Deferred.Deferred<never, Socket.SocketError>
  keys: DirectionalKeys | undefined
  sendCounter: bigint
  receiveCounter: bigint
  /** The first refusal. A channel that refused a frame delivers nothing after
   *  it, whatever else was already in flight behind the refused frame. */
  failed: SealedChannelError | undefined
  /** Serializes outbound frames from counter claim through to the write.
   *  WebCrypto finishes a small encryption before a large one that started
   *  earlier, so concurrent writers would otherwise put counter N+1 on the
   *  wire ahead of N and the peer would refuse the channel as out of order. */
  readonly sendLock: Semaphore.Semaphore
}

function freshState(): ChannelState {
  return { established: Deferred.makeUnsafe(), ended: Deferred.makeUnsafe(), keys: undefined, sendCounter: 0n, receiveCounter: 0n, failed: undefined, sendLock: Semaphore.makeUnsafe(1) }
}

export function sealedSocket(inner: Socket.Socket, identity: SealedIdentity, peer: SealedPeer): SealedSocket {
  // The run that is open now, or the one that will open next. A writer may be
  // acquired and used before the socket runs: the RPC client sends its first
  // ping before it starts reading. Such a write waits for the next run to
  // start and then for that run's handshake, exactly as Effect's own socket
  // writers wait on their open latch.
  let currentRun = Deferred.makeUnsafe<ChannelState>()

  const seal = async (keys: DirectionalKeys, counter: bigint, plaintext: Uint8Array): Promise<Uint8Array> => {
    const header = new Uint8Array(HEADER_BYTES)
    header[0] = FRAME_TAG
    writeCounter(header, 1, counter)
    const nonce = new Uint8Array(NONCE_BYTES)
    writeCounter(nonce, NONCE_BYTES - COUNTER_BYTES, counter)
    const ciphertext = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: header }, keys.send, ownedBytes(plaintext)))
    const frame = new Uint8Array(HEADER_BYTES + ciphertext.byteLength)
    frame.set(header)
    frame.set(ciphertext, HEADER_BYTES)
    return frame
  }

  const open = async (keys: DirectionalKeys, frame: Uint8Array): Promise<Uint8Array> => {
    const nonce = new Uint8Array(NONCE_BYTES)
    nonce.set(frame.subarray(1, HEADER_BYTES), NONCE_BYTES - COUNTER_BYTES)
    try {
      return new Uint8Array(await subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: ownedBytes(frame.subarray(0, HEADER_BYTES)) }, keys.receive, ownedBytes(frame.subarray(HEADER_BYTES))))
    } catch {
      throw sealedError("open_failed", "a sealed frame did not authenticate")
    }
  }

  /** Verifies the peer's hello and derives this run's keys. */
  const establish = async (current: ChannelState, ephemeral: CryptoKeyPair, ownEphemeralPublic: Uint8Array, frame: Uint8Array): Promise<void> => {
    let hello: ReturnType<typeof decodeSealedHello>
    try {
      hello = decodeJsonFrame(decodeSealedHello, textDecoder.decode(frame.subarray(1)))
    } catch {
      throw sealedError("hello_malformed", "the peer's hello did not decode")
    }
    if (hello.role === identity.role) throw sealedError("hello_role", `both ends of the channel claim the ${identity.role} role`)
    const peerIdentity = fromBase64Url(hello.identityPublicKey)
    if (peer.kind === "paired" && !sameBytes(peerIdentity, peer.publicKey)) throw sealedError("unexpected_identity", "the peer is not the identity this channel was opened for")
    const signed = await verifyEd25519(peerIdentity, fromBase64Url(hello.signature), sealedHelloSigningBytes({ role: hello.role, ephemeralPublicKey: hello.ephemeralPublicKey }))
    if (!signed) throw sealedError("bad_signature", "the peer's hello signature did not verify")

    const peerEphemeral = fromBase64Url(hello.ephemeralPublicKey)
    const peerKey = await subtle.importKey("raw", ownedBytes(peerEphemeral), { name: "X25519" }, false, [])
    const shared = new Uint8Array(await subtle.deriveBits({ name: "X25519", public: peerKey }, ephemeral.privateKey, KEY_BYTES * 8))
    const salt = peer.kind === "pairing" ? new Uint8Array(await subtle.digest("SHA-256", ownedBytes(peer.secret))) : new Uint8Array(KEY_BYTES)
    const runtimeEphemeral = identity.role === "runtime" ? ownEphemeralPublic : peerEphemeral
    const deviceEphemeral = identity.role === "device" ? ownEphemeralPublic : peerEphemeral
    const info = textEncoder.encode(`${CHANNEL_INFO}\n${toBase64Url(runtimeEphemeral)}\n${toBase64Url(deviceEphemeral)}`)
    const derived = await deriveSealedKeys(shared, salt, info)
    const [runtimeToDevice, deviceToRuntime] = await Promise.all([importAesKey(derived.runtimeToDevice), importAesKey(derived.deviceToRuntime)])
    current.keys = identity.role === "runtime"
      ? { send: runtimeToDevice, receive: deviceToRuntime }
      : { send: deviceToRuntime, receive: runtimeToDevice }
    Deferred.doneUnsafe(current.established, Effect.succeed({ publicKey: peerIdentity }))
  }

  const buildHello = async (ownEphemeralPublic: Uint8Array): Promise<Uint8Array> => {
    const ephemeralPublicKey = toBase64Url(ownEphemeralPublic)
    const signature = await identity.sign(sealedHelloSigningBytes({ role: identity.role, ephemeralPublicKey }))
    const body = textEncoder.encode(JSON.stringify({ v: 1, role: identity.role, identityPublicKey: toBase64Url(identity.publicKey), ephemeralPublicKey, signature: toBase64Url(signature) }))
    const frame = new Uint8Array(1 + body.byteLength)
    frame[0] = HELLO_TAG
    frame.set(body, 1)
    return frame
  }

  /** Opens one inbound frame: a hello settles the handshake and carries no
   *  plaintext, and a sealed frame must carry the next counter. */
  const openFrame = async (current: ChannelState, ephemeral: CryptoKeyPair, ownEphemeralPublic: Uint8Array, frame: string | Uint8Array): Promise<Uint8Array | undefined> => {
    // Text frames are what the relay speaks before admission; none may reach
    // a sealed channel, so one is the same failure as a malformed frame.
    if (typeof frame === "string") throw sealedError("frame_malformed", "a text frame arrived on a sealed channel")
    const tag = frame[0]
    if (tag === HELLO_TAG) {
      if (current.keys !== undefined) throw sealedError("frame_malformed", "a second hello arrived on an established channel")
      await establish(current, ephemeral, ownEphemeralPublic, frame)
      return undefined
    }
    if (tag !== FRAME_TAG || frame.byteLength < HEADER_BYTES) throw sealedError("frame_malformed", "a frame carried neither a hello nor a sealed body")
    if (current.keys === undefined) throw sealedError("frame_before_hello", "a sealed frame arrived before the peer's hello")
    const counter = readCounter(frame)
    if (counter !== current.receiveCounter) throw sealedError("out_of_order", `expected frame ${current.receiveCounter}, received ${counter}`)
    current.receiveCounter += 1n
    return open(current.keys, frame)
  }

  /** One run of the socket: one transport connection, one handshake, and one
   *  pair of channel keys. */
  const reader: Socket.Socket["reader"] = Effect.gen(function*() {
    const current = freshState()
    Deferred.doneUnsafe(currentRun, Effect.succeed(current))
    // When this run ends, the next write waits for the next run.
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      Deferred.doneUnsafe(current.ended, Effect.fail(new Socket.SocketError({ reason: new Socket.SocketCloseError({ code: 1000 }) })))
      currentRun = Deferred.makeUnsafe<ChannelState>()
      if (!current.failed) Deferred.doneUnsafe(current.established, Effect.fail(sealedError("frame_before_hello", "the channel closed")))
    }))
    const ephemeral = asKeyPair(yield* Effect.promise(() => subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])))
    const ownEphemeralPublic = new Uint8Array(yield* Effect.promise(() => subtle.exportKey("raw", ephemeral.publicKey)))
    const hello = yield* Effect.promise(() => buildHello(ownEphemeralPublic))
    // The writer is taken before the reader so that the end of a run cancels
    // the read first and closes the transport's write half last. A close that
    // ran first waited on a write that nothing would read, and the run never
    // ended.
    const { write } = yield* inner.writer
    const { pull } = yield* inner.reader
    // Sent beside the first pull, not before it: a transport with
    // backpressure finishes a write only once the peer reads, and the peer
    // reads only after its own hello went out. Started at once, the hello is
    // queued ahead of any sealed frame, which waits for the peer's hello. A
    // hello that cannot be written is a transport that failed, which the next
    // pull reports.
    yield* Effect.forkScoped(Effect.ignore(write(hello)), { startImmediately: true })

    // Plaintext of frames already taken from the transport. A pull opens a
    // whole batch before it returns, so a frame that arrived is delivered even
    // when the transport closes right behind it, and a refusal ends delivery
    // only after the frames in front of it.
    let ready: Array<Uint8Array> = []
    const openBatch = (frames: Arr.NonEmptyReadonlyArray<string | Uint8Array>): Effect.Effect<void> => Effect.promise(async () => {
      for (const frame of frames) {
        if (current.failed) return
        try {
          const plaintext = await openFrame(current, ephemeral, ownEphemeralPublic, frame)
          if (plaintext !== undefined) ready.push(plaintext)
        } catch (cause) {
          current.failed = cause instanceof SealedChannelError ? cause : sealedError("frame_malformed", String(cause))
          // A caller waiting on `established` learns why.
          Deferred.doneUnsafe(current.established, Effect.fail(current.failed))
        }
      }
    })
    const sealedPull: Effect.Effect<Arr.NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError> = Effect.suspend(() => {
      const [first, ...rest] = ready
      if (first !== undefined) {
        ready = []
        return Effect.succeed([first, ...rest])
      }
      if (current.failed) return Effect.fail(new Socket.SocketError({ reason: new Socket.SocketReadError({ cause: current.failed }) }))
      // Uninterruptible once a batch is taken: its frames advance the receive
      // counter, so each must reach `ready` or the next pull reads a gap.
      return Effect.uninterruptibleMask((restore) => Effect.flatMap(restore(pull), openBatch)).pipe(Effect.andThen(sealedPull))
    })
    return { pull: sealedPull, upgrade: Socket.SocketUpgradeError.unsupported }
  })

  const writer: Socket.Socket["writer"] = Effect.map(inner.writer, (transport) => {
    const write = (chunk: Uint8Array | string | Socket.CloseEvent): Effect.Effect<void, Socket.SocketError> => {
      if (Socket.isCloseEvent(chunk)) return transport.write(chunk)
      return Effect.suspend(() => Deferred.await(currentRun)).pipe(
        Effect.flatMap((current) => Deferred.await(current.established).pipe(
          Effect.mapError((error) => new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause: error }) })),
          // Uninterruptible once the permit is held: a claimed counter must reach
          // the wire, or the next writer's frame arrives as a gap. Waiting for
          // the permit stays interruptible.
          Effect.flatMap(() => current.sendLock.withPermit(Effect.uninterruptible(Effect.suspend(() => {
            const keys = current.keys
            if (keys === undefined) return Effect.fail(new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause: sealedError("frame_before_hello", "write before the channel established") }) }))
            const plaintext = typeof chunk === "string" ? textEncoder.encode(chunk) : chunk
            const sealOne = (start: number): Effect.Effect<void, Socket.SocketError> => {
              const counter = current.sendCounter
              current.sendCounter += 1n
              return Effect.flatMap(
                Effect.promise(() => seal(keys, counter, plaintext.subarray(start, start + SEALED_FRAME_MAX_BYTES))),
                (frame) => Effect.raceFirst(transport.write(frame), Deferred.await(current.ended)),
              )
            }
            const starts: number[] = []
            for (let start = 0; start === 0 || start < plaintext.byteLength; start += SEALED_FRAME_MAX_BYTES) starts.push(start)
            return Effect.forEach(starts, sealOne, { discard: true })
          })))),
        )),
      )
    }
    return { write, writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }) }
  })

  return {
    socket: Socket.make({ reader, writer }),
    established: Effect.flatMap(Effect.suspend(() => Deferred.await(currentRun)), (current) => Deferred.await(current.established)),
  }
}

/** One exchange over a sealed channel that runs once: pairing, or creating a
 *  project. Each end sends a few messages, and then the channel closes. */
export interface SealedExchange<A> {
  /** Seals and sends one message. Fails with the exchange's `ended` error
   *  once the run has ended. */
  readonly send: (message: Uint8Array) => Effect.Effect<void, Error>
  /** What `receive` settled, or the `ended` error if the run ended first. */
  readonly outcome: Effect.Effect<A, Error>
}

/** Runs `sealed` once in the current scope for one exchange. `receive` reads
 *  each message in arrival order and settles the outcome when it returns an
 *  exit; the first settlement wins. Every message that arrived reaches
 *  `receive` before the end of the run fails an unsettled outcome.
 *
 *  The end of the run is the end of the exchange. The socket's own writer
 *  keeps Effect's `Socket` contract, where a write after a run ended waits for
 *  the next run, because the reconnecting relay RPC client depends on it. An
 *  exchange has no next run, so its sends fail at the end instead of waiting
 *  without a limit. */
export const runSealedExchange = <A>(sealed: SealedSocket, ended: Error, receive: (message: Uint8Array) => Exit.Exit<A, Error> | undefined): Effect.Effect<SealedExchange<A>, never, Scope.Scope> =>
  Effect.gen(function*() {
    const outcome = yield* Deferred.make<A, Error>()
    const runEnded = yield* Deferred.make<never, Error>()
    yield* Effect.forkScoped(Stream.runForEach(Socket.toStream(sealed.socket), (message) => Effect.sync(() => {
      const settled = receive(message)
      if (settled !== undefined) Deferred.doneUnsafe(outcome, settled)
    })).pipe(Effect.ensuring(Effect.sync(() => {
      Deferred.doneUnsafe(outcome, Exit.fail(ended))
      Deferred.doneUnsafe(runEnded, Exit.fail(ended))
    }))), { startImmediately: true })
    const { write } = yield* sealed.socket.writer
    return {
      send: (message) => Effect.raceFirst(write(message).pipe(Effect.mapError(() => ended)), Deferred.await(runEnded)),
      outcome: Deferred.await(outcome),
    }
  })
