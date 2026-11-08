import { describe, expect, jest, spyOn, test } from "bun:test"
import type { RemoteIdentity } from "../../../../../src/orchestration/modules/remote/remote-identity.js"
import { RELAY_PING, RELAY_PROTOCOL_VERSION, runtimeAttachSigningBytes, toBase64Url } from "../../../../../src/protocol/modules/remote/relay-protocol.js"
import { ControlSocket, fixture, identity, turn } from "./_relay-control-fixtures.js"
import { manualHeartbeatClock } from "../../../../helpers/heartbeat-clock.js"
import { Log } from "../../../../../src/infra/log.js"

describe("relay control ownership", () => {
  test("disposal joins deferred identity without dialing after it resolves", async () => {
    const pending = Promise.withResolvers<RemoteIdentity>()
    const f = fixture({ identity: () => pending.promise })
    f.channel.reconcile("start")
    await turn()
    let disposed = false
    const closing = f.channel.dispose("shutdown").then(() => { disposed = true })
    await turn()
    const joinedBeforeIdentity = disposed
    pending.resolve(identity)
    await turn()
    const dialsAfterDispose = f.sockets.length
    // Release the baseline leak so the regression has no surviving test work.
    for (const ws of f.sockets) { ws.open(); await turn(); ws.peerClose() }
    await closing
    expect(joinedBeforeIdentity).toBe(true)
    expect(dialsAfterDispose).toBe(0)
    expect(f.states).not.toContain("connected")
    expect(f.failures).toEqual([])
  })

  test("disposal closes and joins a provisional socket without a peer close", async () => {
    const f = fixture()
    f.channel.reconcile("start")
    await turn()
    const ws = f.sockets[0]!
    let disposed = false
    const closing = f.channel.dispose("shutdown").then(() => { disposed = true })
    await turn()
    const joinedWithoutPeer = disposed
    const closesBeforeOpen = [...ws.closes]
    ws.open()
    await turn()
    ws.message({ type: "attached" })
    const latePublication = f.states.includes("connected")
    ws.peerClose()
    await closing
    expect(joinedWithoutPeer).toBe(true)
    expect(closesBeforeOpen).toEqual([{ code: 1001, reason: "shutdown" }])
    expect(latePublication).toBe(false)
    expect(f.channel.connected()).toBe(false)
    expect(f.failures).toEqual([])
  })

  test("unwanted reconciliation cancels acquisition and can start a fresh attempt", async () => {
    const pending = Promise.withResolvers<RemoteIdentity>()
    let wanted = true
    let reads = 0
    const f = fixture({ wanted: () => wanted, identity: () => ++reads === 1 ? pending.promise : Promise.resolve(identity) })
    f.channel.reconcile("start")
    await turn()
    wanted = false
    f.channel.reconcile("not wanted")
    await turn()
    pending.resolve(identity)
    await turn()
    const unwantedDials = f.sockets.length
    for (const ws of f.sockets) { ws.open(); await turn(); ws.peerClose() }
    await turn()
    wanted = true
    f.channel.reconcile("start again")
    await turn()
    const fresh = f.sockets.at(-1)!
    fresh.open()
    await turn()
    fresh.message({ type: "attached" })
    await turn()
    expect(f.channel.connected()).toBe(true)
    const closing = f.channel.dispose("done")
    fresh.peerClose()
    await closing
    expect(unwantedDials).toBe(0)
    expect(reads).toBe(2)
  })

  test("stopping an attached channel joins signing and invalidates retained sends", async () => {
    const signature = Promise.withResolvers<Uint8Array>()
    const f = fixture({ identity: async () => ({ ...identity, sign: () => signature.promise }) })
    f.channel.reconcile("start")
    await turn()
    const ws = f.sockets[0]!
    ws.open()
    await turn()
    ws.message({ type: "challenge", nonce: "nonce" })
    ws.message({ type: "attached" })
    await turn()
    let disposed = false
    const closing = f.channel.dispose("shutdown").then(() => { disposed = true })
    await turn()
    const disposedBeforeSignature = disposed
    signature.resolve(new Uint8Array(64))
    const attached = f.links.find((link) => link.kind === "attached")
    const lateSend = attached?.kind === "attached" && attached.send({ type: "devices", devices: [] })
    ws.message({ type: "attached" })
    await turn()
    const lateFrames = [...ws.sent]
    ws.peerClose()
    await closing
    expect(disposedBeforeSignature).toBe(false)
    expect(attached).toBeDefined()
    expect(lateSend).toBe(false)
    expect(lateFrames).toEqual([])
    expect(f.states.filter((state) => state === "connected")).toHaveLength(1)
    expect(f.failures).toEqual([])
  })

  test("a live challenge preserves the signed attach contract", async () => {
    const signed: Uint8Array[] = []
    const signature = new Uint8Array(64).fill(7)
    const f = fixture({ identity: async () => ({ ...identity, sign: async (bytes) => { signed.push(bytes); return signature } }) })
    f.channel.reconcile("start")
    await turn()
    const ws = f.sockets[0]!
    ws.open()
    await turn()
    ws.message({ type: "challenge", nonce: "nonce" })
    await turn()
    const closing = f.channel.dispose("done")
    ws.peerClose()
    await closing
    expect(signed).toEqual([runtimeAttachSigningBytes({ nonce: "nonce", runtimeId: identity.runtimeId, placementId: "placement" })])
    expect(ws.sent.map((frame) => JSON.parse(frame))).toEqual([{ type: "attach", relayProtocolVersion: RELAY_PROTOCOL_VERSION, runtimeId: identity.runtimeId, publicKey: toBase64Url(identity.publicKey), placement: f.options.placement(), devices: ["device"], signature: toBase64Url(signature) }])
  })

  test.each([false, true])("unwanted reconciliation joins a socket with opened=%s before restarting", async (opened) => {
    let wanted = true
    const f = fixture({ wanted: () => wanted })
    f.channel.reconcile("start")
    await turn()
    const ws = f.sockets[0]!
    if (opened) {
      ws.open()
      await turn()
      ws.message({ type: "attached" })
    }
    wanted = false
    f.channel.reconcile("no devices")
    expect(f.channel.connected()).toBe(false)
    expect(f.channel.send({ type: "devices", devices: [] })).toBe(false)
    wanted = true
    f.channel.reconcile("devices restored")
    await turn()
    expect(ws.closes).toEqual([{ code: 1000, reason: "no devices" }])
    expect(f.sockets).toHaveLength(2)
    ws.open()
    ws.message({ type: "attached" })
    expect(f.channel.connected()).toBe(false)
    await Promise.all([f.channel.dispose("done"), f.channel.dispose("done")])
    expect(f.failures).toEqual([])
  })

  test("an acquisition failure backs off and reconciliation wakes a new attempt", async () => {
    let reads = 0
    const f = fixture({ identity: async () => { if (++reads === 1) throw new Error("identity unavailable"); return identity } })
    f.channel.reconcile("start")
    await turn()
    expect(f.failures).toEqual([{ error: "identity unavailable", outcome: "retry" }])
    expect(f.states).toEqual(["connecting", "reconnecting"])
    expect(f.sockets).toHaveLength(0)
    f.channel.reconcile("retry now")
    await turn()
    expect(f.sockets).toHaveLength(1)
    await f.channel.dispose("done")
  })

  test("a bad_signature refusal parks until the owner asks again", async () => {
    const f = fixture()
    f.channel.reconcile("start")
    await turn()
    const ws = f.sockets[0]!
    ws.open()
    await turn()
    ws.message({ type: "rejected", reason: "bad_signature" })
    ws.peerClose()
    await turn()
    expect(f.failures[0]?.outcome).toBe("parked")
    expect(f.states.at(-1)).toBe("off")
    expect(f.sockets).toHaveLength(1)
    f.channel.reconcile("store changed")
    await turn()
    expect(f.sockets).toHaveLength(2)
    await f.channel.dispose("done")
  })

  test("a rejection after the relay admitted the placement is a drop: the channel dials again", async () => {
    // Admission already proved the identity and the protocol version, so a
    // later refusal (a relay fault answered as `malformed`) is no reason to park.
    const f = fixture({ random: () => 0 })
    f.channel.reconcile("start")
    await turn()
    const ws = f.sockets[0]!
    ws.open()
    await turn()
    ws.message({ type: "attached" })
    await turn()
    jest.useFakeTimers()
    try {
      ws.message({ type: "rejected", reason: "malformed" })
      ws.peerClose()
      await Promise.resolve()
      jest.advanceTimersByTime(0)
      await Promise.resolve()
      expect(f.failures).toEqual([])
      expect(f.states.at(-1)).toBe("reconnecting")
      // The first reconnect backoff is 125 ms with this random.
      jest.advanceTimersByTime(125)
      await Promise.resolve()
    } finally {
      jest.useRealTimers()
    }
    await turn()
    expect(f.sockets).toHaveLength(2)
    await f.channel.dispose("done")
  })

  test("a protocol_version refusal dials again after minutes, not seconds, and attaches once the relay admits it", async () => {
    const f = fixture({ random: () => 1 })
    f.channel.reconcile("start")
    await turn()
    const refused = f.sockets[0]!
    refused.open()
    await turn()
    // Either side can heal a version refusal: the relay deploys the version
    // this build speaks, or a newer build arrives. The wait is long, so the
    // clock is faked from the refusal until the next dial.
    jest.useFakeTimers()
    try {
      refused.message({ type: "rejected", reason: "protocol_version" })
      refused.peerClose()
      await Promise.resolve()
      jest.advanceTimersByTime(0)
      await Promise.resolve()
      expect(f.failures).toEqual([{ error: `the relay does not admit relay protocol ${RELAY_PROTOCOL_VERSION}, which this Flywheel speaks; update Flywheel with \`flywheel update\`, or deploy the newest relay if you host it yourself. Flywheel asks again every few minutes`, outcome: "mismatched" }])
      expect(f.states.at(-1)).toBe("off")
      jest.advanceTimersByTime(60_000)
      await Promise.resolve()
      expect(f.sockets).toHaveLength(1)
      jest.advanceTimersByTime(4 * 60_000)
      await Promise.resolve()
      expect(f.sockets).toHaveLength(2)
    } finally {
      jest.useRealTimers()
    }
    await turn()
    const admitted = f.sockets[1]!
    admitted.open()
    await turn()
    admitted.message({ type: "attached" })
    await turn()
    expect(f.channel.connected()).toBe(true)
    expect(f.states.slice(-2)).toEqual(["connecting", "connected"])
    const closing = f.channel.dispose("done")
    admitted.peerClose()
    await closing
  })

  test("the heartbeat pings, detects silence, and releases without a peer close", async () => {
    const heartbeat = manualHeartbeatClock()
    const f = fixture({ heartbeat: { intervalMs: 2, deadlineMs: 12, clock: heartbeat.clock } })
    f.channel.reconcile("start")
    await turn()
    const ws = f.sockets[0]!
    ws.open()
    await turn()
    ws.message({ type: "attached" })
    heartbeat.advance(2)
    expect(ws.pings).toContain(RELAY_PING)
    heartbeat.advance(10)
    expect(ws.closes).toEqual([])
    heartbeat.advance(2)
    await turn()
    expect(ws.closes).toEqual([{ code: 4000, reason: "heartbeat timeout" }])
    expect(f.channel.connected()).toBe(false)
    expect(f.states.at(-1)).toBe("reconnecting")
    await f.channel.dispose("done")
    const pings = [...ws.pings]
    heartbeat.advance(5)
    expect(ws.pings).toEqual(pings)
  })

  test("reports a data channel that ended at once, and again on each attach until the relay would have swept it", async () => {
    // The machine sees its side of a channel end before the relay can. The
    // report goes on the attached control socket, but the same drop often
    // takes that socket too, so every attach within the channel's heartbeat
    // deadline repeats it; after that the relay has closed the channel itself.
    let now = 1_000
    const f = fixture({ now: () => now, heartbeat: { intervalMs: 5_000, deadlineMs: 15_000, clock: manualHeartbeatClock().clock } })
    const ended = (ws: (typeof f.sockets)[number]) => ws.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "channel.ended")
    f.channel.reconcile("start")
    await turn()
    const first = f.sockets[0]!
    first.open()
    await turn()
    first.message({ type: "attached" })
    await turn()
    // A clean close needs no report.
    f.channel.channelOpened("clean")({ abrupt: false })
    f.channel.channelOpened("one")({ abrupt: true })
    expect(ended(first)).toEqual([{ type: "channel.ended", channelId: "one" }])

    first.peerClose()
    await turn()
    f.channel.channelOpened("two")({ abrupt: true })
    f.channel.reconcile("retry now")
    await turn()
    const second = f.sockets[1]!
    second.open()
    await turn()
    now += 10_000
    second.message({ type: "attached" })
    await turn()
    expect(ended(second)).toEqual([{ type: "channel.ended", channelId: "one" }, { type: "channel.ended", channelId: "two" }])

    second.peerClose()
    await turn()
    f.channel.reconcile("retry now")
    await turn()
    const third = f.sockets[2]!
    third.open()
    await turn()
    now += 5_000
    third.message({ type: "attached" })
    await turn()
    expect(ended(third)).toEqual([])
    const closing = f.channel.dispose("done")
    third.peerClose()
    await closing
  })

  test("a dial of a channel id reports its end only when no other dial of that id is open, and a new dial withdraws a stale report", async () => {
    // The relay can send one channel's `open` to an old and a new control
    // socket; the machine dials both, the first to present the ticket wins,
    // and the loser must not close the winner's device when its socket drops.
    let now = 1_000
    const f = fixture({ now: () => now, heartbeat: { intervalMs: 5_000, deadlineMs: 15_000, clock: manualHeartbeatClock().clock } })
    const ended = (ws: (typeof f.sockets)[number]) => ws.sent.map((frame) => JSON.parse(frame)).filter((frame) => frame.type === "channel.ended")
    f.channel.reconcile("start")
    await turn()
    const first = f.sockets[0]!
    first.open()
    await turn()
    first.message({ type: "attached" })
    await turn()

    const loser = f.channel.channelOpened("x")
    const winner = f.channel.channelOpened("x")
    loser({ abrupt: true })
    expect(ended(first)).toEqual([])
    winner({ abrupt: true })
    expect(ended(first)).toEqual([{ type: "channel.ended", channelId: "x" }])

    // The relay re-sends `open` for the same id and the new dial is accepted;
    // a later attach must not repeat the report that would close it.
    const redial = f.channel.channelOpened("x")
    first.peerClose()
    await turn()
    f.channel.reconcile("retry now")
    await turn()
    const second = f.sockets[1]!
    second.open()
    await turn()
    now += 1_000
    second.message({ type: "attached" })
    await turn()
    expect(ended(second)).toEqual([])
    redial({ abrupt: false })
    const closing = f.channel.dispose("done")
    second.peerClose()
    await closing
  })

  test("a normal close joins pending challenge work before reconnecting", async () => {
    const signature = Promise.withResolvers<Uint8Array>()
    const f = fixture({ identity: async () => ({ ...identity, sign: () => signature.promise }) })
    f.channel.reconcile("start")
    await turn()
    const ws = f.sockets[0]!
    ws.open()
    await turn()
    ws.message({ type: "challenge", nonce: "nonce" })
    ws.peerClose()
    await turn()
    expect(f.sockets).toHaveLength(1)
    signature.resolve(new Uint8Array(64))
    await turn()
    f.channel.reconcile("retry now")
    await turn()
    expect(ws.sent).toEqual([])
    expect(f.sockets).toHaveLength(2)
    await f.channel.dispose("done")
  })
})

describe("the relay a placement attaches to", () => {
  test("a changed relay ends the running session and the next dial reaches the new relay; an unchanged one keeps it", async () => {
    let relay = "wss://first.invalid"
    const dials: { url: string; ws: ControlSocket }[] = []
    const f = fixture({
      relayUrl: () => relay,
      connect: (url) => {
        const ws = new ControlSocket()
        dials.push({ url, ws })
        return ws
      },
    })
    f.channel.reconcile("start")
    await turn()
    const first = dials[0]!.ws
    first.open()
    await turn()
    first.message({ type: "challenge", nonce: "nonce" })
    await turn()
    first.message({ type: "attached" })
    await turn()
    expect(f.channel.connected()).toBe(true)

    f.channel.reconcile("same relay")
    await turn()
    expect(dials).toHaveLength(1)
    expect(first.closes).toEqual([])

    relay = "wss://second.invalid"
    f.channel.reconcile("relay changed")
    for (let step = 0; step < 5 && dials.length < 2; step++) await turn()
    expect(first.closes).toEqual([{ code: 1000, reason: "relay changed" }])
    expect(dials.map(({ url }) => new URL(url).host)).toEqual(["first.invalid", "second.invalid"])
    await f.channel.dispose("done")
  })

  test("a relay that changes while the channel backs off from a failed dial is the next dial's, with no restart", async () => {
    const info = spyOn(Log.create({ service: "relay-control-channel" }), "info").mockImplementation(() => {})
    try {
      let relay = "wss://first.invalid"
      const dials: { url: string; ws: ControlSocket }[] = []
      const f = fixture({
        relayUrl: () => relay,
        connect: (url) => {
          const ws = new ControlSocket()
          dials.push({ url, ws })
          return ws
        },
      })
      f.channel.reconcile("start")
      await turn()
      dials[0]!.ws.peerClose()
      await turn()
      expect(f.failures).toEqual([{ error: "relay closed the connection before it opened", outcome: "retry" }])
      expect(dials).toHaveLength(1)

      relay = "wss://second.invalid"
      f.channel.reconcile("relay changed")
      await turn()
      expect(dials.map(({ url }) => new URL(url).host)).toEqual(["first.invalid", "second.invalid"])
      expect(info.mock.calls.map(([message]) => message)).not.toContain("relay control channel redialing a changed relay")
      await f.channel.dispose("done")
    } finally {
      info.mockRestore()
    }
  })
})

describe("relay control channel records", () => {
  test("record the first attach and the first interruption in full, and count later drops once", async () => {
    const log = Log.create({ service: "relay-control-channel" })
    const info = spyOn(log, "info").mockImplementation(() => {})
    const warn = spyOn(log, "warn").mockImplementation(() => {})
    try {
      const f = fixture()
      const attach = async (ws: ControlSocket): Promise<void> => {
        ws.open()
        await turn()
        ws.message({ type: "challenge", nonce: "nonce" })
        await turn()
        ws.message({ type: "attached" })
        await turn()
      }
      const drop = async (ws: ControlSocket, code: number): Promise<void> => {
        ws.readyState = WebSocket.CLOSED
        ws.dispatchEvent(new CloseEvent("close", { code, reason: "" }))
        await turn()
        f.channel.reconcile("retry now")
        await turn()
      }
      f.channel.reconcile("start")
      await turn()
      await attach(f.sockets[0]!)
      await drop(f.sockets[0]!, 1006)
      await attach(f.sockets[1]!)
      await drop(f.sockets[1]!, 1006)
      await attach(f.sockets[2]!)
      await drop(f.sockets[2]!, 1001)
      await f.channel.dispose("done")

      expect(info.mock.calls.map(([message]) => message)).toEqual(["relay control channel attached", "relay control channel closed"])
      expect(warn.mock.calls.map(([message]) => message)).toEqual(["relay control channel ended", "relay control channel ended again"])
      expect(warn.mock.calls[0]?.[1]).toMatchObject({ placement: "placement", cause: "1006", outcome: "retry", attachedMs: expect.any(Number), nextDialMs: expect.any(Number) })
      expect(warn.mock.calls[1]?.[1]).toMatchObject({ placement: "placement", count: 2, byCause: { "1006": 1, "1001": 1 } })

      // A relay change ends an attached session without an interruption
      // record; the new relay's first failure must not carry its admission.
      let relay = "wss://first.invalid"
      const moved = fixture({ relayUrl: () => relay })
      moved.channel.reconcile("start")
      await turn()
      await attach(moved.sockets[0]!)
      relay = "wss://second.invalid"
      moved.channel.reconcile("relay changed")
      for (let step = 0; step < 5 && moved.sockets.length < 2; step++) await turn()
      warn.mockClear()
      moved.sockets[1]!.peerClose()
      await turn()
      await moved.channel.dispose("done")
      expect(warn.mock.calls.map(([message]) => message)).toEqual(["relay control channel ended"])
      expect(warn.mock.calls[0]?.[1]).toMatchObject({ cause: "relay closed the connection before it opened", outcome: "retry" })
      expect(warn.mock.calls[0]?.[1]).not.toHaveProperty("attachedMs")
    } finally {
      info.mockRestore()
      warn.mockRestore()
    }
  })
})
