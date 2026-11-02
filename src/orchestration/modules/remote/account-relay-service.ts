import { Cause, Deferred, Effect, Exit, Scope } from "effect"
import { Socket } from "effect/unstable/socket"

import type { ServeLane } from "../../../infra/cli-subprocess.js"
import type { AccountProjectClone, ClonedProject } from "../../app-service/account-project-clone.js"
import type { AccountProjectRegistry } from "../../app-service/account-project-registry.js"
import type { AccountService } from "../../app-service/account-service.js"
import type { RelayChannelSocket } from "../../../protocol/modules/remote/relay-channel.js"
import { decodeJsonFrame, DEFAULT_RELAY_URL, DEFAULT_REMOTE_APP_ORIGIN, fromBase64Url, type OpenFrame, type Placement } from "../../../protocol/modules/remote/relay-protocol.js"
import { decodeRemoteAccountRequest, type RemoteAccountAnswer, type RemoteAccountRequest } from "../../../protocol/modules/remote/account-requests.js"
import type { RemoteConnectionState } from "../../../protocol/modules/remote.js"
import type { AccountModuleRequestServer } from "../../app-service/module-service-host.js"
import { decodeProjectCreateRequest, machinePlacementId, type ProjectCreateRequest, type ProjectCreationAnswer } from "../../../protocol/modules/remote/project-creation.js"
import { sealedSocket } from "../../../protocol/modules/remote/sealed-socket.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../protocol/runtime-liveness.js"
import { bridgeExternalPromise } from "../../agent-runtime/external-promise-bridge.js"
import { importLegacyRemotePlacements, mutateRemotePairingStore, onRemoteStoresWritten, readRemotePairingStore, type PairedDevice } from "./remote-pairing-store.js"
import { createPairingWindow, exchangePairing, machineName, PAIRING_WINDOW_MS, type PairingWindow } from "./remote-pairing-exchange.js"
import { createRelayControlChannel, type RelayControlChannel, type ServedClient } from "./relay-control-channel.js"
import { dialRelayDataChannel } from "./relay-data-channel.js"
import { placementId } from "./remote-access.js"
import { ensureRemoteIdentity, remoteIdentityFrom, type RemoteIdentity } from "./remote-identity.js"
import type { KeepAwake } from "./keep-awake.js"
import { Log } from "../../../infra/log.js"
import { errorDetail, errorMessage } from "../../../infra/error-message.js"
import { durationMs } from "../../../infra/operation-log.js"
import { createBackgroundLane } from "../../../infra/ordered-lane.js"
import { coalesceRepeats } from "../../../infra/repeat-coalescer.js"

const log = Log.create({ service: "account-relay" })

/** How long a device may take to seal the machine channel and name its
 *  repository. */
const CREATE_REQUEST_TIMEOUT_MS = 30_000
/** How long one device's repeated machine channel failures count before the
 *  count is recorded. */
const MACHINE_CHANNEL_FAILURE_WINDOW_MS = 10 * 60_000

const retiredServiceStem = ["remote", "host"].join("-")
export const retiredServiceInstallation = {
  launchdLabel: `sh.flywl.flywheel.${retiredServiceStem}`,
  systemdUnit: `flywheel-${retiredServiceStem}.service`,
  windowsTask: ["Flywheel", "Remote", "Host"].join(" "),
} as const

interface OpenedProject { dispose(): Promise<void> }
/** One creation a device asked for: `cloned` settles once the clone is
 *  recorded, `opened` once the project is open. */
interface ProjectCreation {
  readonly cloned: Promise<ClonedProject>
  readonly opened: Promise<void>
}
interface Announcement {
  readonly root: string
  readonly channel: RelayControlChannel
}
/** How a pairing window ended: the answer each request still waiting on it
 *  ends with, the last request leaving, or the commit of a claimed device
 *  failing. */
type PairingEnd =
  | Extract<RemoteAccountAnswer, { readonly type: "paired" | "expired" | "stopped" }>
  | { readonly type: "withdrawn" }
  | { readonly type: "failed"; readonly error: Error }
/** One pairing window on the machine placement and its one lifecycle.
 *  `scope` owns the window's expiry and every exchange on it, so closing it
 *  interrupts and joins them. The window is open while it is the service's
 *  `pairing`; an exchange that claims it, or any end, withdraws it. */
interface MachinePairing {
  readonly window: PairingWindow
  readonly relayUrl: string
  readonly scope: Scope.Closeable
  readonly ended: PromiseWithResolvers<PairingEnd>
  end?: PairingEnd
  closed?: Promise<void>
  /** Each waiting request's listener for the machine placement's relay state. */
  readonly listeners: Set<(update: Extract<RemoteAccountAnswer, { readonly type: "relay" }>) => void>
}

export interface AccountRelayService {
  /** Called after the account publishes opening, before live project services start. */
  prepareProject(projectRoot: string): Promise<void>
  /** The account's Keep Awake For Phone references by project. `held`
   *  answers whether a phone's wake holds `projectRoot` awake. `hold` holds
   *  an open `projectRoot` awake, as a phone's wake of it does, until the
   *  project closes: a successor calls it for a project the phone kept awake
   *  under the previous build while that build handed its commands over. */
  readonly phoneKeepAwake: { held(projectRoot: string): boolean; hold(projectRoot: string): Promise<void> }
  /** Serves `flywheel remote` (`RemoteAccountRequest`): pairs a device
   *  through the machine placement, revokes a device, or forgets a project.
   *  Each change is written once here, and every placement of this process
   *  applies it as the write commits. */
  readonly serveRequest: AccountModuleRequestServer
  dispose(): Promise<void>
}

/** Owns the account's relay announcements in the account process: one
 *  dormant placement for each recorded project that is not open, which opens
 *  the project through AccountService when a device attaches, and the machine
 *  placement, through which a paired device creates a project from a
 *  repository (`project-creation.ts`) and pairs a device for `flywheel
 *  remote pair`. */
export function createAccountRelayService(options: {
  readonly userDataRoot: string
  readonly lane: ServeLane
  readonly version: string
  /** The web client this service serves; every placement it announces names
   *  it and answers the relay's requests for it. */
  readonly client?: () => Promise<ServedClient | undefined>
  readonly registry: AccountProjectRegistry
  readonly projects: AccountService<OpenedProject>
  /** The account's one clone owner, which a device's request reaches through
   *  the machine placement. */
  readonly projectClone: Pick<AccountProjectClone, "clone">
  readonly keepAwake: KeepAwake
  readonly connectWebSocket?: (url: string) => RelayChannelSocket
  readonly pairingWindowMs?: number
}): AccountRelayService {
  const connect = options.connectWebSocket ?? ((url: string) => new WebSocket(url))
  const announcements = new Map<string, Announcement>()
  const awakeProjects = new Set<string>()
  // Each machine channel a device opened, owned until it ends or the service stops.
  const channelWork = Scope.makeUnsafe("parallel")
  // Phone opens outlive the dormant control that hands ownership to the
  // project. Disposal joins them; clones belong to the clone owner.
  const openings = new Set<Promise<unknown>>()
  const trackOpening = (opening: Promise<void>): Promise<void> => {
    const settled = opening.then(() => {}, () => {})
    openings.add(settled)
    void settled.then(() => openings.delete(settled))
    return opening
  }
  let devices: readonly string[] = []
  let relayUrl = DEFAULT_RELAY_URL
  let identity: RemoteIdentity | undefined
  let pairing: MachinePairing | undefined
  const windows = new Set<MachinePairing>()
  let machineConnection: RemoteConnectionState = "off"
  let machineError: string | null = null
  let disposed = false
  const reconciliation = createBackgroundLane(log, "relay announcements")
  // A device whose client is older than the machine placement attaches to it
  // as if it were a project and retries on its backoff without end. Each
  // device's failures record once, then as one count for each window.
  const machineChannelFailures = coalesceRepeats<string>({
    windowMs: MACHINE_CHANNEL_FAILURE_WINDOW_MS,
    first: (device, error) => log.warn("relay machine channel failed", { device, error }),
    repeated: (device, repeats) => log.warn("relay machine channel failed again", { device, count: repeats.count, windowMs: repeats.windowMs }),
  })
  const dormant = (root: string): boolean => {
    const slot = options.projects.project(root)
    return slot === undefined || (slot.state === "failed" && slot.runtime === undefined)
  }

  /** The relay admits a device by the list it last heard, which can trail a
   *  revocation, so the store decides at the moment of each open. */
  const pairedDevice = (deviceId: string | undefined): PairedDevice | undefined =>
    readRemotePairingStore(options.userDataRoot, options.lane).devices.find((device) => device.id === deviceId)
  const requireIdentity = async (): Promise<RemoteIdentity> => {
    identity ??= await remoteIdentityFrom(readRemotePairingStore(options.userDataRoot, options.lane))
    return identity
  }
  const wanted = () => !disposed && devices.length > 0
  const holdAwake = async (root: string): Promise<void> => {
    if (awakeProjects.has(root)) return
    const wasEmpty = awakeProjects.size === 0
    awakeProjects.add(root)
    if (wasEmpty) await options.keepAwake.hold()
  }
  const releaseAwake = async (root: string): Promise<void> => {
    if (!awakeProjects.delete(root) || awakeProjects.size > 0) return
    await options.keepAwake.release()
  }
  const placement = (record: Awaited<ReturnType<AccountProjectRegistry["list"]>>[number]): Placement => ({
    id: placementId(record.projectRoot),
    projectLabel: record.label,
    version: options.version,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    state: "dormant",
  })

  const announce = (record: Awaited<ReturnType<AccountProjectRegistry["list"]>>[number]): Announcement => {
    const announcement: Announcement = {
      root: record.projectRoot,
      channel: createRelayControlChannel({
        relayUrl: () => relayUrl,
        identity: requireIdentity,
        placement: () => placement(record),
        ...(options.client === undefined ? {} : { client: options.client }),
        devices: () => devices,
        wanted: () => wanted() && dormant(record.projectRoot),
        connect,
        onConnection: () => {},
        onAttached: () => {},
        onOpen: async (frame, send) => {
          if (frame.kind !== "device") return
          if (pairedDevice(frame.deviceId) === undefined) {
            log.warn("dormant project wake refused", { projectRoot: record.projectRoot, device: frame.deviceId, reason: "device not paired" })
            send({ type: "decline", channelId: frame.channelId, reason: "start_failed" })
            return
          }
          await trackOpening((async () => {
            send({ type: "decline", channelId: frame.channelId, reason: "starting" })
            const started = performance.now()
            log.info("device woke a dormant project", { projectRoot: record.projectRoot, device: frame.deviceId })
            try {
              // Register with the canonical opening before waiting for the inhibitor.
              await Promise.all([options.projects.open(record.projectRoot, "device wake"), holdAwake(record.projectRoot)])
            } catch (error) {
              log.warn("project a device woke did not open", { projectRoot: record.projectRoot, device: frame.deviceId, durationMs: durationMs(started), error: errorMessage(error), errorDetail: errorDetail(error) })
              // The dormant control has handed ownership to the project before
              // fallible startup. The account's machine control stays attached.
              machine.send({ type: "decline", channelId: frame.channelId, reason: "start_failed" })
              await releaseAwake(record.projectRoot)
            }
          })())
        },
        // The channel records its own failures; a dormant announcement has
        // no status to publish.
        onFailure: () => {},
      }),
    }
    return announcement
  }

  /** Opens a project a device created and holds the machine awake for it,
   *  as a phone's wake does. */
  const openCreated = async (project: ClonedProject): Promise<void> => {
    // Remote access stopped while the clone ran: the clone is recorded, and
    // the project waits asleep in the list.
    if (disposed) throw new Error(`The machine cloned ${project.label}, and it waits in the list until it is chosen.`)
    await holdAwake(project.projectRoot)
    try {
      await options.projects.open(project.projectRoot, "repository clone")
    } catch (error) {
      await releaseAwake(project.projectRoot)
      log.warn("project a device created did not open", { projectRoot: project.projectRoot, error: errorMessage(error), errorDetail: errorDetail(error) })
      throw new Error(`The machine cloned ${project.label} but could not open it. Choose it to try again.`, { cause: error })
    }
  }

  /** Clones a repository, then opens the project it became. The clone
   *  belongs to the account's clone owner, which stops it when the account
   *  service stops. */
  const createProject = (repository: string): ProjectCreation => {
    const cloned = options.projectClone.clone(repository)
    const opened = cloned.then((project) => trackOpening(openCreated(project)))
    // A device that left before the answer awaits neither; the outcome is
    // logged where it happened.
    opened.catch(() => {})
    return { cloned, opened }
  }

  /** One device's channel to the machine placement: seal it to the device's
   *  recorded key, read its one request, and answer as the creation moves. */
  const handleMachineOpen = (frame: OpenFrame): Effect.Effect<void> => Effect.scoped(Effect.gen(function*() {
    const runtimeIdentity = yield* bridgeExternalPromise(requireIdentity).owned
    const { ws, streams } = yield* dialRelayDataChannel({ connect, relayUrl, runtimeId: runtimeIdentity.runtimeId, frame, control: machine, stopping: () => disposed })
    const device = pairedDevice(frame.deviceId)
    if (device === undefined) {
      log.warn("relay machine channel refused", { device: frame.deviceId, reason: "device not paired" })
      ws.close(1008, "device not paired")
      return
    }
    const inner = yield* Socket.fromTransformStream(Effect.succeed(streams))
    const sealed = sealedSocket(inner, { role: "runtime", publicKey: runtimeIdentity.publicKey, sign: runtimeIdentity.sign }, { kind: "paired", publicKey: fromBase64Url(device.publicKey) })
    const request = yield* Deferred.make<ProjectCreateRequest, Error>()
    yield* Effect.forkScoped(sealed.socket.run((bytes) => {
      try {
        Deferred.doneUnsafe(request, Effect.succeed(decodeJsonFrame(decodeProjectCreateRequest, new TextDecoder().decode(bytes))))
      } catch {
        Deferred.doneUnsafe(request, Effect.fail(new Error("the device sent a request this machine cannot read")))
      }
    }), { startImmediately: true })
    const write = yield* sealed.socket.writer
    // A device that left meanwhile hears nothing; the creation goes on.
    const answer = (message: ProjectCreationAnswer) => write(new TextEncoder().encode(JSON.stringify(message))).pipe(Effect.ignore)
    yield* sealed.established.pipe(Effect.timeoutOrElse({ duration: CREATE_REQUEST_TIMEOUT_MS, orElse: () => Effect.fail(new Error("the device did not complete the handshake in time")) }))
    const asked = yield* Deferred.await(request).pipe(Effect.timeoutOrElse({ duration: CREATE_REQUEST_TIMEOUT_MS, orElse: () => Effect.fail(new Error("the device did not name a repository in time")) }))
    machineChannelFailures.end(device.id)
    log.info("device asked to create a project", { device: device.id })
    const creation = createProject(asked.repository)
    const outcome = yield* Effect.exit(Effect.gen(function*() {
      const project = yield* Effect.tryPromise({ try: () => creation.cloned, catch: (error) => error })
      const named = { placementId: placementId(project.projectRoot), projectLabel: project.label }
      yield* answer({ type: "project.opening", ...named })
      yield* Effect.tryPromise({ try: () => creation.opened, catch: (error) => error })
      yield* answer({ type: "project.created", ...named })
    }))
    if (Exit.isFailure(outcome)) yield* answer({ type: "project.failed", message: errorMessage(Cause.squash(outcome.cause)) })
    // The device closes once it has the answer. Waiting for that, bounded,
    // keeps the answer from being cut off by our own close.
    yield* Effect.promise(() => streams.closed).pipe(Effect.timeoutOption(CREATE_REQUEST_TIMEOUT_MS))
  }).pipe(Effect.catchCause((cause) => Effect.sync(() => {
    if (!disposed) machineChannelFailures.observe(frame.deviceId ?? "unnamed device", String(cause))
  }))))

  /** The machine placement: announced while a device is paired, whatever
   *  projects exist, so a machine with none still offers to create one. It
   *  carries the machine's name, which paired devices adopt as the machine's
   *  label, so a renamed machine needs no new pairing. */
  const machine = createRelayControlChannel({
    relayUrl: () => (pairing ?? [...windows].at(-1))?.relayUrl ?? relayUrl,
    identity: requireIdentity,
    placement: () => {
      // The channel resolves the identity before it reads the placement.
      if (identity === undefined) throw new Error("the machine placement has no identity yet")
      return { id: machinePlacementId(identity.runtimeId), projectLabel: machineName(options.lane), version: options.version, protocolVersion: RUNTIME_PROTOCOL_VERSION, state: "live" }
    },
    ...(options.client === undefined ? {} : { client: options.client }),
    devices: () => devices,
    wanted: () => wanted() || (!disposed && windows.size > 0),
    connect,
    onConnection: (state) => {
      machineConnection = state
      tellRelay()
    },
    onAttached: (send) => {
      machineError = null
      if (pairing) send({ type: "pairing.open", windowId: pairing.window.windowId, expiresAt: pairing.window.expiresAt })
    },
    onOpen: async (frame) => {
      if (disposed) return
      if (frame.kind === "pairing") {
        const current = pairing
        if (current === undefined || current.window.windowId !== frame.windowId) log.warn("relay opened a pairing channel for a window the machine does not hold", { windowId: frame.windowId })
        else Effect.runSync(Effect.forkIn(handlePairingOpen(current, frame), current.scope, { startImmediately: true }))
      } else if (frame.kind === "device") Effect.runSync(Effect.forkIn(handleMachineOpen(frame), channelWork, { startImmediately: true }))
    },
    // The channel records its own failures; a pairing request shows them.
    onFailure: (error) => {
      machineError = error
      tellRelay()
    },
  })

  const tellRelay = (): void => { for (const listener of pairing?.listeners ?? []) listener({ type: "relay", connection: machineConnection, lastError: machineError }) }

  /** Stops offering an open window: the relay withdraws it. The machine
   *  placement stays while the window lives, so a claimed window's exchange
   *  keeps its relay. */
  const withdrawWindow = (current: MachinePairing): void => {
    if (pairing !== current) return
    pairing = undefined
    machine.send({ type: "pairing.close", windowId: current.window.windowId })
  }
  /** Records how the window ended, once; a later end is the same window
   *  closing for another reason and changes nothing. */
  const settleWindow = (current: MachinePairing, end: PairingEnd): void => {
    if (current.end !== undefined) return
    current.end = end
    current.ended.resolve(end)
    log.info("machine pairing window closed", { windowId: current.window.windowId, reason: end.type })
  }
  /** Interrupts and joins the window's expiry and exchanges; the machine
   *  placement then stays only while a device is paired. A fiber of the
   *  window that ends it does not await this, which would join itself. */
  const closeWindow = (current: MachinePairing): Promise<void> => {
    current.closed ??= Effect.runPromise(Scope.close(current.scope, Exit.void)).finally(() => {
      windows.delete(current)
      machine.reconcile("no paired devices")
    })
    return current.closed
  }
  const endWindow = (current: MachinePairing, end: PairingEnd): Promise<void> => {
    withdrawWindow(current)
    settleWindow(current, end)
    return closeWindow(current)
  }

  const openWindow = (through: string, runtimeIdentity: RemoteIdentity): MachinePairing => {
    const window = createPairingWindow({ appOrigin: DEFAULT_REMOTE_APP_ORIGIN, relayUrl: through, identity: runtimeIdentity, label: machineName(options.lane), expiresAt: Date.now() + (options.pairingWindowMs ?? PAIRING_WINDOW_MS) })
    const opened: MachinePairing = { window, relayUrl: through, scope: Scope.makeUnsafe("parallel"), ended: Promise.withResolvers(), listeners: new Set() }
    windows.add(opened)
    pairing = opened
    // A claimed window is no longer open, so its expiry leaves it to the commit.
    Effect.runSync(Effect.forkIn(Effect.sleep(window.expiresAt - Date.now()).pipe(Effect.andThen(Effect.sync(() => {
      if (pairing === opened) void endWindow(opened, { type: "expired" })
    }))), opened.scope, { startImmediately: true }))
    log.info("machine pairing window opened", { windowId: window.windowId, relay: new URL(through).host })
    machine.send({ type: "pairing.open", windowId: window.windowId, expiresAt: window.expiresAt })
    machine.reconcile("no paired devices")
    return opened
  }

  /** The channel the relay opened for an open window: the pairing exchange,
   *  which claims the window at its commit, after which the store write
   *  tells every placement of this process. Runs in the window's scope. */
  const handlePairingOpen = (current: MachinePairing, frame: OpenFrame): Effect.Effect<void> => {
    let claimed = false
    return Effect.scoped(Effect.gen(function*() {
      const runtimeIdentity = yield* bridgeExternalPromise(requireIdentity).owned
      const { streams } = yield* dialRelayDataChannel({ connect, relayUrl: current.relayUrl, runtimeId: runtimeIdentity.runtimeId, frame, control: machine, stopping: () => disposed })
      yield* exchangePairing({
        userDataRoot: options.userDataRoot, lane: options.lane, relayUrl: current.relayUrl, identity: runtimeIdentity, window: current.window, streams, now: Date.now,
        claim: () => {
          if (pairing !== current) return false
          claimed = true
          withdrawWindow(current)
          return true
        },
        onCommitted: (device) => {
          log.info("remote device paired", { device: device.id, label: device.label })
          settleWindow(current, { type: "paired", label: device.label })
          void closeWindow(current)
        },
      })
    })).pipe(Effect.catchCause((cause) => Effect.sync(() => {
      if (claimed) {
        settleWindow(current, { type: "failed", error: new Error(`The machine could not record the device: ${errorMessage(Cause.squash(cause))}`) })
        void closeWindow(current)
      }
      if (!Cause.hasInterruptsOnly(cause)) log.warn("remote pairing exchange failed", { error: String(cause) })
    })))
  }

  /** Opens the machine's pairing window, or joins the open one, and answers
   *  until the window ends: a device pairs, it expires, or the service stops.
   *  The window ends once no request waits on it. A request that names
   *  another relay than the open window's is refused. */
  const pair = async (relayOverride: string | undefined, answer: (answer: RemoteAccountAnswer) => Promise<void>, withdrawn: AbortSignal): Promise<void> => {
    const overrideProtocol = relayOverride === undefined ? "wss:" : URL.parse(relayOverride)?.protocol
    if (overrideProtocol !== "ws:" && overrideProtocol !== "wss:") throw new Error(`The relay must be a ws:// or wss:// URL, not ${relayOverride}`)
    await reconciliation.settled()
    const runtimeIdentity = await ensureRemoteIdentity(options.userDataRoot, options.lane)
    identity = runtimeIdentity
    if (withdrawn.aborted) return
    if (disposed) return answer({ type: "stopped" })
    if (pairing !== undefined && relayOverride !== undefined && relayOverride !== pairing.relayUrl) {
      throw new Error(`A pairing window through ${pairing.relayUrl} is already open. Pair through that relay, or run this again once that window closes.`)
    }
    const current = pairing ?? openWindow(relayOverride ?? relayUrl, runtimeIdentity)
    let answers = answer({ type: "pairing", code: current.window.code, expiresAt: current.window.expiresAt })
    const tell = (update: RemoteAccountAnswer): void => { answers = answers.then(() => answer(update)) }
    current.listeners.add(tell)
    tell({ type: "relay", connection: machineConnection, lastError: machineError })
    const left = Promise.withResolvers<undefined>()
    const leave = (): void => left.resolve(undefined)
    withdrawn.addEventListener("abort", leave, { once: true })
    try {
      const end = await Promise.race([current.ended.promise, left.promise])
      if (end?.type === "failed") throw end.error
      if (end !== undefined && end.type !== "withdrawn") tell(end)
    } finally {
      withdrawn.removeEventListener("abort", leave)
      current.listeners.delete(tell)
      // A claimed window is no longer open; its commit ends it.
      if (current.listeners.size === 0 && pairing === current) await endWindow(current, { type: "withdrawn" })
      await answers
    }
  }

  const revoke = async (deviceId: string): Promise<RemoteAccountAnswer> => {
    let found = false
    await mutateRemotePairingStore(options.userDataRoot, options.lane, (store) => {
      found = store.devices.some((device) => device.id === deviceId)
      store.devices = store.devices.filter((device) => device.id !== deviceId)
    })
    if (!found) return { type: "result", kind: "rejected", message: `No paired device has the id ${deviceId}` }
    log.info("remote device revoked", { device: deviceId })
    return { type: "result", kind: "committed" }
  }

  const forget = async (projectRoot: string): Promise<RemoteAccountAnswer> => {
    if (!(await options.registry.list()).some((project) => project.projectRoot === projectRoot)) return { type: "result", kind: "rejected", message: `No project is recorded at ${projectRoot}` }
    await options.registry.forget(projectRoot)
    return { type: "result", kind: "committed" }
  }

  const serve = async (request: RemoteAccountRequest, answer: (answer: RemoteAccountAnswer) => Promise<void>, withdrawn: AbortSignal): Promise<void> => {
    switch (request.type) {
      case "remote.pair.open": return pair(request.relayUrl, answer, withdrawn)
      case "remote.device.revoke": return answer(await revoke(request.deviceId))
      case "remote.project.forget": return answer(await forget(request.projectRoot))
    }
  }

  const reconcile = async (): Promise<void> => {
    if (disposed) return
    await importLegacyRemotePlacements(options.userDataRoot, options.lane, options.registry)
    const store = readRemotePairingStore(options.userDataRoot, options.lane)
    relayUrl = store.relayUrl ?? DEFAULT_RELAY_URL
    const before = devices
    devices = store.devices.map((device) => device.id)
    // An attached channel told the relay its devices only at attach; a
    // revoked device stays admitted there until it hears the new list.
    if (devices.join(",") !== before.join(",")) {
      const told = [machine, ...[...announcements.values()].map((current) => current.channel)].filter((channel) => channel.send({ type: "devices", devices }))
      log.info("relay device list changed", { devices: devices.length, placementsTold: told.length })
    }
    if (store.identity === undefined) identity = undefined
    // The registry forgets a project whose directory is gone as it lists.
    const retained = await options.registry.list()
    if (disposed) return
    for (const [root, current] of announcements) {
      if (dormant(root) && retained.some((record) => record.projectRoot === root)) continue
      await current.channel.dispose("project no longer dormant")
      announcements.delete(root)
    }
    for (const record of retained) if (dormant(record.projectRoot) && !announcements.has(record.projectRoot)) announcements.set(record.projectRoot, announce(record))
    for (const current of announcements.values()) current.channel.reconcile("no paired devices")
    machine.reconcile("no paired devices")
  }

  const schedule = (): void => { reconciliation.runInBackground("reconcile", reconcile) }
  const stopPairing = onRemoteStoresWritten(options.userDataRoot, schedule)
  const stopRegistry = options.registry.watch(schedule)
  const stopProjects = options.projects.watch((root, project) => {
    if (project === undefined || project.state === "failed") void releaseAwake(root)
    schedule()
  })
  schedule()
  return {
    async prepareProject(root) {
      await reconciliation.settled()
      const current = announcements.get(root)
      await current?.channel.dispose("project opening")
      announcements.delete(root)
    },
    serveRequest: (request, answer, withdrawn) => serve(decodeRemoteAccountRequest(request), answer, withdrawn),
    phoneKeepAwake: {
      held: (root) => awakeProjects.has(root),
      // A dormant project has no close to release the reference, so only an
      // open one takes it.
      hold: async (root) => { if (!disposed && !dormant(root)) await holdAwake(root) },
    },
    async dispose() {
      disposed = true
      // Every waiting request hears that the service stopped, after the join,
      // so a device whose commit was under way ends its window as paired.
      await Promise.all([...windows].map(async (current) => {
        withdrawWindow(current)
        await closeWindow(current)
        settleWindow(current, { type: "stopped" })
      }))
      stopPairing()
      stopRegistry()
      stopProjects()
      await reconciliation.settled()
      await Promise.all([...announcements.values()].map((current) => current.channel.dispose("account service stopping")))
      announcements.clear()
      await machine.dispose("account service stopping")
      await Effect.runPromise(Scope.close(channelWork, Exit.void))
      await Promise.all(openings)
      machineChannelFailures.end()
      awakeProjects.clear()
      await options.keepAwake.release()
    },
  }
}
