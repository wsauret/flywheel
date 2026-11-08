import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RelayControlChannelOptions } from "../../../../../src/orchestration/modules/remote/relay-control-channel.js"
import { ASSET_CHUNK_BYTES, decodeAssetChunk, newAssetRequestId } from "../../../../../src/protocol/modules/remote/relay-protocol.js"
import { fixture, turn, type ControlSocket } from "./_relay-control-fixtures.js"

describe("the client this process serves, through the relay", () => {
  const IDENTITY = "e".repeat(64)
  let root: string
  const script = new Uint8Array(ASSET_CHUNK_BYTES * 2 + 99).map((_, index) => index % 251)

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "relay-client-assets-"))
    await mkdir(join(root, "phone"))
    await writeFile(join(root, "phone", "webview.js"), script)
    await writeFile(join(root, "client.json"), JSON.stringify({ identity: IDENTITY }))
  })
  afterAll(async () => { await rm(root, { recursive: true, force: true }) })

  async function attached(overrides: Partial<RelayControlChannelOptions> = {}) {
    const f = fixture({ client: async () => ({ identity: IDENTITY, root }), ...overrides })
    f.channel.reconcile("start")
    await turn()
    const ws = f.sockets[0]!
    ws.open()
    await turn()
    ws.message({ type: "challenge", nonce: "nonce" })
    await turn()
    ws.message({ type: "attached" })
    await turn()
    return { ...f, ws }
  }

  async function settled(ws: ControlSocket, requestId: string): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (ws.sent.some((frame) => frame.includes(requestId) && /asset\.(end|missing)/.test(frame))) return
      await turn()
    }
    throw new Error("the asset request never settled")
  }

  test("the placement announces the identity of the client this process serves", async () => {
    const f = await attached()
    const attach = JSON.parse(f.ws.sent[0]!)
    expect(attach.placement).toEqual({ ...f.options.placement(), clientIdentity: IDENTITY })
    const closing = f.channel.dispose("done")
    f.ws.peerClose()
    await closing
  })

  test("streams its own phone file in chunk frames between a head and an end", async () => {
    const f = await attached()
    const requestId = newAssetRequestId()
    f.ws.message({ type: "asset.request", requestId, identity: IDENTITY, file: "webview.js" })
    await settled(f.ws, requestId)
    const frames = f.ws.sent.slice(1).map((frame) => JSON.parse(frame))
    expect(frames).toEqual([
      { type: "asset.head", requestId, contentType: "application/javascript; charset=utf-8" },
      { type: "asset.end", requestId },
    ])
    const chunks = f.ws.binary.map((frame) => decodeAssetChunk(frame))
    expect(chunks.map((chunk) => chunk.requestId)).toEqual([requestId, requestId, requestId])
    expect(chunks.every((chunk) => chunk.bytes.byteLength <= ASSET_CHUNK_BYTES)).toBe(true)
    expect(Buffer.concat(chunks.map((chunk) => chunk.bytes)).equals(Buffer.from(script))).toBe(true)
    const closing = f.channel.dispose("done")
    f.ws.peerClose()
    await closing
  })

  test("refuses another identity, a file outside the phone shell, and a file it does not have", async () => {
    const f = await attached()
    const other = newAssetRequestId()
    const outside = newAssetRequestId()
    const absent = newAssetRequestId()
    f.ws.message({ type: "asset.request", requestId: other, identity: "f".repeat(64), file: "webview.js" })
    f.ws.message({ type: "asset.request", requestId: outside, identity: IDENTITY, file: "client.json" })
    f.ws.message({ type: "asset.request", requestId: absent, identity: IDENTITY, file: "webview.css" })
    for (const requestId of [other, outside, absent]) await settled(f.ws, requestId)
    // Each request is answered on its own and carries its request id. The two
    // failed reads settle in file-system order, so the order of the answers is
    // not part of the contract.
    const answers = f.ws.sent.slice(1).map((frame) => JSON.parse(frame))
    expect(answers).toHaveLength(3)
    expect(answers).toEqual(expect.arrayContaining([
      { type: "asset.missing", requestId: other },
      { type: "asset.missing", requestId: outside },
      { type: "asset.missing", requestId: absent },
    ]))
    expect(f.ws.binary).toEqual([])
    const closing = f.channel.dispose("done")
    f.ws.peerClose()
    await closing
  })

  test("a process with no client announces none and refuses every request", async () => {
    const f = await attached({ client: async () => undefined })
    expect(JSON.parse(f.ws.sent[0]!).placement).toEqual(f.options.placement())
    const requestId = newAssetRequestId()
    f.ws.message({ type: "asset.request", requestId, identity: IDENTITY, file: "webview.js" })
    await settled(f.ws, requestId)
    expect(JSON.parse(f.ws.sent.at(-1)!)).toEqual({ type: "asset.missing", requestId })
    const closing = f.channel.dispose("done")
    f.ws.peerClose()
    await closing
  })
})
