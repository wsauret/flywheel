import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Redacted } from "effect"
import * as store from "../../../../../src/orchestration/modules/remote/remote-pairing-store.js"
import { createRemoteAccess, type RemoteAccess } from "../../../../../src/orchestration/modules/remote/remote-access.js"
import type { AccountServiceInstallation } from "../../../../../src/orchestration/app-service/account-service-installation.js"
import * as control from "../../../../../src/orchestration/modules/remote/relay-control-channel.js"
import * as identities from "../../../../../src/orchestration/modules/remote/remote-identity.js"
import { installationOf } from "../../app-service/_account-service-fixtures.js"
import { RELAY_PING, toBase64Url, type OpenFrame } from "../../../../../src/protocol/modules/remote/relay-protocol.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"

class RemoteSocket extends EventTarget {
  readyState: WebSocket["readyState"] = WebSocket.CONNECTING
  binaryType: WebSocket["binaryType"] = "blob"
  bufferedAmount = 0
  peer: RemoteSocket | undefined
  /** Every frame but the heartbeat's pings, which no peer here answers. */
  readonly sent: unknown[] = []
  readonly closes: { code: number | undefined; reason: string | undefined }[] = []
  send(data: unknown): void {
    if (data === RELAY_PING) return
    this.sent.push(data)
    this.peer?.dispatchEvent(new MessageEvent("message", { data }))
  }
  close(code?: number, reason?: string): void {
    this.closes.push({ code, reason })
    this.readyState = WebSocket.CLOSING
    if (this.peer) { this.peer.peerClose(); this.peerClose() }
  }
  open(): void { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")) }
  message(frame: unknown): void { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })) }
  peerClose(): void {
    this.readyState = WebSocket.CLOSED
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }))
  }
}

const turn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const identity: identities.RemoteIdentity = { runtimeId: "runtime", publicKey: new Uint8Array(32), sign: async () => new Uint8Array(64) }
const deviceId = "d".repeat(43)
const frame: OpenFrame = { type: "open", kind: "device", channelId: "channel", ticket: "ticket", deviceId }
const restores: (() => void)[] = []
const remotes: RemoteAccess[] = []
const userDataRoots: string[] = []

async function fixture(identityRead: () => Promise<identities.RemoteIdentity> = async () => identity, options: { storedIdentity?: boolean; installation?: AccountServiceInstallation } = {}) {
  const userDataRoot = mkdtempSync(join(tmpdir(), "flywheel-remote-access-ownership-"))
  userDataRoots.push(userDataRoot)
  const record: store.RemotePairingStore = { identity: options.storedIdentity ? { publicKey: "key", privateKey: Redacted.make("private") } : undefined, vapid: undefined, relayUrl: undefined, devices: [{ id: deviceId, label: "Phone", pairedAt: 1, publicKey: toBase64Url(new Uint8Array(32)) }] }
  const realControl = control.createRelayControlChannel
  let controlOptions!: control.RelayControlChannelOptions
  let controlChannel!: control.RelayControlChannel
  const mocks = [
    spyOn(store, "readRemotePairingStore").mockImplementation(() => record),
    spyOn(store, "watchRemotePushStore").mockImplementation(() => () => {}),
    spyOn(store, "mutateRemotePairingStore").mockImplementation(async (_root, _lane, mutate) => { mutate(record) }),
    spyOn(identities, "ensureRemoteIdentity").mockImplementation(identityRead),
    spyOn(control, "createRelayControlChannel").mockImplementation((input) => { controlOptions = input; controlChannel = realControl(input); return controlChannel }),
  ]
  restores.push(...mocks.map((mock) => () => mock.mockRestore()))
  const sockets: RemoteSocket[] = []
  const publications: RuntimeUiPatchInput[] = []
  const remote = createRemoteAccess({
    projectRegistry: { list: async () => [], record: async (input) => ({ id: "project", lastAttachedAt: 0, ...input }), forget: async () => {}, watch: () => () => {} },
    userDataRoot, lane: "installed", accountHome: "/account", projectRoot: "/project", version: "test",
    relayUrl: "wss://relay.invalid", random: () => 0,
    ...(options.installation ? { installation: options.installation } : {}),
    publish: (input) => { publications.push(input) },
    connectWebSocket: () => {
      const socket = new RemoteSocket()
      sockets.push(socket)
      return socket
    },
  })
  remotes.push(remote)
  await turn()
  return { remote, sockets, publications, options: controlOptions, controlChannel, record }
}

async function openData(f: Awaited<ReturnType<typeof fixture>>) {
  const controlSocket = f.sockets[0]!
  controlSocket.open()
  controlSocket.message({ type: "attached" })
  controlSocket.message(frame)
  await turn()
  return f.sockets[1]!
}

afterEach(async () => {
  for (const remote of remotes.splice(0)) await remote.dispose()
  for (const restore of restores.splice(0).toReversed()) restore()
  for (const userDataRoot of userDataRoots.splice(0)) rmSync(userDataRoot, { recursive: true, force: true })
})

describe("remote data ownership", () => {
  test("disposal joins pairing identity and refuses its late timer acquisition", async () => {
    const pending = Promise.withResolvers<identities.RemoteIdentity>()
    const f = await fixture(() => pending.promise)
    const pairing = f.remote.openPairing()
    const outcome = pairing.then(() => "opened", (error: unknown) => error instanceof Error ? error.message : "failed")
    await turn()
    let settled = false
    const closing = f.remote.dispose().then(() => { settled = true })
    await turn()
    const joinedEarly = settled
    const published = f.publications.length
    pending.resolve(identity)
    await closing
    expect(joinedEarly).toBe(false)
    expect(await outcome).toBe("Remote access is off")
    expect(f.remote.view().pairing).toBeNull()
    expect(f.publications).toHaveLength(published)
    expect(f.sockets).toHaveLength(0)
    await expect(f.remote.openPairing()).rejects.toThrow("Remote access is off")
  })

  test("disposal joins startup store loading and prevents a late host probe", async () => {
    const pending = Promise.withResolvers<identities.RemoteIdentity>()
    let probed = 0
    const f = await fixture(() => pending.promise, { storedIdentity: true, installation: installationOf({ installed: async () => { probed++; return false } }) })
    let settled = false
    const closing = f.remote.dispose().then(() => { settled = true })
    await turn()
    const joinedEarly = settled
    pending.resolve(identity)
    await closing
    expect(joinedEarly).toBe(false)
    expect(probed).toBe(0)
    expect(f.sockets).toHaveLength(0)
    expect(f.remote.view().processInitiation).toBeUndefined()
  })

  test("publishes no process-initiation capability without an installation authority", async () => {
    const f = await fixture()
    expect(f.remote.view().processInitiation).toBeUndefined()
  })

  test("omits process initiation when the installation authority has no installed status", async () => {
    const f = await fixture(undefined, { installation: installationOf({ installed: async () => null }) })
    expect(f.remote.view().processInitiation).toBeUndefined()
  })

  test("publishes the account logind names while Process initiation is on and lingering is off for it", async () => {
    const f = await fixture(undefined, { installation: installationOf({ installed: async () => true, lingerOffFor: async () => "wes" }) })
    expect(f.remote.view()).toMatchObject({ processInitiation: "on", lingerOffFor: "wes" })
  })

  test.each([
    ["while Process initiation is off", false, "wes", "off", 0],
    ["when logind names no account", true, undefined, "on", 1],
  ] as const)("publishes no lingering reading %s", async (_case, installed, logind, processInitiation, reads) => {
    let asked = 0
    const f = await fixture(undefined, { installation: installationOf({ installed: async () => installed, lingerOffFor: async () => { asked++; return logind } }) })
    expect(f.remote.view().processInitiation).toBe(processInitiation)
    expect(f.remote.view().lingerOffFor).toBeUndefined()
    expect(asked).toBe(reads)
  })

  test.each([
    ["Process initiation turns off", (): boolean => false, "off"],
    ["Process initiation can no longer be read", (): boolean => { throw new Error("status read failed") }, "unavailable"],
  ] as const)("drops the lingering reading once %s", async (_case, laterRead, processInitiation) => {
    let reads = 0
    const f = await fixture(undefined, { installation: installationOf({ installed: async () => ++reads === 1 || laterRead(), lingerOffFor: async () => "wes" }) })
    expect(f.remote.view().lingerOffFor).toBe("wes")
    await f.remote.setProcessInitiation(false)
    expect(f.remote.view().processInitiation).toBe(processInitiation)
    expect(f.remote.view().lingerOffFor).toBeUndefined()
  })

  test("publishes Process initiation before logind answers about lingering", async () => {
    const logind = Promise.withResolvers<string | undefined>()
    const f = await fixture(undefined, { installation: installationOf({ installed: async () => true, lingerOffFor: () => logind.promise }) })
    const published = () => f.publications.flatMap((publication) => publication.payload.kind === "remote.changed" ? [publication.payload.remote] : []).at(-1)
    const beforeLogind = published()

    logind.resolve("wes")
    await turn()
    expect(beforeLogind).toMatchObject({ processInitiation: "on" })
    expect(beforeLogind).not.toHaveProperty("lingerOffFor")
    expect(published()).toMatchObject({ processInitiation: "on", lingerOffFor: "wes" })
  })

  test("drops a lingering reading that answers after Process initiation turned off", async () => {
    const logind = Promise.withResolvers<string | undefined>()
    let on = true
    const f = await fixture(undefined, { installation: installationOf({ installed: async () => on, uninstall: async () => { on = false }, lingerOffFor: () => logind.promise }) })
    await f.remote.setProcessInitiation(false)

    logind.resolve("wes")
    await turn()
    expect(f.remote.view().processInitiation).toBe("off")
    expect(f.remote.view().lingerOffFor).toBeUndefined()
  })

  test("repair installs and rechecks unavailable process initiation", async () => {
    let installed = false
    let statusReads = 0
    let repairs = 0
    const f = await fixture(undefined, { installation: installationOf({
      installed: async () => {
        statusReads++
        if (statusReads === 1) throw new Error("status read failed")
        return installed
      },
      install: async () => { repairs++; installed = true },
      uninstall: async () => { installed = false },
    }) })
    expect(f.remote.view().processInitiation).toBe("unavailable")
    await f.remote.setProcessInitiation(true)
    expect(repairs).toBe(1)
    expect(statusReads).toBe(2)
    expect(f.remote.view().processInitiation).toBe("on")
  })

  test("does not expose legacy pairing-store project rows", async () => {
    const f = await fixture()
    expect(f.remote.view().projects).toEqual([])
  })

  test("joins deferred identity and rejects its late data-channel continuation", async () => {
    const pending = Promise.withResolvers<identities.RemoteIdentity>()
    const f = await fixture(() => pending.promise)
    const opened = f.options.onOpen(frame, () => {})
    await turn()
    let settled = false
    const closing = f.remote.dispose().then(() => { settled = true })
    await turn()
    const joinedEarly = settled
    pending.resolve(identity)
    await turn()
    for (const ws of f.sockets) { ws.open(); ws.peerClose() }
    await Promise.all([opened, closing])
    const count = f.publications.length
    const lateOpen = f.options.onOpen(frame, () => {})
    await turn()
    for (const ws of f.sockets) { ws.open(); ws.peerClose() }
    await lateOpen
    expect(joinedEarly).toBe(false)
    expect(f.sockets).toHaveLength(0)
    expect(f.publications).toHaveLength(count)
  })

  test("cancels provisional acquisition before open and prevents late send or publication", async () => {
    const f = await fixture()
    let accepted = 0
    f.remote.acceptChannels(async () => { accepted++ })
    const ws = await openData(f)
    let settled = false
    const closing = f.remote.dispose().then(() => { settled = true })
    await turn()
    const closedBeforeOpen = [...ws.closes]
    const joinedWithoutPeer = settled
    const count = f.publications.length
    ws.open()
    await turn()
    ws.peerClose()
    await closing
    expect(closedBeforeOpen).toEqual([{ code: 1001, reason: "runtime stopping" }])
    expect(joinedWithoutPeer).toBe(true)
    expect(ws.sent).toEqual([])
    expect(accepted).toBe(0)
    expect(f.remote.view().attachedClients).toBe(0)
    expect(f.publications).toHaveLength(count)
  })

  test("control reconnect preserves active data, and disposal joins the accept cleanup", async () => {
    const f = await fixture()
    const cleanup = Promise.withResolvers<void>()
    let accepted = false
    f.remote.acceptChannels(async () => { accepted = true; await cleanup.promise })
    const ws = await openData(f)
    ws.open()
    await turn()
    expect(accepted).toBe(true)
    expect(ws.sent).toEqual([JSON.stringify({ type: "accept", runtimeId: identity.runtimeId, channelId: frame.channelId, ticket: frame.ticket })])
    expect(f.remote.view().attachedClients).toBe(1)
    f.sockets[0]!.peerClose()
    await turn()
    expect(f.remote.view().connection).toBe("reconnecting")
    expect(ws.closes).toEqual([])
    expect(f.remote.view().attachedClients).toBe(1)
    f.controlChannel.reconcile("retry now")
    await turn()
    f.sockets[2]!.open()
    f.sockets[2]!.message({ type: "attached" })
    await turn()
    expect(f.remote.view().connection).toBe("connected")
    expect(ws.closes).toEqual([])
    expect(f.remote.view().attachedClients).toBe(1)
    let settled = false
    const closing = Promise.all([f.remote.dispose(), f.remote.dispose()]).then(() => { settled = true })
    await turn()
    const joinedEarly = settled
    ws.peerClose()
    cleanup.resolve()
    await closing
    expect(joinedEarly).toBe(false)
    expect(f.remote.view().attachedClients).toBe(0)
  })

  test("shutdown joins a sealed-channel signature without sending its late hello", async () => {
    const signature = Promise.withResolvers<Uint8Array>()
    const signing = Promise.withResolvers<void>()
    const f = await fixture(async () => ({ ...identity, sign: () => { signing.resolve(); return signature.promise } }))
    f.remote.acceptChannels(async (socket) => { await Effect.runPromiseExit(socket.run(() => {})) })
    const ws = await openData(f)
    ws.open()
    await signing.promise
    const before = [...ws.sent]
    let settled = false
    const closing = f.remote.dispose().then(() => { settled = true })
    await turn()
    const joinedEarly = settled
    ws.peerClose()
    signature.resolve(new Uint8Array(64))
    await closing
    expect(joinedEarly).toBe(false)
    expect(ws.sent).toEqual(before)
    expect(f.remote.view().attachedClients).toBe(0)
  })

  test("revocation during provisional acquisition cannot admit the device", async () => {
    const f = await fixture()
    let accepted = false
    f.remote.acceptChannels(async () => { accepted = true })
    const ws = await openData(f)
    await f.remote.revokeDevice(deviceId)
    ws.open()
    await turn()
    ws.peerClose()
    await f.remote.dispose()
    expect(accepted).toBe(false)
    expect(ws.closes.some((close) => close.code === 1008)).toBe(true)
  })

  test("pairing interruption joins its pending signature and sends no late hello", async () => {
    const signature = Promise.withResolvers<Uint8Array>()
    const signing = Promise.withResolvers<void>()
    const f = await fixture(async () => ({ ...identity, sign: () => { signing.resolve(); return signature.promise } }))
    const window = await f.remote.openPairing()
    const controlSocket = f.sockets[0]!
    controlSocket.open()
    controlSocket.message({ type: "attached" })
    controlSocket.message({ type: "open", kind: "pairing", channelId: "pairing", ticket: "ticket", windowId: window.windowId })
    await turn()
    const ws = f.sockets[1]!
    ws.open()
    await signing.promise
    const before = [...ws.sent]
    let settled = false
    const closing = f.remote.dispose().then(() => { settled = true })
    await turn()
    const joinedEarly = settled
    signature.resolve(new Uint8Array(64))
    ws.peerClose()
    await closing
    expect(joinedEarly).toBe(false)
    expect(ws.sent).toEqual(before)
    expect(f.remote.view().pairing).toBeNull()
  })

  test("open failure releases the provisional channel without admitting a device", async () => {
    const f = await fixture()
    let accepted = false
    f.remote.acceptChannels(async () => { accepted = true })
    const ws = await openData(f)
    ws.dispatchEvent(new Event("error"))
    await turn()
    expect(ws.closes).toEqual([{ code: 1000, reason: "" }])
    expect(accepted).toBe(false)
    const before = [...ws.sent]
    ws.open()
    await turn()
    expect(ws.sent).toEqual(before)
  })

})
