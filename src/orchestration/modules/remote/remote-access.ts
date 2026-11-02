import type { ServeLane } from "../../../infra/cli-subprocess.js"
import { createHash } from "node:crypto"
import { collapseHome } from "../../../infra/home-path.js"
import { basename } from "node:path"
import { Effect, Exit, Scope } from "effect"
import { Socket } from "effect/unstable/socket"

import { importLegacyRemotePlacements, mutateRemotePairingStore, mutateRemotePushStore, readRemotePairingStore, readRemotePushStore, onRemoteStoresWritten, watchRemotePushStore, type PairedDevice, type RemotePairingStore, type StoredKeyPair } from "./remote-pairing-store.js"
import { errorMessage } from "../../../infra/error-message.js"
import { Log } from "../../../infra/log.js"
import type { HeartbeatTiming, RelayChannelSocket, RelayChannelStreams } from "../../../protocol/modules/remote/relay-channel.js"
import { sealedSocket } from "../../../protocol/modules/remote/sealed-socket.js"
import {
  DEFAULT_RELAY_URL,
  DEFAULT_REMOTE_APP_ORIGIN,
  fromBase64Url,
  type OpenFrame,
  type Placement,
} from "../../../protocol/modules/remote/relay-protocol.js"
import { remoteCursor, remoteProtocol, type RemoteConnectionState, type RemotePairingWindowView, type RemotePushSubscription, type RuntimeRemoteView } from "../../../protocol/modules/remote.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../protocol/runtime-liveness.js"
import type { RuntimeUiPatchInput } from "../../../protocol/runtime-ui-protocol-types.js"
import type { NotificationEpisodeInput } from "../../../infra/notification-episode.js"
import type { AccountProjectRegistry } from "../../app-service/account-project-registry.js"
import { createMutationAdmission } from "../../app-service/mutation-admission.js"
import { bridgeExternalPromise } from "../../agent-runtime/external-promise-bridge.js"
import { createRelayControlChannel, type ServedClient } from "./relay-control-channel.js"
import { dialRelayDataChannel } from "./relay-data-channel.js"
import type { AccountServiceInstallation } from "../../app-service/account-service-installation.js"
import type { AccountModuleFaults } from "../../app-service/module-service-host.js"
import { ensureRemoteIdentity, type RemoteIdentity } from "./remote-identity.js"
import { createPairingWindow, exchangePairing, machineName, PAIRING_WINDOW_MS, type PairingWindow } from "./remote-pairing-exchange.js"

const log = Log.create({ service: "remote-access" })

/** The runtime's side of remote access: one account identity, one outbound
 *  control channel to the relay per placement, the pairing window, and the
 *  list of devices allowed to attach.
 *
 *  Nothing here listens. The control channel is a WebSocket this process
 *  opens to the relay; a phone that wants in makes the relay say `open`, and
 *  this process dials one more outbound WebSocket for that channel. The relay
 *  learns that this placement is online and which device ids may attach, and
 *  nothing else: every data channel is sealed end to end below the protocol
 *  (`protocol/modules/remote/sealed-socket.ts`).
 *
 *  The channel connects only while there is a reason to: a paired device or an
 *  open pairing window. An unpaired machine makes no network connection at
 *  all, and startup never waits on this: the store is read and the channel
 *  opened off the critical path. */


const RELAY_NOTIFICATION_SOURCE = "remote.relay"

/** Settles when the RPC handler for one accepted device channel ends. */
export type RemoteChannelAccept = (socket: Socket.Socket, device: PairedDevice) => Promise<void>

export interface RemoteAccessOptions {
  /** Borrowed account authority; the caller retains its lifetime. */
  readonly projectRegistry: Omit<AccountProjectRegistry, "dispose">
  readonly userDataRoot: string
  /** The lane this placement serves in; each lane pairs as its own machine. */
  readonly lane: ServeLane
  readonly accountHome: string
  readonly projectRoot: string
  readonly version: string
  /** The web client this runtime's process serves, which the placement names
   *  and streams to the relay on request. */
  readonly client?: () => Promise<ServedClient | undefined>
  /** Login service installation, absent when this placement cannot manage it. */
  readonly installation?: AccountServiceInstallation
  /** The account's report of the module services it could not start. While
   *  this module's own account service, which offers the asleep projects to
   *  a phone, could not start, the view states it with its cause. */
  readonly accountModuleFaults?: AccountModuleFaults
  readonly publish: (input: RuntimeUiPatchInput) => void
  readonly notify?: (episode: NotificationEpisodeInput) => void
  /** Overrides the store's relay. Persisted with the first pairing so later
   *  placements use the same relay. */
  readonly relayUrl?: string
  readonly appOrigin?: string
  readonly now?: () => number
  readonly random?: () => number
  readonly connectWebSocket?: (url: string) => RelayChannelSocket
  readonly pairingWindowMs?: number
  /** The relay heartbeat of the control channel and every data channel; the contract's timing unless a test needs a faster one. */
  readonly heartbeat?: HeartbeatTiming
}

export interface RemoteAccess {
  view(): RuntimeRemoteView
  /** Opens (or returns the open) pairing window and connects to the relay. */
  openPairing(): Promise<RemotePairingWindowView>
  cancelPairing(): Promise<void>
  /** Removes a device. Its live channels close with it. Returns whether one existed. */
  revokeDevice(deviceId: string): Promise<boolean>
  /** Renames a paired device. False when no device has the id. */
  renameDevice(deviceId: string, label: string): Promise<boolean>
  /** Forgets a project the account service would offer a phone. Returns whether one was recorded. */
  forgetProject(placementId: string): Promise<boolean>
  setProcessInitiation(enabled: boolean): Promise<void>
  /** Records or clears a device's Web Push subscription. Returns whether the device is paired. */
  setPushSubscription(deviceId: string, subscription: RemotePushSubscription | undefined): Promise<boolean>
  /** Every paired device that can be notified, with the key that signs to its push service. */
  pushTargets(): readonly PushTarget[]
  notificationAddress(): Promise<{ readonly runtimeId: string; readonly placementId: string; readonly machine: string; readonly project: string }>
  /** Forgets a subscription the push service reported gone. */
  forgetPushSubscription(deviceId: string, subscription: RemotePushSubscription): Promise<void>
  /** Registers the one handler that receives accepted device channels, which
   *  the RPC server's `SocketServer` layer supplies. */
  acceptChannels(accept: RemoteChannelAccept): () => void
  onChange(listener: (view: RuntimeRemoteView) => void): () => void
  /** Stops admission, closes pending and active channels, and joins their work. Idempotent. */
  dispose(): Promise<void>
}

export interface PushTarget {
  readonly deviceId: string
  readonly label: string
  readonly subscription: RemotePushSubscription
  readonly vapid: StoredKeyPair
}

interface OpenPairingWindow extends PairingWindow {
  readonly timer: ReturnType<typeof setTimeout>
}

interface LiveChannel {
  readonly ws: RelayChannelSocket
  readonly deviceId: string
}

export function placementId(projectRoot: string): string {
  return createHash("sha256").update(projectRoot).digest("base64url")
}

export function createRemoteAccess(options: RemoteAccessOptions): RemoteAccess {
  const now = options.now ?? Date.now
  const random = options.random ?? Math.random
  const connect = options.connectWebSocket ?? ((url: string) => new WebSocket(url))
  const appOrigin = options.appOrigin ?? DEFAULT_REMOTE_APP_ORIGIN
  const projectRegistry = options.projectRegistry
  const placement: Placement = {
    id: placementId(options.projectRoot),
    projectLabel: basename(options.projectRoot) || options.projectRoot,
    version: options.version,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    state: "live",
  }

  // Declared before the relay URL, whose first read records a store it
  // cannot read here.
  let lastError: string | null = null
  let relayUrl = options.relayUrl ?? readRelayUrl()
  let devices: readonly PairedDevice[] = []
  let subscriptions: ReadonlyMap<string, RemotePushSubscription> = new Map()
  let projects: Awaited<ReturnType<typeof projectRegistry.list>> = []
  let processInitiation: RuntimeRemoteView["processInitiation"]
  let lingerOffFor: string | undefined
  // Counts Process initiation probes, so a probe that a later one overtook
  // publishes nothing.
  let probes = 0
  let vapid: StoredKeyPair | undefined
  let identity: RemoteIdentity | undefined
  let connection: RemoteConnectionState = "off"
  // The title of the relay alert raised since the channel last attached, so a
  // refusal repeated on every dial stays one alert.
  let alerted: string | undefined
  let pairing: OpenPairingWindow | undefined
  let disposed = false
  const work = createMutationAdmission()
  const run = <A>(action: () => Promise<A>): Promise<A> => work.admit(action) ?? Promise.reject(new Error("Remote access is off"))
  const assertActive = (): void => { if (disposed) throw new Error("Remote access is off") }
  let loaded = false
  let accept: RemoteChannelAccept | undefined
  const dataWork = Scope.makeUnsafe("parallel")
  let closing: Promise<void> | undefined
  const channels = new Set<LiveChannel>()
  const listeners = new Set<(view: RuntimeRemoteView) => void>()

  function readRelayUrl(): string {
    try {
      return readRemotePairingStore(options.userDataRoot, options.lane).relayUrl ?? DEFAULT_RELAY_URL
    } catch (error) {
      lastError = errorMessage(error)
      return DEFAULT_RELAY_URL
    }
  }

  /** A phone opens an asleep project through the account's relay service, so
   *  while that service could not start, its cause is the first problem the
   *  view states, before the control channel's own. */
  function problem(): string | null {
    const cause = options.accountModuleFaults?.fault(remoteProtocol.id)
    const accountFault = cause === undefined ? undefined : `A phone cannot open an asleep project: ${cause}`
    return [accountFault, lastError].filter((part) => part != null).join("; ") || null
  }

  function view(): RuntimeRemoteView {
    return {
      relayUrl,
      connection,
      devices: devices.map((device) => ({ id: device.id, label: device.label, pairedAt: device.pairedAt, notifies: subscriptions.has(device.id), attached: [...channels].some((channel) => channel.deviceId === device.id) })),
      attachedClients: channels.size,
      pairing: pairing ? { windowId: pairing.windowId, code: pairing.code, expiresAt: pairing.expiresAt } : null,
      lastError: problem(),
      pushPublicKey: vapid?.publicKey ?? null,
      projects: projects.map((project) => ({ placementId: placementId(project.projectRoot), projectRoot: project.projectRoot, projectLabel: project.label, lastAttachedAt: project.lastAttachedAt, displayPath: collapseHome(project.projectRoot, options.accountHome), state: project.projectRoot === options.projectRoot ? "open" : "asleep" })),
      ...(processInitiation === undefined ? {} : { processInitiation }),
      ...(lingerOffFor === undefined ? {} : { lingerOffFor }),
    }
  }

  function publish(): void {
    if (disposed) return
    const current = view()
    options.publish({ cursor: remoteCursor(), payload: { kind: "remote.changed", remote: current } })
    for (const listener of listeners) listener(current)
  }

  function setConnection(next: RemoteConnectionState): void {
    if (connection === next) return
    connection = next
    publish()
  }

  function wantsConnection(): boolean {
    return !disposed && (devices.length > 0 || pairing !== undefined)
  }

  const channel = createRelayControlChannel({
    relayUrl: () => relayUrl,
    identity: requireIdentity,
    placement: () => placement,
    ...(options.client === undefined ? {} : { client: options.client }),
    devices: () => devices.map((device) => device.id),
    wanted: wantsConnection,
    connect,
    ...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }),
    random,
    onConnection: setConnection,
    onAttached: (send) => {
      if (disposed) return
      lastError = null
      alerted = undefined
      options.notify?.({ type: "resolve", sourceId: RELAY_NOTIFICATION_SOURCE })
      if (pairing) send({ type: "pairing.open", windowId: pairing.windowId, expiresAt: pairing.expiresAt })
      void run(recordProject)
    },
    onOpen: async (frame) => {
      if (disposed) return
      Effect.runSync(Effect.forkIn(handleOpen(frame), dataWork, { startImmediately: true }))
    },
    // The channel records the failure; this owner publishes it.
    onFailure: (error, outcome) => {
      lastError = error
      if (outcome !== "retry") {
        // A mismatched channel is not an unreachable relay: the relay
        // answered, and a relay deploy or a newer build heals it.
        const occurrence = outcome === "mismatched"
          ? { title: "Remote relay speaks a different protocol version", message: `${relayUrl} turned this Flywheel away: ${error}.` }
          : { title: "Remote relay unreachable", message: `Flywheel could not stay attached to ${relayUrl}: ${error}` }
        if (alerted !== occurrence.title) {
          alerted = occurrence.title
          options.notify?.({ type: "raise", occurrence: { sourceId: RELAY_NOTIFICATION_SOURCE, ...occurrence, severity: "alert", action: { kind: "open-settings" } } })
        }
      }
      publish()
    },
  })

  /** The project list is a byproduct of attaching: a project is startable from
   *  a phone because a runtime for it has been reachable from one. */
  async function recordProject(): Promise<void> {
    try {
      await projectRegistry.record({ projectRoot: options.projectRoot, label: placement.projectLabel })
      projects = await projectRegistry.list()
      publish()
    } catch (error) {
      log.warn("remote project could not be recorded", { error: errorMessage(error) })
    }
  }

  /** Reads Process initiation and publishes it, and then, while it is on,
   *  reads whether the service stops at the account's last logout because
   *  lingering is off. Probes are not serialized: a startup probe can still
   *  wait on logind when a change probes again, so only the latest probe
   *  publishes what it read. */
  async function probeHost(): Promise<void> {
    const installation = options.installation
    if (!installation) return
    const probe = ++probes
    let reading: RuntimeRemoteView["processInitiation"]
    try {
      const installed = await installation.installed()
      reading = installed === null ? undefined : installed ? "on" : "off"
    } catch (error) {
      reading = "unavailable"
      log.warn("process initiation could not be read", { error: errorMessage(error) })
    }
    if (probe !== probes) return
    processInitiation = reading
    if (reading !== "on") lingerOffFor = undefined
    publish()
    if (reading !== "on") return
    const user = await installation.lingerOffFor()
    if (probe !== probes || user === lingerOffFor) return
    lingerOffFor = user
    publish()
  }

  async function loadStore(): Promise<void> {
    if (loaded) return
    loaded = true
    // Armed before the first read, so a pairing written while that read is
    // under way still wakes a reload.
    followStore()
    await reloadStore()
  }

  /** Reads the store and reconciles the live state with it: the device list the
   *  relay must hold, the relay to talk to, and whether a connection is wanted.
   *  Every value comes from one read taken after the awaits, so a pairing that
   *  another placement writes meanwhile (a pairing writes the device and its
   *  relay together) is never half applied, and concurrent reloads apply
   *  their reads in the order they took them. */
  async function reloadStore(): Promise<void> {
    try {
      await importLegacyRemotePlacements(options.userDataRoot, options.lane, projectRegistry)
      const listed = await projectRegistry.list()
      const store = readRemotePairingStore(options.userDataRoot, options.lane)
      const before = devices.map((device) => device.id).join(",")
      projects = listed
      relayUrl = options.relayUrl ?? store.relayUrl ?? DEFAULT_RELAY_URL
      refreshPushState(store)
      if (before !== devices.map((device) => device.id).join(",")) channel.send({ type: "devices", devices: devices.map((device) => device.id) })
      for (const live of channels) if (!devices.some((device) => device.id === live.deviceId)) live.ws.close(1008, "device revoked")
      if (store.identity !== undefined) {
        identity = await ensureRemoteIdentity(options.userDataRoot, options.lane)
      }
    } catch (error) {
      lastError = errorMessage(error)
      log.warn("remote pairing store unreadable", { error: lastError })
    }
    publish()
    channel.reconcile("no paired devices")
  }

  const stopFollowing: (() => void)[] = []
  function followStore(): void {
    const reload = (): void => { if (!disposed) void run(reloadStore) }
    // The account opens a project per placement and records each, so a
    // registry change takes the list the registry hands over: a store reload
    // per placement per change would cost O(placements) reads per open.
    const showProjects = (listed: typeof projects): void => {
      if (disposed) return
      projects = listed
      publish()
    }
    stopFollowing.push(onRemoteStoresWritten(options.userDataRoot, reload), projectRegistry.watch(showProjects))
    try {
      stopFollowing.push(watchRemotePushStore(options.userDataRoot, reload))
    } catch (error) {
      // No watcher means no live pickup of the other lane's subscriptions,
      // which the next start repairs; it is not a reason to refuse remote access.
      log.warn("remote push store watch unavailable", { error: errorMessage(error) })
    }
  }

  async function requireIdentity(): Promise<RemoteIdentity> {
    if (identity === undefined) {
      identity = await ensureRemoteIdentity(options.userDataRoot, options.lane)
      vapid = readRemotePairingStore(options.userDataRoot, "installed").vapid
    }
    return identity
  }

  /** Takes the devices and push keys from `store`, this lane's pairing store
   *  as one read gave it; the push keys live in the installed lane's store. */
  function refreshPushState(store: RemotePairingStore = readRemotePairingStore(options.userDataRoot, options.lane)): void {
    const installed = options.lane === "installed" ? store : readRemotePairingStore(options.userDataRoot, "installed")
    vapid = installed.vapid
    devices = store.devices
    subscriptions = readRemotePushStore(options.userDataRoot).subscriptions
  }

  async function mutatePushSubscription(deviceId: string, mutate: (subscription: RemotePushSubscription | undefined) => RemotePushSubscription | undefined): Promise<void> {
    await mutateRemotePushStore(options.userDataRoot, (store) => {
      const next = mutate(store.subscriptions.get(deviceId))
      if (next === undefined) store.subscriptions.delete(deviceId)
      else store.subscriptions.set(deviceId, next)
    })
    refreshPushState()
    publish()
  }

  async function mutateDevice(deviceId: string, mutate: (device: PairedDevice) => PairedDevice): Promise<boolean> {
    await loadStore()
    assertActive()
    if (!devices.some((device) => device.id === deviceId)) return false
    await mutateRemotePairingStore(options.userDataRoot, options.lane, (store) => {
      store.devices = store.devices.map((device) => device.id === deviceId ? mutate(device) : device)
    })
    refreshPushState()
    publish()
    return true
  }

  function handleOpen(frame: OpenFrame): Effect.Effect<void> {
    return Effect.scoped(Effect.gen(function*() {
      const runtimeIdentity = yield* bridgeExternalPromise(requireIdentity).owned
      const window = frame.kind === "pairing" ? pairing : undefined
      if (frame.kind === "pairing" && (!window || window.windowId !== frame.windowId)) {
        log.warn("relay opened a pairing channel for a window this placement does not hold", { windowId: frame.windowId })
        return
      }
      const { ws, streams } = yield* dialRelayDataChannel({ connect, relayUrl, runtimeId: runtimeIdentity.runtimeId, frame, control: channel, stopping: () => disposed, ...(options.heartbeat === undefined ? {} : { heartbeat: options.heartbeat }) })
      const scope = yield* Effect.scope
      yield* bridgeExternalPromise(async (signal) => {
        const stop = () => { if (ws.readyState < WebSocket.CLOSING) ws.close(1001, "runtime stopping") }
        signal.addEventListener("abort", stop, { once: true })
        const signingIdentity: RemoteIdentity = {
          ...runtimeIdentity,
          sign: async (bytes) => {
            signal.throwIfAborted()
            // The sealed socket can interrupt its Promise wait, but WebCrypto
            // cannot cancel a signature. The channel scope joins the actual work.
            const signing = Effect.runSync(Effect.acquireRelease(
              Effect.sync(() => runtimeIdentity.sign(bytes)),
              (pending) => Effect.promise(() => pending.then(() => {}, () => {})),
            ).pipe(Scope.provide(scope)))
            const signature = await signing
            signal.throwIfAborted()
            return signature
          },
        }
        try {
          if (window) await runPairingChannel(signingIdentity, window, ws, streams, signal)
          else await runDeviceChannel(frame, signingIdentity, ws, streams)
        } finally {
          signal.removeEventListener("abort", stop)
        }
      }).owned
    })).pipe(Effect.catchCause((cause) => Effect.sync(() => {
      if (!disposed) log.warn("relay data channel failed", { error: String(cause) })
    })))
  }

  async function runDeviceChannel(frame: OpenFrame, runtimeIdentity: RemoteIdentity, ws: RelayChannelSocket, streams: RelayChannelStreams): Promise<void> {
    const device = devices.find((candidate) => candidate.id === frame.deviceId)
    if (!device || !accept) {
      // The relay admitted a device this placement no longer knows, or this
      // placement is not serving the protocol. Closing the channel we dialed
      // is what tells the phone, instead of leaving it waiting on a relay
      // timeout.
      log.warn("relay device channel refused", { device: frame.deviceId, channel: frame.channelId, reason: device ? "no protocol server registered" : "device not paired" })
      ws.close(1008, device ? "not serving" : "device not paired")
      return
    }
    const live: LiveChannel = { ws, deviceId: device.id }
    channels.add(live)
    log.info("relay device channel opened", { device: device.id, channel: frame.channelId, label: device.label })
    // No notification for an attachment: the remote view already says a device
    // is attached, and the device reading the notification is the one attached.
    publish()
    try {
      const inner = await Effect.runPromise(Socket.fromTransformStream(Effect.succeed(streams)))
      if (disposed) return
      const sealed = sealedSocket(inner, { role: "runtime", publicKey: runtimeIdentity.publicKey, sign: runtimeIdentity.sign }, { kind: "paired", publicKey: fromBase64Url(device.publicKey) })
      await accept(sealed.socket, device)
    } catch (error) {
      log.warn("relay device channel ended with an error", { device: device.id, channel: frame.channelId, error: errorMessage(error) })
    } finally {
      channels.delete(live)
      ws.close(1000)
      // The close carries who ended the channel and why: the phone's own code
      // and reason when it hung up, the relay's when it swept the phone, and a
      // plain 1000 when this close is the first the socket saw. Without it a
      // dropped phone is indistinguishable from one that left on purpose.
      const close = await streams.closed
      log.info("relay device channel closed", { device: device.id, channel: frame.channelId, code: close.code, reason: close.reason, abrupt: close.abrupt })
      publish()
    }
  }

  /** The pairing exchange: seal the channel under the window's secret, read
   *  the device's request, and, while the window is still open, close it,
   *  record the device, and answer. */
  async function runPairingChannel(runtimeIdentity: RemoteIdentity, window: OpenPairingWindow, ws: RelayChannelSocket, streams: RelayChannelStreams, signal: AbortSignal): Promise<void> {
    try {
      const claim = (): boolean => {
        if (pairing !== window) return false
        closePairingWindow(window)
        return true
      }
      const onCommitted = (device: PairedDevice): void => {
        refreshPushState()
        log.info("remote device paired", { device: device.id, label: device.label })
        channel.send({ type: "devices", devices: devices.map((paired) => paired.id) })
        options.notify?.({ type: "raise", occurrence: { sourceId: `remote.paired.${device.id}`, title: "Remote device paired", message: `${device.label} can now open this account's projects through ${relayUrl}.`, severity: "warning", action: { kind: "open-settings" } } })
      }
      await Effect.runPromise(exchangePairing({ userDataRoot: options.userDataRoot, lane: options.lane, relayUrl, identity: runtimeIdentity, window, streams, now, claim, onCommitted }), { signal })
    } catch (error) {
      if (!signal.aborted) {
        lastError = `pairing failed: ${errorMessage(error)}`
        log.warn("remote pairing exchange failed", { error: errorMessage(error) })
      }
    } finally {
      ws.close(1000)
      publish()
    }
  }

  function closePairingWindow(window: OpenPairingWindow): void {
    if (pairing !== window) return
    clearTimeout(window.timer)
    pairing = undefined
    channel.send({ type: "pairing.close", windowId: window.windowId })
    publish()
  }

  const remote: RemoteAccess = {
    view,
    openPairing: () => run(async () => {
      await loadStore()
      assertActive()
      const runtimeIdentity = await requireIdentity()
      assertActive()
      if (pairing) return { windowId: pairing.windowId, code: pairing.code, expiresAt: pairing.expiresAt }
      const created = createPairingWindow({ appOrigin, relayUrl, identity: runtimeIdentity, label: placement.projectLabel, expiresAt: now() + (options.pairingWindowMs ?? PAIRING_WINDOW_MS) })
      const { windowId, code, expiresAt } = created
      const window: OpenPairingWindow = { ...created, timer: setTimeout(() => closePairingWindow(window), expiresAt - now()) }
      window.timer.unref?.()
      pairing = window
      channel.send({ type: "pairing.open", windowId, expiresAt })
      publish()
      channel.reconcile("no paired devices")
      return { windowId, code, expiresAt }
    }),
    cancelPairing: () => run(async () => {
      if (pairing) closePairingWindow(pairing)
    }),
    revokeDevice: (deviceId) => run(async () => {
      await loadStore()
      assertActive()
      if (!devices.some((device) => device.id === deviceId)) return false
      await mutateRemotePairingStore(options.userDataRoot, options.lane, (store) => {
        store.devices = store.devices.filter((device) => device.id !== deviceId)
      })
      refreshPushState()
      for (const live of channels) if (live.deviceId === deviceId) live.ws.close(1008, "device revoked")
      channel.send({ type: "devices", devices: devices.map((device) => device.id) })
      publish()
      channel.reconcile("no paired devices")
      return true
    }),
    renameDevice: (deviceId, label) => run(() => mutateDevice(deviceId, (device) => ({ ...device, label }))),
    forgetProject: (id) => run(async () => {
      await loadStore()
      assertActive()
      // Another placement can have recorded the project since this one read the list.
      projects = await projectRegistry.list()
      const project = projects.find((candidate) => placementId(candidate.projectRoot) === id)
      if (!project) return false
      const before = projects.length
      await projectRegistry.forget(project.projectRoot)
      projects = await projectRegistry.list()
      if (projects.length === before) return false
      publish()
      return true
    }),
    setProcessInitiation: (enabled) => run(async () => {
      if (!options.installation) throw new Error("This placement cannot change Process initiation")
      if (enabled) await options.installation.install()
      else await options.installation.uninstall()
      if (!disposed) await probeHost()
    }),
    setPushSubscription: (deviceId, subscription) => run(async () => {
      await loadStore()
      assertActive()
      if (!devices.some((device) => device.id === deviceId)) return false
      await mutatePushSubscription(deviceId, () => subscription)
      return true
    }),
    pushTargets() {
      const keys = vapid
      if (!keys) return []
      return devices.flatMap((device) => {
        const subscription = subscriptions.get(device.id)
        return subscription === undefined ? [] : [{ deviceId: device.id, label: device.label, subscription, vapid: keys }]
      })
    },
    async notificationAddress() {
      const current = await requireIdentity()
      return { runtimeId: current.runtimeId, placementId: placement.id, machine: machineName(options.lane), project: placement.projectLabel }
    },
    forgetPushSubscription: (deviceId, subscription) => run(async () => {
      await loadStore()
      assertActive()
      // Delivery can settle after this lane revokes the device; the other lane still needs the gone result.
      await mutatePushSubscription(deviceId, (current) => {
        return current?.endpoint === subscription.endpoint && current.keys.p256dh === subscription.keys.p256dh && current.keys.auth === subscription.keys.auth ? undefined : current
      })
    }),
    acceptChannels(handler) {
      accept = handler
      return () => {
        if (accept === handler) accept = undefined
      }
    },
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose() {
      if (closing) return closing
      disposed = true
      work.close()
      clearTimeout(startup)
      for (const stop of stopFollowing) stop()
      stopFaultWatch?.()
      if (pairing) {
        clearTimeout(pairing.timer)
        pairing = undefined
      }
      closing = Promise.allSettled([
        work.settled(),
        Effect.runPromise(Scope.close(dataWork, Exit.void)),
        channel.dispose("runtime stopping"),
      ]).then((results) => {
        listeners.clear()
        const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, "Remote access failed to settle")
      })
      return closing
    },
  }

  const stopFaultWatch = options.accountModuleFaults?.subscribe(publish)

  // Off the startup path: nothing above waits on the store, and a machine
  // with no pairing pays only for one small file read on the next turn of the
  // event loop.
  const startup = setTimeout(() => {
    void run(async () => {
      await loadStore()
      if (disposed) return
      channel.reconcile("no paired devices")
      await probeHost()
    }).catch((error: unknown) => { if (!disposed) log.warn("remote startup failed", { error: errorMessage(error) }) })
  }, 0).unref?.()

  return remote
}
