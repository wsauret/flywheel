import { Effect, Layer } from "effect"
import { Socket } from "effect/socket"

import { reconnectBackoffMs } from "../../client/connection.js"
import { attachDeviceChannel, RelayRefusal, watchPresence, type PresenceWatch } from "./relay-channel.js"
import type { MachinePicker, MachinePickerSnapshot, RemoteCreation, RemotePairing, RemoteRuntimeSummary, RemoteStart } from "./machine-picker.js"
import { parseRepository } from "../../repository-reference.js"
import { isMachinePlacement, LEGACY_MACHINE_PLACEMENT_LABEL, requestProjectCreation } from "./project-creation.js"
import { deviceIdentity, type DeviceStore, type PairedRuntime, type RemoteSelection } from "./relay-device.js"
import { pairDevice } from "./relay-pairing.js"
import { fromBase64Url, RELAY_PROJECT_START_TIMEOUT_MS, type Placement } from "./relay-protocol.js"
import { sealedSocket } from "./sealed-socket.js"

/** The device side of remote access, shared by every client that reaches a
 *  runtime through the relay: the live state behind the machine and project
 *  picker, and the `Socket` layer that reaches the chosen project. The
 *  picker's shapes and the states a client draws from them are
 *  `machine-picker.ts`.
 *
 *  It watches presence for every paired machine over one relay socket each,
 *  pairs from a code by running the sealed pairing exchange, asks a machine
 *  to create a project from a repository (`project-creation.ts`), and hands the
 *  client a socket layer whose every acquisition attaches to whichever
 *  placement is selected at that moment, waking it when it is asleep, and
 *  seals the channel to the machine's recorded key. The client sees a
 *  `Socket`; the relay sees ciphertext.
 *
 *  It holds no device storage. The host supplies the device key, the paired
 *  machines, and the last selection through `DeviceStore` (`relay-device.ts`)
 *  and keeps the bytes where its platform keeps them. The relay client lives
 *  as long as the host that made it: the phone page, or the terminal process
 *  that closes it as it exits.
 *
 *  Bun-free and DOM-free apart from `WebSocket`, WebCrypto, and timers, which
 *  every host has. */

const PRESENCE_MAX_ATTEMPT = 8

export interface RelayClient extends MachinePicker {
  /** Attaches to the selected placement on every acquisition. */
  readonly socket: Layer.Layer<Socket.Socket>
  /** Called when the person chooses again, so the host can bring its client
   *  to the choice. `placementChanged` is false when they chose the placement
   *  they already had, which asks the client to make sure it is connected to
   *  the same project, and true when the client must leave the project it
   *  shows. The first choice calls nothing: no project is on screen yet. */
  onSelectionChange(listener: (placementChanged: boolean) => void): () => void
  /** Ends the client: it stops watching every machine, fails an attach that
   *  waits for a placement to start, and dials nothing again. A host whose
   *  client outlives no process, such as the terminal, calls it as it exits. */
  close(): void
}

interface RuntimeState {
  paired: PairedRuntime
  placements: readonly Placement[]
  presence: RemoteRuntimeSummary["presence"]
  watch: PresenceWatch | undefined
  attempt: number
  retry: ReturnType<typeof setTimeout> | undefined
}

export async function createRelayClient(store: DeviceStore): Promise<RelayClient> {
  const identity = deviceIdentity(store.device)
  const runtimes = new Map<string, RuntimeState>()
  let selected: RemoteSelection | undefined = await store.selection()
  let selectionLifetime = new AbortController()
  let pairing: RemotePairing = { status: "idle" }
  let start: RemoteStart | undefined
  let creation: RemoteCreation | undefined
  let closed = false
  // Attach attempts parked on a placement its machine is starting; presence
  // resolves them the moment the placement reports live, and forgetting the
  // machine rejects them.
  const awaitingLive = new Set<{ readonly selection: RemoteSelection; readonly resolve: () => void; readonly reject: (cause: Error) => void }>()
  // Attach attempts made while nothing is selected park here rather than fail:
  // failing would put the client's connection into backoff, and the person
  // choosing a project a minute later would wait out that backoff for nothing.
  let awaitingSelection: ((selection: RemoteSelection) => void)[] = []
  const selectionSettled = (): Promise<RemoteSelection> => selected ? Promise.resolve(selected) : new Promise((resolve) => { awaitingSelection.push(resolve) })
  const listeners = new Set<(snapshot: MachinePickerSnapshot) => void>()
  const selectionListeners = new Set<(placementChanged: boolean) => void>()
  // The phone's store reads and rewrites the whole machine list in separate
  // transactions, so two writes in flight can lose one: a machine's new name,
  // a new pairing, or a forget. This client makes them one at a time.
  let runtimeWrites: Promise<void> = Promise.resolve()
  const writeRuntimes = (write: () => Promise<void>): Promise<void> => {
    const written = runtimeWrites.then(write)
    runtimeWrites = written.catch(() => {})
    return written
  }

  function snapshot(): MachinePickerSnapshot {
    return {
      deviceLabel: store.label(),
      runtimes: [...runtimes.values()].map((state) => ({ runtimeId: state.paired.runtimeId, label: state.paired.label, relay: state.paired.relay, placements: state.placements, presence: state.presence })),
      selected,
      pairing,
      ...(start === undefined ? {} : { start }),
      ...(creation === undefined ? {} : { creation }),
    }
  }

  function publish(): void {
    const current = snapshot()
    for (const listener of listeners) listener(current)
  }

  function placementOf(selection: RemoteSelection): Placement | undefined {
    return runtimes.get(selection.runtimeId)?.placements.find((placement) => placement.id === selection.placementId)
  }

  /** Resolves once the selected placement reports live. After the start
   *  window it rejects, and the placement's row says Flywheel could not open
   *  it (PI-REMOTE-009). */
  function whenLive(selection: RemoteSelection, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (placementOf(selection)?.state === "live") return Promise.resolve()
    return new Promise((resolve, reject) => {
      const settle = (outcome: () => void) => { clearTimeout(timer); signal.removeEventListener("abort", abort); awaitingLive.delete(waiter); outcome() }
      const waiter = { selection, resolve: () => settle(resolve), reject: (cause: Error) => settle(() => reject(cause)) }
      const abort = () => waiter.reject(new Error("the selected project changed"))
      const timer = setTimeout(() => {
        if (start?.selection === selection) {
          start = { selection, status: "failed" }
          publish()
        }
        waiter.reject(new Error("The machine did not start Flywheel in time."))
      }, RELAY_PROJECT_START_TIMEOUT_MS)
      awaitingLive.add(waiter)
      signal.addEventListener("abort", abort, { once: true })
    })
  }

  /** Keeps one presence socket open per machine, retrying on the client's
   *  backoff. A machine that is asleep shows as asleep; the relay says so by
   *  listing no placements, and a relay that is down says so by refusing. */
  function watch(state: RuntimeState): void {
    state.watch?.close()
    state.presence = state.attempt === 0 ? "watching" : state.presence
    publish()
    state.watch = watchPresence(state.paired.relay, state.paired.runtimeId, identity, (placements) => {
      state.attempt = 0
      state.placements = placements
      state.presence = placements.length > 0 ? "online" : "offline"
      for (const waiter of awaitingLive) {
        if (waiter.selection.runtimeId === state.paired.runtimeId && placements.some((placement) => placement.id === waiter.selection.placementId && placement.state === "live")) waiter.resolve()
      }
      if (start !== undefined && placementOf(start.selection)?.state === "live") start = undefined
      // The machine placement carries the machine's current name. The store
      // keeps it for while the machine sleeps; a write that fails only means
      // the next launch shows the earlier name until the machine wakes.
      const named = placements.find((placement) => isMachinePlacement(state.paired.runtimeId, placement))?.projectLabel
      if (named !== undefined && named !== LEGACY_MACHINE_PLACEMENT_LABEL && named !== state.paired.label) {
        const renamed = { ...state.paired, label: named }
        state.paired = renamed
        writeRuntimes(() => store.putRuntime(renamed)).catch(() => {})
      }
      publish()
    }, (reason) => {
      // A lost presence socket says nothing about the machine's availability.
      // Keep its last report while reconnecting; only a relay reply can replace it.
      if (reason !== "closed" && reason !== "error") {
        state.placements = []
        state.presence = "offline"
        publish()
      }
      if (reason === "device_not_paired") return
      if (closed || !runtimes.has(state.paired.runtimeId)) return
      state.retry = setTimeout(() => watch(state), reconnectBackoffMs(state.attempt))
      state.attempt = Math.min(state.attempt + 1, PRESENCE_MAX_ATTEMPT)
    })
  }

  function adopt(paired: PairedRuntime): void {
    const existing = runtimes.get(paired.runtimeId)
    existing?.watch?.close()
    if (existing?.retry !== undefined) clearTimeout(existing.retry)
    const state: RuntimeState = { paired, placements: [], presence: "watching", watch: undefined, attempt: 0, retry: undefined }
    runtimes.set(paired.runtimeId, state)
    watch(state)
  }

  for (const paired of await store.runtimes()) adopt(paired)

  /** Makes `selection` the chosen project. Choosing again is asking again: a
   *  start that failed is retried on the next attach, which the client makes
   *  at once because its lane is down. `starting` marks a project its machine
   *  is already opening. */
  function choose(selection: RemoteSelection, starting: "starting" | undefined): void {
    const previous = selected
    selectionLifetime.abort()
    selectionLifetime = new AbortController()
    selected = selection
    start = starting === undefined ? undefined : { selection, status: starting }
    // The choice holds for this page whether or not the store keeps it; a
    // write that fails only means the next launch opens on the picker.
    store.setSelection(selection).catch(() => {})
    publish()
    const waiting = awaitingSelection
    awaitingSelection = []
    for (const resolve of waiting) resolve(selection)
    if (previous !== undefined) {
      const placementChanged = previous.runtimeId !== selection.runtimeId || previous.placementId !== selection.placementId
      for (const listener of selectionListeners) listener(placementChanged)
    }
  }

  /** Attaches to a placement. A dormant one answers `runtime_starting` while
   *  its machine starts a runtime; the attach then waits for presence to report
   *  the placement live and attaches to the runtime, so the person chooses
   *  once. `runtime_unavailable` is the machine saying it could not start one.
   *  A placement this device already knows is starting, such as a project its
   *  machine just created and opened, is waited for before the attach, since
   *  presence may not list it yet. */
  async function attach(state: RuntimeState, current: RemoteSelection) {
    const signal = selectionLifetime.signal
    if (closed || selected !== current) throw new Error("the selected project changed")
    if (start?.status === "starting" && start.selection === current) await whenLive(current, signal)
    try {
      const channel = await attachDeviceChannel(state.paired.relay, current.runtimeId, current.placementId, identity, (wakeSignal) => {
        signal.throwIfAborted()
        start = { selection: current, status: "starting" }
        publish()
        return whenLive(current, AbortSignal.any([signal, wakeSignal]))
      })
      if (start?.selection === current) {
        start = undefined
        publish()
      }
      return channel
    } catch (cause) {
      if (signal.aborted) throw cause
      if (cause instanceof RelayRefusal && cause.reason !== "runtime_starting") {
        for (const waiter of awaitingLive) {
          if (waiter.selection === current) waiter.reject(cause)
        }
      }
      if (!(cause instanceof RelayRefusal)) throw cause
      if (cause.reason === "runtime_unavailable") {
        start = { selection: current, status: "failed" }
        publish()
        throw new Error("The machine could not start Flywheel for this project.", { cause })
      }
      if (cause.reason !== "runtime_starting") throw cause
      if (placementOf(current)?.state !== "live") {
        start = { selection: current, status: "starting" }
        publish()
        await whenLive(current, signal)
      }
      return await attachDeviceChannel(state.paired.relay, current.runtimeId, current.placementId, identity)
    }
  }

  /** Every acquisition attaches to the current selection and seals the channel
   *  to that machine's recorded key. Attaching happens inside the socket's own
   *  run, so a refusal is a socket failure the client's connection retries. */
  const socket = Layer.effect(Socket.Socket)(Effect.gen(function*() {
    const current = yield* Effect.promise(selectionSettled)
    const state = runtimes.get(current.runtimeId)
    const openFailure = (cause: unknown) => new Socket.SocketError({ reason: new Socket.SocketOpenError({ kind: "Unknown", cause }) })
    if (!state) return yield* Socket.fromTransformStream(Effect.fail(openFailure(new Error("the selected machine is no longer paired"))))
    const inner = yield* Socket.fromTransformStream(Effect.tryPromise({
      try: () => attach(state, current),
      catch: openFailure,
    }).pipe(Effect.map((channel) => channel.streams)))
    return sealedSocket(inner, { role: "device", publicKey: store.device.publicKey, sign: identity.sign }, { kind: "paired", publicKey: fromBase64Url(state.paired.publicKey) }).socket
  }))

  return {
    deviceId: store.device.deviceId,
    snapshot,
    onChange(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    async pair(text) {
      pairing = { status: "pairing" }
      publish()
      try {
        const paired = await pairDevice(text, { publicKey: store.device.publicKey, sign: identity.sign, label: store.label() })
        await writeRuntimes(() => store.putRuntime(paired))
        adopt(paired)
        pairing = { status: "idle" }
        publish()
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        pairing = { status: "failed", message }
        publish()
        throw new Error(message, { cause })
      }
    },
    async setLabel(label) {
      await store.setLabel(label)
      publish()
    },
    select(selection) {
      choose(selection, undefined)
    },
    async forget(runtimeId) {
      const state = runtimes.get(runtimeId)
      state?.watch?.close()
      if (state?.retry !== undefined) clearTimeout(state.retry)
      runtimes.delete(runtimeId)
      for (const waiter of awaitingLive) {
        if (waiter.selection.runtimeId === runtimeId) waiter.reject(new Error("the selected machine is no longer paired"))
      }
      if (start?.selection.runtimeId === runtimeId) start = undefined
      if (creation?.runtimeId === runtimeId) creation = undefined
      const leftSelection = selected?.runtimeId === runtimeId
      if (leftSelection) {
        selectionLifetime.abort()
        selectionLifetime = new AbortController()
        selected = undefined
      }
      await writeRuntimes(() => store.removeRuntime(runtimeId))
      if (leftSelection) await store.setSelection(undefined)
      publish()
      // The client must leave the forgotten machine's project. The next choice
      // is then a first choice again: no project is on screen.
      if (leftSelection) for (const listener of selectionListeners) listener(true)
    },
    async createProject(runtimeId, text, options) {
      const state = runtimes.get(runtimeId)
      if (!state) throw new Error("This device is not paired with that machine.")
      if (creation !== undefined && creation.status !== "failed") throw new Error("This device is already creating a project. Wait for it to open.")
      const repository = text.trim()
      const fail = (cause: unknown): Error => {
        const message = cause instanceof Error ? cause.message : String(cause)
        // A machine forgotten meanwhile, or a closed client, has no row to say it on.
        if (!closed && runtimes.has(runtimeId)) {
          creation = { runtimeId, repository, status: "failed", message }
          publish()
        }
        return new Error(message, { cause })
      }
      try {
        parseRepository(repository)
      } catch (cause) {
        throw fail(cause)
      }
      creation = { runtimeId, repository, status: "cloning" }
      publish()
      let created: Awaited<ReturnType<typeof requestProjectCreation>>
      try {
        created = await requestProjectCreation({
          relay: state.paired.relay,
          runtimeId,
          runtimePublicKey: state.paired.publicKey,
          device: identity,
          repository,
          onOpening: (project) => {
            if (creation?.runtimeId !== runtimeId) return
            creation = { runtimeId, repository, status: "opening", projectLabel: project.projectLabel }
            publish()
          },
        })
      } catch (cause) {
        throw fail(cause)
      }
      const project = { runtimeId, placementId: created.placementId }
      if (closed || !runtimes.has(runtimeId)) return project
      creation = undefined
      publish()
      // A clone can take minutes. A project the person has on screen, or one
      // they chose meanwhile, stays as they left it, and the new project
      // shows in the list like any project the machine opened. With nothing
      // chosen, or with a host that has no project on screen, the person
      // waits for this project: it is starting until presence reports it
      // open, and then the client attaches.
      if (selected === undefined || options?.choose === true) choose(project, "starting")
      return project
    },
    socket,
    close() {
      closed = true
      selectionLifetime.abort()
      creation = undefined
      for (const state of runtimes.values()) {
        state.watch?.close()
        if (state.retry !== undefined) clearTimeout(state.retry)
      }
      for (const waiter of awaitingLive) waiter.reject(new Error("the relay client is closed"))
    },
    onSelectionChange(listener) {
      selectionListeners.add(listener)
      return () => {
        selectionListeners.delete(listener)
      }
    },
  }
}
