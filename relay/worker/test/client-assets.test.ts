import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Miniflare } from "miniflare"

import {
  ASSET_CHUNK_BYTES,
  asKeyPair,
  decodeRelayControlFrame,
  deviceAttachSigningBytes,
  encodeAssetChunk,
  keyDigest,
  ownedBytes,
  RELAY_PROTOCOL_VERSION,
  runtimeAttachSigningBytes,
  toBase64Url,
  type Placement,
} from "../../../src/protocol/modules/remote/relay-protocol.js"
import { startLocalRelay } from "./local-relay.js"

/** The relay's client asset route under workerd, with the real Worker and its
 *  real Durable Object on SQLite storage, and a machine that speaks the
 *  control channel frame by frame. These are the scenarios POC 10 measured:
 *  a cold identity streamed from the machine and kept, a warm one served from
 *  the cache with and without the machine, an identity never streamed, a
 *  replaced identity, and two identities announced together. */

const IDENTITY_A = "a".repeat(64)
const IDENTITY_B = "b".repeat(64)
const IDENTITY_C = "c".repeat(64)

/** Compared by digest, so a failure prints two hashes rather than megabytes. */
const hex = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex")

function bytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) out[index] = (index * 7 + seed) % 256
  return out
}

/** A client bundle larger than two chunks, so every transfer crosses a row boundary. */
function bundle(seed: number): Map<string, Uint8Array> {
  return new Map([["webview.js", bytes(ASSET_CHUNK_BYTES * 2 + 4321, seed)], ["webview.css", bytes(5000, seed + 1)]])
}

interface Machine {
  readonly requests: string[]
  close(): Promise<void>
}

let relay: Miniflare
let origin: string
let runtime: Awaited<ReturnType<typeof runtimeKey>>

async function runtimeKey() {
  const pair = asKeyPair(await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]))
  const exported = await crypto.subtle.exportKey("raw", pair.publicKey)
  if (!(exported instanceof ArrayBuffer)) throw new Error("expected raw key bytes")
  const publicKey = new Uint8Array(exported)
  return {
    id: await keyDigest(publicKey),
    publicKey: toBase64Url(publicKey),
    sign: async (data: Uint8Array) => toBase64Url(new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, ownedBytes(data)))),
  }
}

/** Attaches one placement announcing `identity` and answers asset requests
 *  for it from `files` in chunk frames, the way the remote module does. */
async function attachMachine(identity: string, files: Map<string, Uint8Array>, placementId = "p".repeat(42) + identity.slice(0, 1), key: Awaited<ReturnType<typeof runtimeKey>> = runtime, devices: readonly string[] = []): Promise<Machine> {
  const ws = new WebSocket(`${origin.replace("http", "ws")}/runtime/${key.id}`)
  ws.binaryType = "arraybuffer"
  const requests: string[] = []
  const placement: Placement = { id: placementId, projectLabel: "flywheel", version: "0.0.11", protocolVersion: 11, state: "live", clientIdentity: identity }
  const attached = Promise.withResolvers<void>()
  ws.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return
    const frame = decodeRelayControlFrame(JSON.parse(event.data))
    if (frame.type === "challenge") {
      void key.sign(runtimeAttachSigningBytes({ nonce: frame.nonce, runtimeId: key.id, placementId })).then((signature) => {
        ws.send(JSON.stringify({ type: "attach", relayProtocolVersion: RELAY_PROTOCOL_VERSION, runtimeId: key.id, publicKey: key.publicKey, placement, devices, signature }))
      })
    } else if (frame.type === "attached") {
      attached.resolve()
    } else if (frame.type === "rejected") {
      attached.reject(new Error(frame.reason))
    } else if (frame.type === "asset.request") {
      requests.push(`${frame.identity.slice(0, 1)}:${frame.file}`)
      const content = frame.identity === identity ? files.get(frame.file) : undefined
      if (content === undefined) {
        ws.send(JSON.stringify({ type: "asset.missing", requestId: frame.requestId }))
        return
      }
      // Typed as a hostile machine might type it; the relay does not read it.
      ws.send(JSON.stringify({ type: "asset.head", requestId: frame.requestId, contentType: "text/html; charset=utf-8" }))
      for (let start = 0; start < content.byteLength; start += ASSET_CHUNK_BYTES) ws.send(encodeAssetChunk(frame.requestId, content.subarray(start, start + ASSET_CHUNK_BYTES)))
      ws.send(JSON.stringify({ type: "asset.end", requestId: frame.requestId }))
    }
  })
  await attached.promise
  return {
    requests,
    close: async () => {
      const closed = Promise.withResolvers<void>()
      ws.addEventListener("close", () => closed.resolve(), { once: true })
      ws.close(1000, "machine leaving")
      await closed.promise
      // The object learns of the close in its own turn; one round trip settles it.
      await relay.dispatchFetch(`${origin}/health`)
    },
  }
}

const assetUrl = (identity: string, file = "webview.js", runtimeId = runtime.id) => `${origin}/client/${runtimeId}/${identity}/phone/${file}`

async function load(identity: string, file = "webview.js", runtimeId = runtime.id) {
  const response = await relay.dispatchFetch(assetUrl(identity, file, runtimeId))
  return { response, body: new Uint8Array(await response.arrayBuffer()) }
}

beforeAll(async () => {
  const local = await startLocalRelay()
  relay = local.miniflare
  origin = local.origin
  runtime = await runtimeKey()
})

afterAll(async () => {
  await relay.dispose()
})

describe("the relay serves a machine's client by identity", () => {
  const a = bundle(1)
  const b = bundle(2)

  test("a cold identity streams from the machine with immutable, cross-origin headers", async () => {
    const machine = await attachMachine(IDENTITY_A, a)
    try {
      const { response, body } = await load(IDENTITY_A)
      expect(response.status).toBe(200)
      expect(hex(body)).toBe(hex(a.get("webview.js")!))
      expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
      expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
      expect(response.headers.get("etag")).toBe(`"${IDENTITY_A}"`)
      expect(response.headers.get("access-control-allow-origin")).toBe("*")
      expect(response.headers.get("timing-allow-origin")).toBe("*")
      expect(response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")
      expect(machine.requests).toEqual(["a:webview.js"])
      const css = await load(IDENTITY_A, "webview.css")
      expect(hex(css.body)).toBe(hex(a.get("webview.css")!))
      expect(css.response.headers.get("content-type")).toBe("text/css; charset=utf-8")

      // Warm, with the machine still connected: the cache answers and the
      // machine hears nothing.
      const warm = await load(IDENTITY_A)
      expect(warm.response.status).toBe(200)
      expect(hex(warm.body)).toBe(hex(a.get("webview.js")!))
      expect(warm.response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
      expect(warm.response.headers.get("x-content-type-options")).toBe("nosniff")
      expect(warm.response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")
      expect(machine.requests).toEqual(["a:webview.js", "a:webview.css"])
    } finally {
      await machine.close()
    }
  })

  test("a cached identity is served with no machine connected", async () => {
    const { response, body } = await load(IDENTITY_A)
    expect(response.status).toBe(200)
    expect(hex(body)).toBe(hex(a.get("webview.js")!))
  })

  test("an identity never streamed answers 503 and must not be cached", async () => {
    const { response } = await load(IDENTITY_C)
    expect(response.status).toBe(503)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("retry-after")).toBe("5")
    expect(response.headers.get("access-control-allow-origin")).toBe("*")
    // Also while a machine announcing another identity is connected.
    const machine = await attachMachine(IDENTITY_B, b)
    try {
      expect((await load(IDENTITY_C)).response.status).toBe(503)
      expect(machine.requests).toEqual([])
    } finally {
      await machine.close()
    }
  })

  test("a file the machine does not serve answers 404, and a malformed path 404", async () => {
    const machine = await attachMachine(IDENTITY_B, new Map([["webview.js", b.get("webview.js")!]]))
    try {
      expect((await load(IDENTITY_B, "webview.css")).response.status).toBe(404)
      expect(machine.requests).toEqual(["b:webview.css"])
      expect((await relay.dispatchFetch(`${origin}/client/${runtime.id}/${IDENTITY_B}/editor/webview.js`)).status).toBe(404)
      expect((await relay.dispatchFetch(`${origin}/client/${runtime.id}/not-an-identity/phone/webview.js`)).status).toBe(404)
    } finally {
      await machine.close()
    }
  })

  test("a page, an unknown file, or a type the machine names is never served from the relay's domain", async () => {
    // A runtime is only a key pair, so anyone's machine may offer any bytes
    // under any name and type. The relay serves the phone shell's two files,
    // typed by their names, and asks the machine for nothing else.
    const page = new TextEncoder().encode("<!doctype html><title>Sign in</title><form>")
    const hostile = new Map([["index.html", page], ["webview.html", page], ["login.js", page], ["webview.svg", page], ["webview.js", page]])
    const key = await runtimeKey()
    const machine = await attachMachine(IDENTITY_C, hostile, "h".repeat(43), key)
    try {
      for (const file of ["index.html", "webview.html", "login.js", "webview.svg"]) {
        const { response } = await load(IDENTITY_C, file, key.id)
        expect(response.status).toBe(404)
        expect(response.headers.get("content-type")).toBe("text/plain;charset=UTF-8")
        expect(response.headers.get("x-content-type-options")).toBe("nosniff")
        expect(response.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'")
      }
      expect(machine.requests).toEqual([])
      // An allowed name carrying a page is served as script, which no
      // browser renders: the machine's own word on the type is not read.
      const script = await load(IDENTITY_C, "webview.js", key.id)
      expect(script.response.status).toBe(200)
      expect(script.response.headers.get("content-type")).toBe("text/javascript; charset=utf-8")
      expect(script.response.headers.get("x-content-type-options")).toBe("nosniff")
    } finally {
      await machine.close()
    }
  })

  test("a replaced identity stays served until its successor is streamed, then is evicted", async () => {
    const machine = await attachMachine(IDENTITY_B, b)
    try {
      // A is no longer announced, and B has not been streamed: A stays.
      expect((await load(IDENTITY_A)).response.status).toBe(200)
      const cold = await load(IDENTITY_B)
      expect(hex(cold.body)).toBe(hex(b.get("webview.js")!))
    } finally {
      await machine.close()
    }
    expect((await load(IDENTITY_B)).response.status).toBe(200)
    expect((await load(IDENTITY_A)).response.status).toBe(503)
  })

  test("two identities announced together are both kept", async () => {
    const c = bundle(3)
    const installed = await attachMachine(IDENTITY_B, b, "i".repeat(43))
    const development = await attachMachine(IDENTITY_C, c, "d".repeat(43))
    try {
      expect(hex((await load(IDENTITY_C)).body)).toBe(hex(c.get("webview.js")!))
      expect((await load(IDENTITY_B)).response.status).toBe(200)
    } finally {
      await installed.close()
      await development.close()
    }
    expect(hex((await load(IDENTITY_B)).body)).toBe(hex(b.get("webview.js")!))
    expect(hex((await load(IDENTITY_C)).body)).toBe(hex(c.get("webview.js")!))
  })
})

/** A runtime of an earlier release: it signs an attach frame that claims
 *  `relayProtocolVersion` and announces no client identity. Resolves with the
 *  relay's answer. */
async function attachPreviousRuntime(key: Awaited<ReturnType<typeof runtimeKey>>, relayProtocolVersion: number) {
  const ws = new WebSocket(`${origin.replace("http", "ws")}/runtime/${key.id}`)
  const placementId = "v".repeat(43)
  const placement = { id: placementId, projectLabel: "flywheel", version: "0.0.10", protocolVersion: 10, state: "live" }
  const outcome = Promise.withResolvers<string>()
  ws.addEventListener("message", (event) => {
    const frame: { readonly type: string; readonly nonce?: string; readonly reason?: string } = JSON.parse(String(event.data))
    if (frame.type === "challenge" && frame.nonce !== undefined) {
      void key.sign(runtimeAttachSigningBytes({ nonce: frame.nonce, runtimeId: key.id, placementId })).then((signature) => {
        ws.send(JSON.stringify({ type: "attach", relayProtocolVersion, runtimeId: key.id, publicKey: key.publicKey, placement, devices: [], signature }))
      })
    } else if (frame.type === "attached") {
      outcome.resolve("attached")
    } else if (frame.type === "rejected") {
      outcome.resolve(`rejected ${frame.reason}`)
    }
  })
  return outcome.promise
}

describe("a runtime of an earlier relay protocol", () => {
  // Relay protocol 3 is the release before client assets, and 4 the release
  // before a machine reported the channels it saw end. The relay speaks only
  // the current version, so each is refused by name and its machine tells the
  // person to update.
  test.each([2, 3, 4])("relay protocol %i is refused by name", async (relayProtocolVersion) => {
    expect(await attachPreviousRuntime(await runtimeKey(), relayProtocolVersion)).toBe("rejected protocol_version")
  })
})

/** Device presence exactly as relay protocol 3 shaped it, pinned here: the
 *  phone app deployed before client assets decodes it this strictly, so a
 *  placement field it does not know would break it. */
const V3_PLACEMENT = Schema.Struct({
  id: Schema.String,
  projectLabel: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  protocolVersion: Schema.Number,
  state: Schema.Literals(["live", "dormant"]),
})
const decodeV3Presence = Schema.decodeUnknownSync(Schema.Struct({ type: Schema.Literal("presence"), placements: Schema.Array(V3_PLACEMENT) }), { onExcessProperty: "error" })

describe("the device lane keeps its version 3 shape", () => {
  test("presence from a runtime that announces its client keeps its version 3 shape through departure", async () => {
    const key = await runtimeKey()
    const device = await runtimeKey()
    const machine = await attachMachine(IDENTITY_A, bundle(9), "q".repeat(43), key, [device.id])
    const socket = new WebSocket(`${origin.replace("http", "ws")}/device/${key.id}`)
    try {
      let presence = Promise.withResolvers<unknown>()
      socket.addEventListener("message", (event) => {
        const frame: { readonly type: string; readonly nonce?: string } = JSON.parse(String(event.data))
        if (frame.type === "challenge" && frame.nonce !== undefined) {
          const nonce = frame.nonce
          void device.sign(deviceAttachSigningBytes({ nonce, runtimeId: key.id, deviceId: device.id })).then((signature) => {
            socket.send(JSON.stringify({ type: "presence", runtimeId: key.id, deviceId: device.id, publicKey: device.publicKey, signature }))
          })
        } else {
          presence.resolve(frame)
        }
      })
      try {
        const frame = decodeV3Presence(await presence.promise)
        expect(frame.placements.map((placement) => placement.id)).toEqual(["q".repeat(43)])
        presence = Promise.withResolvers<unknown>()
      } finally {
        await machine.close()
      }
      expect(decodeV3Presence(await presence.promise).placements).toEqual([])
      expect(socket.readyState).toBe(WebSocket.OPEN)
    } finally {
      socket.close()
    }
  })
})

describe("which client a runtime serves", () => {
  const currentUrl = (runtimeId: string) => `${origin}/client/${runtimeId}/current`

  test("answers the live identity, then the newest cached one, then 503", async () => {
    const key = await runtimeKey()
    const never = await relay.dispatchFetch(currentUrl(key.id))
    expect(never.status).toBe(503)
    expect(never.headers.get("cache-control")).toBe("no-store")
    expect(never.headers.get("access-control-allow-origin")).toBe("*")

    const a = bundle(4)
    const first = await attachMachine(IDENTITY_A, a, "r".repeat(43), key)
    try {
      const live = await relay.dispatchFetch(currentUrl(key.id))
      expect(live.status).toBe(200)
      expect(await live.json()).toEqual({ identity: IDENTITY_A })
      expect(live.headers.get("cache-control")).toBe("no-store")
      expect(live.headers.get("access-control-allow-origin")).toBe("*")
      expect(hex((await load(IDENTITY_A, "webview.js", key.id)).body)).toBe(hex(a.get("webview.js")!))
    } finally {
      await first.close()
    }
    // The machine is gone; the relay still knows the client it streamed.
    expect(await (await relay.dispatchFetch(currentUrl(key.id))).json()).toEqual({ identity: IDENTITY_A })

    // A live announcement wins over the cache, even before it was streamed.
    const second = await attachMachine(IDENTITY_B, bundle(5), "r".repeat(43), key)
    try {
      expect(await (await relay.dispatchFetch(currentUrl(key.id))).json()).toEqual({ identity: IDENTITY_B })
    } finally {
      await second.close()
    }
    expect(await (await relay.dispatchFetch(currentUrl(key.id))).json()).toEqual({ identity: IDENTITY_A })
  })
})
