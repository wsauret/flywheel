import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { Deferred, Effect, Redacted, Stream } from "effect"
import { Socket } from "effect/socket"

import * as pairingStore from "../../../../../src/orchestration/modules/remote/remote-pairing-store.js"
import { mutateRemotePairingStore, readRemotePairingStore } from "../../../../../src/orchestration/modules/remote/remote-pairing-store.js"
import { ensureRemoteIdentity } from "../../../../../src/orchestration/modules/remote/remote-identity.js"
import { createAccountProjectRegistry } from "../../../../../src/orchestration/app-service/account-project-registry.js"
import type { NotificationEpisodeInput } from "../../../../../src/infra/notification-episode.js"
import { createRemoteAccess, placementId, type RemoteAccess } from "../../../../../src/orchestration/modules/remote/remote-access.js"
import { attachDeviceChannel, openPairingChannel, RELAY_HEARTBEAT } from "../../../../../src/protocol/modules/remote/relay-channel.js"
import {
  asKeyPair,
  DEFAULT_RELAY_URL,
  decodeJsonFrame,
  decodePairingResult,
  fromBase64Url,
  keyDigest,
  parsePairingCodeUrl,
  statedSilenceDeadlineMs,
  toBase64Url,
} from "../../../../../src/protocol/modules/remote/relay-protocol.js"
import type { PairedDevice } from "../../../../../src/orchestration/modules/remote/remote-pairing-store.js"
import type { RuntimeUiPatchInput } from "../../../../../src/protocol/runtime-ui-protocol-types.js"
import { FailedRelaySocket, PendingRelaySocket, startRelayStub, type RelayStub } from "./relay-stub.js"
import { manualHeartbeatClock } from "../../../../helpers/heartbeat-clock.js"
import { deviceIdentity, fromText, sealDevice, text, viewWhere, waitFor } from "./_remote-device-fixtures.js"

/** The runtime's remote-access service against an in-process relay that speaks
 *  the contract: pairing, attaching, revocation, reconnect, and the one thing
 *  the whole design rests on, that the relay pumps frames it cannot read. */

describe("remote access against a relay", () => {
  let stub: RelayStub
  let userDataRoot: string
  let projectRoot: string
  const published: RuntimeUiPatchInput[] = []
  const notifications: NotificationEpisodeInput[] = []
  const remotes: RemoteAccess[] = []
  const registries: ReturnType<typeof createAccountProjectRegistry>[] = []

  const createRemote = (overrides: Partial<Parameters<typeof createRemoteAccess>[0]> = {}) => {
    const projectRegistry = createAccountProjectRegistry({ userDataRoot })
    registries.push(projectRegistry)
    const remote = createRemoteAccess({
      projectRegistry,
      userDataRoot,
      lane: "installed",
      accountHome: "/account",
      projectRoot,
      version: "test",
      publish: (input) => { published.push(input) },
      notify: (operation) => { notifications.push(operation) },
      relayUrl: stub.url,
      appOrigin: "https://remote.example.test",
      ...overrides,
    })
    remotes.push(remote)
    return remote
  }

  /** Pairs a fresh device through the full exchange and returns its identity. */
  async function pairDevice(remote: RemoteAccess, label = "test phone", existingDevice?: Awaited<ReturnType<typeof deviceIdentity>>) {
    const window = await remote.openPairing()
    await viewWhere(remote, (view) => view.connection === "connected")
    const code = parsePairingCodeUrl(window.code)
    const runtimeId = await keyDigest(fromBase64Url(code.publicKey))
    const device = existingDevice ?? await deviceIdentity()
    const ws = await openPairingChannel(stub.url, runtimeId, code.windowId)
    const channel = await sealDevice(ws, device, { kind: "pairing", secret: fromBase64Url(code.secret) })
    await Effect.runPromise(channel.write(text(JSON.stringify({ type: "pair.request", label }))))
    await waitFor(() => channel.received.length === 1)
    const result = decodeJsonFrame(decodePairingResult, fromText(channel.received[0]!))
    await channel.close()
    return { device, result, runtimeId, code }
  }

  beforeEach(() => {
    stub = startRelayStub()
    userDataRoot = mkdtempSync(join(tmpdir(), "flywheel-remote-user-"))
    projectRoot = mkdtempSync(join(tmpdir(), "flywheel-remote-project-"))
    published.length = 0
    notifications.length = 0
  })

  afterEach(async () => {
    for (const remote of remotes.splice(0)) await remote.dispose()
    for (const registry of registries.splice(0)) await registry.dispose()
    stub.stop()
    rmSync(userDataRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })

  test("says that a phone cannot open an asleep project, with the cause, while the account's relay service could not start, and publishes its recovery", async () => {
    let fault: string | undefined = "EACCES: permission denied, mkdir '/account/.flywheel/auth'"
    const listeners = new Set<() => void>()
    const remote = createRemote({
      accountModuleFaults: {
        fault: (moduleId) => moduleId === "remote" ? fault : undefined,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      },
    })
    expect(remote.view().lastError).toBe(`A phone cannot open an asleep project: ${fault}`)

    fault = undefined
    for (const listener of listeners) listener()
    await viewWhere(remote, (view) => view.lastError === null)
    expect(published.at(-1)?.payload).toMatchObject({ kind: "remote.changed", remote: { lastError: null } })
    await remote.dispose()
    expect(listeners.size).toBe(0)
  })

  test("states a pairing store it cannot read when it has no relay of its own, and still starts", () => {
    mkdirSync(join(userDataRoot, "auth"), { recursive: true })
    writeFileSync(join(userDataRoot, "auth", "remote.json"), "{ not json")
    const remote = createRemote({ relayUrl: undefined })
    expect(remote.view().lastError).toContain("is not valid JSON")
  })

  test("makes no connection until a pairing window opens", async () => {
    const remote = createRemote()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(remote.view().connection).toBe("off")
    expect(stub.runtimes.size).toBe(0)
  })

  test("a source run pairs as a second machine: its label says so and its store is its own", async () => {
    const remote = createRemote({ lane: "dev" })
    const { result } = await pairDevice(remote)
    if (result.type !== "pair.accepted") throw new Error(`pairing was ${result.type}`)
    expect(result.runtimeLabel).toBe(`dev (${hostname().replace(/\.local$/, "")})`)
    expect((await remote.notificationAddress()).machine).toBe(`dev (${hostname().replace(/\.local$/, "")})`)
    await viewWhere(remote, (current) => current.devices.length === 1 && current.pairing === null)
    expect(readRemotePairingStore(userDataRoot, "dev").devices).toHaveLength(1)
    expect(readRemotePairingStore(userDataRoot, "installed").devices).toEqual([])
  })

  test.each(["installed", "dev"] as const)("pairs a device in %s through the sealed pairing channel and keeps its subscription when paired again", async (lane) => {
    const remote = createRemote({ lane })
    const label = "Private phone label for encrypted pairing regression"
    const { device, result, runtimeId } = await pairDevice(remote, label)
    // The device lists the machine by its host name, not by a project's.
    const host = hostname().replace(/\.local$/, "")
    const machine = lane === "dev" ? `dev (${host})` : host
    expect(result).toEqual({ type: "pair.accepted", runtimeLabel: machine })
    const view = await viewWhere(remote, (current) => current.devices.length === 1 && current.pairing === null)
    expect(view.devices[0]!.id).toBe(device.id)
    expect(view.devices[0]!.label).toBe(label)
    expect(readRemotePairingStore(userDataRoot, lane).devices[0]!.publicKey).toBe(toBase64Url(device.publicKey))
    // The relay's allowlist learned the device without a reconnect.
    await waitFor(() => stub.runtimes.get(runtimeId)?.data.devices?.has(device.id) === true)
    await waitFor(() => stub.pairingWindows.size === 0)
    // The relay saw the request only sealed.
    const wire = stub.pumped.map((frame) => new TextDecoder("utf-8", { fatal: false }).decode(frame)).join("")
    expect(wire).not.toContain("pair.request")
    expect(wire).not.toContain(label)
    expect(notifications.some((operation) => operation.type === "raise" && operation.occurrence.title === "Remote device paired")).toBe(true)
    expect(published.some((input) => input.payload.kind === "remote.changed")).toBe(true)
    const subscription = { endpoint: "https://push.test/phone", expirationTime: null, keys: { p256dh: "key", auth: "auth" } }
    await remote.setPushSubscription(device.id, subscription)
    expect(readRemotePairingStore(userDataRoot, lane).devices[0]?.pushSubscription).toBeUndefined()
    expect(remote.view().devices[0]?.notifies).toBe(true)
    await pairDevice(remote, "Renamed phone", device)
    await viewWhere(remote, (current) => current.pairing === null && current.devices[0]?.label === "Renamed phone")
    expect(remote.pushTargets().map((entry) => entry.subscription)).toEqual([subscription])
    const address = await remote.notificationAddress()
    expect(address.machine).toBe(machine)
    expect(address.project).toBe(basename(projectRoot))
    expect(address.machine).not.toBe(address.project)
    const gone = Promise.withResolvers<void>()
    const removal = gone.promise.then(() => remote.forgetPushSubscription(device.id, subscription))
    const replacement = { ...subscription, endpoint: "https://push.test/replacement" }
    await remote.setPushSubscription(device.id, replacement)
    gone.resolve()
    await removal
    expect(remote.pushTargets().map((entry) => entry.subscription)).toEqual([replacement])
    const rotated = { ...replacement, keys: { p256dh: "new-key", auth: "new-auth" } }
    await remote.setPushSubscription(device.id, rotated)
    await remote.forgetPushSubscription(device.id, replacement)
    expect(remote.pushTargets().map((entry) => entry.subscription)).toEqual([rotated])
    await remote.forgetPushSubscription(device.id, rotated)
    expect(remote.pushTargets()).toEqual([])
    expect(remote.view().devices[0]?.notifies).toBe(false)
    expect(readRemotePairingStore(userDataRoot, lane).devices[0]?.pushSubscription).toBeUndefined()
  })

  test("a dev-only phone subscribed under a different previous key no longer reads as notifying", async () => {
    await ensureRemoteIdentity(userDataRoot, "dev")
    const sharedKey = readRemotePairingStore(userDataRoot, "installed").vapid!.publicKey
    await mutateRemotePairingStore(userDataRoot, "dev", (store) => {
      store.vapid = { publicKey: "different", privateKey: Redacted.make("different") }
      store.devices = [{
        id: "phone", label: "Phone", publicKey: "AAAA", pairedAt: 1,
        pushSubscription: { endpoint: "https://push.test/old-dev", expirationTime: null, keys: { p256dh: "key", auth: "auth" } },
      }]
    })
    rmSync(join(userDataRoot, "auth", "remote-push.json"))
    const remote = createRemote({ lane: "dev" })
    const view = await viewWhere(remote, (current) => current.devices.length === 1)
    expect(view.devices[0]?.notifies).toBe(false)
    expect(view.pushPublicKey).toBe(sharedKey)
    expect(remote.pushTargets()).toEqual([])
  })

  test("a paired device attaches, exchanges sealed bytes with the accepted socket, and counts as attached", async () => {
    const remote = createRemote()
    const { device, runtimeId } = await pairDevice(remote)
    await viewWhere(remote, (view) => view.devices.length === 1)
    const echoed = Deferred.makeUnsafe<string>()
    remote.acceptChannels(async (socket: Socket.Socket, paired: PairedDevice) => {
      expect(paired.id).toBe(device.id)
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const { write } = yield* socket.writer
        yield* Stream.runForEach(Socket.toStream(socket), (bytes) => Effect.andThen(Effect.sync(() => Deferred.doneUnsafe(echoed, Effect.succeed(fromText(bytes)))), write(text(`echo:${fromText(bytes)}`))))
      })).pipe(Effect.exit))
    })
    const runtimePublicKey = fromBase64Url(readRemotePairingStore(userDataRoot, "installed").identity!.publicKey)
    const ws = await attachDeviceChannel(stub.url, runtimeId, placementId(projectRoot), { ...device, deviceId: device.id })
    const channel = await sealDevice(ws, device, { kind: "paired", publicKey: runtimePublicKey })
    await Effect.runPromise(channel.write(text("the secret message")))
    await waitFor(() => channel.received.length === 1)
    expect(fromText(channel.received[0]!)).toBe("echo:the secret message")
    expect(await Effect.runPromise(Deferred.await(echoed))).toBe("the secret message")
    const attached = await viewWhere(remote, (view) => view.attachedClients === 1)
    expect(attached.devices.map((paired) => paired.attached)).toEqual([true])
    // The attached count is the reading; an attachment raises no notification,
    // because the device reading it would be the one attached.
    expect(notifications.some((operation) => operation.type === "raise" && /connected|attached/i.test(operation.occurrence.title))).toBe(false)
    const wire = stub.pumped.map((frame) => new TextDecoder("utf-8", { fatal: false }).decode(frame)).join("")
    expect(wire).not.toContain("secret message")
    // The relay holds the machine's side of each channel, the pairing channel
    // and this one, to the heartbeat it keeps, which is how a device learns of
    // a machine whose link died.
    expect(stub.channelUrls.map((url) => statedSilenceDeadlineMs(new URL(url)))).toEqual([RELAY_HEARTBEAT.deadlineMs, RELAY_HEARTBEAT.deadlineMs])
    // The control socket states its heartbeat too, so a control socket that
    // died with the machine's link leaves presence within the same deadline.
    expect(stub.controlUrls.length).toBeGreaterThan(0)
    expect(stub.controlUrls.map((url) => statedSilenceDeadlineMs(new URL(url)))).toEqual(stub.controlUrls.map(() => RELAY_HEARTBEAT.deadlineMs))
    await channel.close()
    const detached = await viewWhere(remote, (view) => view.attachedClients === 0)
    expect(detached.devices.map((paired) => paired.attached)).toEqual([false])
    expect(notifications.some((operation) => operation.type === "resolve" && operation.sourceId === "remote.attached")).toBe(false)
    // The relay closed the machine's side itself, so there is nothing to report.
    expect(stub.endedChannels).toEqual([])
  })

  test("tells the relay at once when its side of a device channel ends with no close the relay saw, and the device hears it", async () => {
    // The edge can drop the machine's channel socket while the relay object
    // hears nothing and keeps pumping the device's frames into it. Only the
    // machine sees that end at once, so it reports it on its control socket.
    const remote = createRemote()
    const { device, runtimeId } = await pairDevice(remote)
    await viewWhere(remote, (view) => view.devices.length === 1)
    remote.acceptChannels(async (socket: Socket.Socket) => {
      await Effect.runPromise(Stream.runDrain(Socket.toStream(socket)).pipe(Effect.exit))
    })
    const runtimePublicKey = fromBase64Url(readRemotePairingStore(userDataRoot, "installed").identity!.publicKey)
    const ws = await attachDeviceChannel(stub.url, runtimeId, placementId(projectRoot), { ...device, deviceId: device.id })
    const channel = await sealDevice(ws, device, { kind: "paired", publicKey: runtimePublicKey })
    await Effect.runPromise(channel.established)
    await viewWhere(remote, (view) => view.attachedClients === 1)
    const severedAt = Date.now()
    stub.severChannel()
    const deviceClose = await ws.streams.closed
    expect(Date.now() - severedAt).toBeLessThan(1_000)
    expect(deviceClose).toMatchObject({ code: 1000, reason: "peer closed 1006: the machine's side ended" })
    expect(stub.endedChannels).toHaveLength(1)
    await viewWhere(remote, (view) => view.attachedClients === 0)
    await channel.close()
  })

  test("closes a device channel whose link to the relay stops answering, so it no longer counts as attached", async () => {
    const heartbeat = manualHeartbeatClock()
    const remote = createRemote({ random: () => 0, heartbeat: { intervalMs: 5, deadlineMs: 20, clock: heartbeat.clock } })
    const { device, runtimeId } = await pairDevice(remote)
    await viewWhere(remote, (view) => view.devices.length === 1)
    remote.acceptChannels(async (socket: Socket.Socket) => {
      await Effect.runPromise(Stream.runDrain(Socket.toStream(socket)).pipe(Effect.exit))
    })
    const runtimePublicKey = fromBase64Url(readRemotePairingStore(userDataRoot, "installed").identity!.publicKey)
    const ws = await attachDeviceChannel(stub.url, runtimeId, placementId(projectRoot), { ...device, deviceId: device.id })
    const channel = await sealDevice(ws, device, { kind: "paired", publicKey: runtimePublicKey })
    await Effect.runPromise(channel.established)
    await viewWhere(remote, (view) => view.attachedClients === 1)
    // The link goes half-open: pings get no answer, and no close ever arrives.
    // The phone is quiet, as a phone reading a transcript is.
    // The deadline runs from the first ping that goes unanswered, one
    // interval in.
    stub.answerPings = false
    heartbeat.advance(20)
    expect(remote.view().attachedClients).toBe(1)
    heartbeat.advance(5)
    const detached = await viewWhere(remote, (view) => view.attachedClients === 0)
    expect(detached.devices.map((paired) => paired.attached)).toEqual([false])
    await channel.close()
  })

  test("a paired device can be renamed on the machine", async () => {
    const remote = createRemote()
    const { device } = await pairDevice(remote)
    await viewWhere(remote, (view) => view.devices.length === 1)
    expect(await remote.renameDevice(device.id, "Alice's iPhone")).toBe(true)
    expect(remote.view().devices[0]?.label).toBe("Alice's iPhone")
    expect(readRemotePairingStore(userDataRoot, "installed").devices[0]?.label).toBe("Alice's iPhone")
    expect(await remote.renameDevice("not-a-device", "x")).toBe(false)
  })

  test("a revoked device is refused by the relay", async () => {
    const remote = createRemote()
    const { device, runtimeId } = await pairDevice(remote)
    await viewWhere(remote, (view) => view.devices.length === 1)
    expect(await remote.revokeDevice(device.id)).toBe(true)
    expect(await remote.revokeDevice(device.id)).toBe(false)
    expect(readRemotePairingStore(userDataRoot, "installed").devices).toEqual([])
    await waitFor(() => stub.runtimes.get(runtimeId) === undefined || stub.runtimes.get(runtimeId)!.data.devices!.size === 0)
    expect(String(await attachDeviceChannel(stub.url, runtimeId, "x".repeat(43), { ...device, deviceId: device.id }).catch((error: unknown) => error))).toMatch(/device_not_paired|runtime_offline|closed/)
  })

  test("reconnects to the relay after it drops the control channel", async () => {
    const remote = createRemote({ random: () => 0 })
    const { runtimeId } = await pairDevice(remote)
    await viewWhere(remote, (view) => view.devices.length === 1 && view.connection === "connected")
    stub.dropRuntime(runtimeId)
    await viewWhere(remote, (view) => view.connection === "reconnecting")
    const view = await viewWhere(remote, (current) => current.connection === "connected")
    expect(view.lastError).toBeNull()
    expect(stub.runtimes.has(runtimeId)).toBe(true)
  })

  describe("a pairing that another placement writes while the store is read", () => {
    const OWN_RELAY = "ws://own-relay.invalid"
    const pairOwnRelay = () => mutateRemotePairingStore(userDataRoot, "installed", (store) => {
      store.relayUrl = OWN_RELAY
      store.devices = [{ id: "phone", label: "Phone", publicKey: "AAAA", pairedAt: 1 }]
    })
    const dialedHosts = (dials: string[]) => [...new Set(dials.map((url) => new URL(url).host))]

    /** A remote with no relay of its own whose registry, at its `writeAt`th
     *  list, writes a paired phone and its relay as `flywheel remote pair
     *  --relay` does. Its control channel dials a socket that never opens. */
    function pairingDuringList(writeAt: number) {
      const registry = createAccountProjectRegistry({ userDataRoot })
      registries.push(registry)
      const dials: string[] = []
      let lists = 0
      const remote = createRemote({
        relayUrl: undefined,
        connectWebSocket: (url) => { dials.push(url); return new PendingRelaySocket() },
        projectRegistry: {
          ...registry,
          list: async () => {
            lists += 1
            if (lists === writeAt) await pairOwnRelay()
            return registry.list()
          },
        },
      })
      return { remote, dials, lists: () => lists }
    }

    test("dials only the store's relay when the write lands in a reload a store change woke", async () => {
      const { remote, dials, lists } = pairingDuringList(2)
      await waitFor(() => lists() === 1)
      await viewWhere(remote, (view) => view.relayUrl === DEFAULT_RELAY_URL)
      // Another placement creating its identity: a write that wakes a reload.
      await mutateRemotePairingStore(userDataRoot, "installed", () => {})
      await waitFor(() => lists() >= 3 && dials.length > 0)
      await viewWhere(remote, (view) => view.devices.length === 1 && view.relayUrl === OWN_RELAY)
      expect(dialedHosts(dials)).toEqual(["own-relay.invalid"])
    })

    test("notices a write that lands while the first load of the store is under way", async () => {
      await ensureRemoteIdentity(userDataRoot, "installed")
      // The first load reads the store and then imports the identity key; the
      // write lands while that import waits, after the read.
      const importKey = crypto.subtle.importKey.bind(crypto.subtle)
      const paused = Promise.withResolvers<void>()
      const firstImport = Promise.withResolvers<void>()
      const spy = spyOn(crypto.subtle, "importKey").mockImplementationOnce(async (format, keyData, ...rest) => {
        paused.resolve()
        await firstImport.promise
        if (format === "jwk" || !ArrayBuffer.isView(keyData)) throw new Error("the identity key imports as pkcs8 bytes")
        return importKey(format, keyData, ...rest)
      })
      try {
        const { remote, dials } = pairingDuringList(0)
        await paused.promise
        await pairOwnRelay()
        await viewWhere(remote, (view) => view.devices.length === 1 && view.relayUrl === OWN_RELAY)
        await waitFor(() => dials.length > 0)
        firstImport.resolve()
        expect(dialedHosts(dials)).toEqual(["own-relay.invalid"])
      } finally {
        firstImport.resolve()
        spy.mockRestore()
      }
    })
  })

  test("retries an unreachable relay without raising a notification", async () => {
    let attempts = 0
    const remote = createRemote({
      random: () => 0,
      connectWebSocket: (url) => attempts++ === 0 ? new FailedRelaySocket() : new WebSocket(url),
    })
    await remote.openPairing()
    const view = await viewWhere(remote, (current) => current.connection === "connected" && current.lastError === null)
    expect(view.lastError).toBeNull()
    expect(attempts).toBe(2)
    expect(notifications.some((operation) => operation.type === "raise" && operation.occurrence.title === "Remote relay unreachable")).toBe(false)
  })

  test("a second placement of the same account shares the identity and the devices", async () => {
    const first = createRemote()
    const { device } = await pairDevice(first)
    await viewWhere(first, (view) => view.devices.length === 1)
    const otherProject = mkdtempSync(join(tmpdir(), "flywheel-remote-project2-"))
    try {
      const second = createRemote({ projectRoot: otherProject })
      const view = await viewWhere(second, (current) => current.connection === "connected")
      expect(view.devices.map((paired) => paired.id)).toEqual([device.id])
    } finally {
      rmSync(otherProject, { recursive: true, force: true })
    }
  })
  test("a device revoked through one placement loses its channel to every other placement of the process at once", async () => {
    const first = createRemote()
    const { device, runtimeId } = await pairDevice(first)
    const otherProject = mkdtempSync(join(tmpdir(), "flywheel-remote-project2-"))
    try {
      const second = createRemote({ projectRoot: otherProject })
      await viewWhere(second, (view) => view.connection === "connected" && view.devices.length === 1)
      second.acceptChannels((socket) => Effect.runPromise(Stream.runDrain(Socket.toStream(socket)).pipe(Effect.ignore)))
      const runtimePublicKey = fromBase64Url(readRemotePairingStore(userDataRoot, "installed").identity!.publicKey)
      const ws = await attachDeviceChannel(stub.url, runtimeId, placementId(otherProject), { ...device, deviceId: device.id })
      const channel = await sealDevice(ws, device, { kind: "paired", publicKey: runtimePublicKey })
      await viewWhere(second, (view) => view.attachedClients === 1)
      expect(await first.revokeDevice(device.id)).toBe(true)
      const revoked = await viewWhere(second, (view) => view.devices.length === 0 && view.attachedClients === 0, 1_000)
      expect(revoked.devices).toEqual([])
      await channel.close()
    } finally {
      rmSync(otherProject, { recursive: true, force: true })
    }
  })

  test("both lanes share push registration, renewal, removal, and live key changes", async () => {
    const installed = createRemote()
    const dev = createRemote({ lane: "dev" })
    const { device } = await pairDevice(dev)
    const subscription = { endpoint: "https://push.test/shared-phone", expirationTime: null, keys: { p256dh: "key", auth: "auth" } }
    await dev.setPushSubscription(device.id, subscription)
    await pairDevice(installed, "same phone", device)
    expect(installed.pushTargets()[0]?.subscription).toEqual(subscription)
    expect(readRemotePairingStore(userDataRoot, "installed").devices[0]?.pushSubscription).toBeUndefined()
    expect(readRemotePairingStore(userDataRoot, "dev").devices[0]?.pushSubscription).toBeUndefined()
    await viewWhere(installed, (view) => view.devices[0]?.notifies === true)
    expect(installed.pushTargets()[0]?.subscription).toEqual(subscription)
    expect(dev.view().devices[0]?.notifies).toBe(true)
    await dev.renameDevice(device.id, "renamed phone")
    expect(dev.pushTargets()[0]?.subscription).toEqual(subscription)
    expect(dev.view().devices[0]?.label).toBe("renamed phone")
    await pairDevice(dev, "paired again", device)
    await viewWhere(dev, (view) => view.pairing === null && view.devices[0]?.label === "paired again")
    expect(dev.pushTargets()[0]?.subscription).toEqual(subscription)
    const original = installed.view().pushPublicKey
    if (original === null) throw new Error("the installed lane published no push key")
    expect(dev.view().pushPublicKey).toBe(original)
    expect(dev.pushTargets()[0]?.vapid.publicKey).toBe(original)
    expect(installed.pushTargets()[0]?.vapid.publicKey).toBe(original)
    const pair = asKeyPair(await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]))
    const publicKey = toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)))
    const privateKey = Redacted.make(toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))))
    await mutateRemotePairingStore(userDataRoot, "installed", (store) => {
      store.vapid = { publicKey, privateKey }
    })
    await Promise.all([viewWhere(installed, (view) => view.pushPublicKey === publicKey), viewWhere(dev, (view) => view.pushPublicKey === publicKey)])
    expect(dev.pushTargets()[0]?.vapid.publicKey).toBe(publicKey)
    expect(installed.pushTargets()[0]?.vapid.publicKey).toBe(publicKey)
    const renewed = { ...subscription, endpoint: "https://push.test/renewed-phone" }
    await installed.setPushSubscription(device.id, renewed)
    await waitFor(() => dev.pushTargets()[0]?.subscription.endpoint === renewed.endpoint)
    expect(installed.pushTargets()[0]?.subscription).toEqual(renewed)
    await dev.forgetPushSubscription(device.id, subscription)
    expect(dev.pushTargets()[0]?.subscription).toEqual(renewed)
    await dev.forgetPushSubscription(device.id, renewed)
    await viewWhere(installed, (view) => view.devices[0]?.notifies === false)
    expect(installed.pushTargets()).toEqual([])
    expect(dev.pushTargets()).toEqual([])
    expect(dev.view().devices[0]?.notifies).toBe(false)
    expect(readRemotePairingStore(userDataRoot, "installed").devices[0]?.pushSubscription).toBeUndefined()
    expect(readRemotePairingStore(userDataRoot, "dev").devices[0]?.pushSubscription).toBeUndefined()
    await dev.setPushSubscription(device.id, renewed)
    await viewWhere(dev, (view) => view.devices[0]?.notifies === true)
    await viewWhere(installed, (view) => view.devices[0]?.notifies === true)
    expect(dev.pushTargets()[0]?.subscription).toEqual(renewed)
    await installed.setPushSubscription(device.id, subscription)
    await viewWhere(dev, (view) => view.devices[0]?.notifies === true)
    await installed.setPushSubscription(device.id, undefined)
    await viewWhere(dev, (view) => view.devices[0]?.notifies === false)
    expect(installed.pushTargets()).toEqual([])
    expect(dev.pushTargets()).toEqual([])
    await dev.setPushSubscription(device.id, subscription)
    await viewWhere(installed, (view) => view.devices[0]?.notifies === true)
    await installed.revokeDevice(device.id)
    expect(installed.pushTargets()).toEqual([])
    expect(dev.pushTargets()[0]?.subscription).toEqual(subscription)
    await dev.renameDevice(device.id, "still subscribed")
    expect(dev.pushTargets()[0]?.subscription).toEqual(subscription)
    await installed.forgetPushSubscription(device.id, subscription)
    await viewWhere(dev, (view) => view.devices[0]?.notifies === false)
    expect(dev.pushTargets()).toEqual([])
    await dev.setPushSubscription(device.id, subscription)
    await pairDevice(installed, "paired again after revocation", device)
    expect(installed.pushTargets()[0]?.subscription).toEqual(subscription)
  })
  test("records and forgets startable projects only through the account registry", async () => {
    const remote = createRemote()
    await pairDevice(remote)
    await viewWhere(remote, (view) => view.projects.length === 1)
    expect(JSON.parse(await Bun.file(join(userDataRoot, "auth", "remote.json")).text())).not.toHaveProperty("placements")
    expect(await remote.forgetProject(remote.view().projects[0]!.placementId)).toBe(true)
    expect(remote.view().projects).toEqual([])
    await remote.dispose()
    remotes.splice(remotes.indexOf(remote), 1)
    const registry = createAccountProjectRegistry({ userDataRoot })
    expect(await registry.list()).toEqual([])
    await registry.dispose()
  })

  test("shows a project the account forgets at once", async () => {
    const registry = createAccountProjectRegistry({ userDataRoot })
    registries.push(registry)
    await registry.record({ projectRoot, label: "project" })
    const remote = createRemote({ projectRegistry: registry })
    // Opening a window loads the store and the project list.
    await remote.openPairing()
    expect(remote.view().projects).toHaveLength(1)

    // The account and this placement share one registry, whose writes reach the view as they commit.
    await registry.forget(projectRoot)

    await viewWhere(remote, (view) => view.projects.length === 0, 500)
  })

  test("a registry change costs no read in any open placement, however many are open", async () => {
    const registry = createAccountProjectRegistry({ userDataRoot })
    registries.push(registry)
    const watchers = new Set<Parameters<typeof registry.watch>[0]>()
    let lists = 0
    const counted = { ...registry, list: () => { lists += 1; return registry.list() }, watch: (watcher: Parameters<typeof registry.watch>[0]) => { watchers.add(watcher); return () => { watchers.delete(watcher) } } }
    const storeReads = spyOn(pairingStore, "readRemotePairingStore")
    try {
      const placements = Array.from({ length: 6 }, (_, index) => createRemote({ projectRegistry: counted, projectRoot: join(projectRoot, `project-${index}`) }))
      // Each placement follows the registry once its startup has loaded the store.
      await waitFor(() => watchers.size === placements.length && lists === placements.length)
      const listsBefore = lists
      const readsBefore = storeReads.mock.calls.length
      const recorded = Array.from({ length: 10 }, (_, index) => ({ id: `id-${index}`, projectRoot: join(projectRoot, `project-${index}`), label: `project-${index}`, lastAttachedAt: index }))
      for (let change = 1; change <= recorded.length; change += 1) {
        for (const watcher of watchers) watcher(recorded.slice(0, change))
      }
      expect(lists - listsBefore).toBe(0)
      expect(storeReads.mock.calls.length - readsBefore).toBe(0)
      for (const placement of placements) expect(placement.view().projects).toHaveLength(10)
    } finally {
      storeReads.mockRestore()
    }
  })

  test("a protocol version refusal keeps asking under one alert and clears it once the relay admits the machine", async () => {
    stub.refuseRuntime = "protocol_version"
    const remote = createRemote()
    await remote.openPairing()
    await viewWhere(remote, (view) => view.lastError !== null && view.connection === "off")
    expect(remote.view().lastError).toContain("update Flywheel with `flywheel update`")
    // The owner asking again wakes the long wait early; the relay still
    // refuses, and the alert already raised is not raised again.
    await remote.cancelPairing()
    await remote.openPairing()
    await waitFor(() => stub.attachAttempts === 2)
    await viewWhere(remote, (view) => view.connection === "off")
    const raised = notifications.filter((operation) => operation.type === "raise")
    expect(raised).toHaveLength(1)
    expect(raised[0]?.type === "raise" ? raised[0].occurrence.title : undefined).toBe("Remote relay speaks a different protocol version")
    // The relay is deployed at a version that admits this build.
    stub.refuseRuntime = undefined
    await remote.cancelPairing()
    await remote.openPairing()
    const view = await viewWhere(remote, (current) => current.connection === "connected")
    expect(view.lastError).toBeNull()
    expect(stub.attachAttempts).toBe(3)
    expect(notifications.filter((operation) => operation.type === "raise")).toHaveLength(1)
    expect(notifications.at(-1)).toEqual({ type: "resolve", sourceId: "remote.relay" })
  })

  test("an identity refusal parks the channel until the owner asks again", async () => {
    stub.refuseRuntime = "bad_signature"
    const remote = createRemote()
    await remote.openPairing()
    await viewWhere(remote, (view) => view.lastError !== null && view.connection === "off")
    expect(stub.attachAttempts).toBe(1)
    stub.refuseRuntime = undefined
    await remote.cancelPairing()
    await remote.openPairing()
    await viewWhere(remote, (view) => view.connection === "connected")
    expect(stub.attachAttempts).toBe(2)
  })

})
