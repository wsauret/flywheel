import { afterEach, beforeEach, describe, expect, jest, mock, spyOn, test } from "bun:test"
import { Effect, Exit, Stream } from "effect"
import { Socket } from "effect/socket"

import * as connection from "../../../../../src/protocol/client/connection.js"
import * as channel from "../../../../../src/protocol/modules/remote/relay-channel.js"
import { canCreateProject, creationOn, machineStatus, needsRuntime, projectPlacements, projectStatus, selectedMachine, type MachinePickerSnapshot, type RemoteRuntimeSummary } from "../../../../../src/protocol/modules/remote/machine-picker.js"
import * as creating from "../../../../../src/protocol/modules/remote/project-creation.js"
import { createRelayClient, type RelayClient } from "../../../../../src/protocol/modules/remote/relay-client.js"
import type { DeviceStore, PairedRuntime, RemoteSelection } from "../../../../../src/protocol/modules/remote/relay-device.js"
import * as pairing from "../../../../../src/protocol/modules/remote/relay-pairing.js"
import type { Placement } from "../../../../../src/protocol/modules/remote/relay-protocol.js"

/** The shared machine and project picker that every relay client uses. The
 *  relay's sockets are replaced at the relay-channel seam, so presence reports
 *  and attach answers are driven by hand. */

const selected = { runtimeId: "machine", placementId: "project" }
const live: Placement = { id: "project", projectLabel: "Project", version: "0.0.8", protocolVersion: 2, state: "live" }
const paired: PairedRuntime = { runtimeId: "machine", publicKey: "", relay: "wss://relay.example", label: "Machine", pairedAt: 0 }
const watches: Parameters<typeof channel.watchPresence>[] = []
const restores: (() => void)[] = []
let client: RelayClient
/** What the fake device store holds, read back by the tests. */
interface StoredDevice {
  runtimes: PairedRuntime[]
  selection: RemoteSelection | undefined
}
let stored: StoredDevice

async function deviceStore(): Promise<DeviceStore> {
  const keyPair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])
  return {
    device: { keyPair, deviceId: "device", publicKey: new Uint8Array(32) },
    label: () => "Laptop",
    setLabel: async () => {},
    runtimes: async () => stored.runtimes,
    // The phone's store reads the machine list and writes it back in two
    // transactions; the turn between them is where its writes can interleave.
    putRuntime: async (runtime) => {
      const current = stored.runtimes
      await Promise.resolve()
      stored.runtimes = [...current.filter((existing) => existing.runtimeId !== runtime.runtimeId), runtime]
    },
    removeRuntime: async (runtimeId) => {
      const current = stored.runtimes
      await Promise.resolve()
      stored.runtimes = current.filter((existing) => existing.runtimeId !== runtimeId)
    },
    selection: async () => stored.selection,
    setSelection: async (selection) => { stored.selection = selection },
  }
}

/** A device channel whose binary lane ends at once: enough for the attach to
 *  succeed and the sealed socket's run to settle. */
function endedChannel(): channel.DeviceChannel {
  const streams: channel.RelayChannelStreams = {
    readable: new ReadableStream({ start: (controller) => controller.close() }),
    writable: new WritableStream(),
    closed: Promise.resolve({ code: 1000, reason: "", abrupt: false }),
  }
  // The client reads only the channel's streams, so the socket is one that has already closed and ignores every call.
  const ws: WebSocket = {
    url: "ws://relay.invalid/device/r1",
    readyState: 3,
    bufferedAmount: 0,
    protocol: "",
    extensions: "",
    binaryType: "arraybuffer",
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send() {},
    close() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  }
  return { ws, streams }
}

/** Runs the client's socket once, the way the client's connection does. */
function runSocket(relay: RelayClient) {
  return Effect.runPromiseExit(Effect.gen(function*() {
    const socket = yield* Socket.Socket
    yield* Stream.runDrain(Socket.toStream(socket))
  }).pipe(Effect.provide(relay.socket)))
}

function nextChange(relay: RelayClient, until: (snapshot: MachinePickerSnapshot) => boolean): Promise<MachinePickerSnapshot> {
  return new Promise((resolve) => {
    const unsubscribe = relay.onChange((snapshot) => {
      if (!until(snapshot)) return
      unsubscribe()
      resolve(snapshot)
    })
  })
}

beforeEach(async () => {
  watches.length = 0
  stored = { runtimes: [paired], selection: selected }
  const watch = spyOn(channel, "watchPresence").mockImplementation((...args) => {
    watches.push(args)
    return { close() {} }
  })
  const backoff = spyOn(connection, "reconnectBackoffMs").mockReturnValue(0)
  restores.push(() => watch.mockRestore(), () => backoff.mockRestore())
  client = await createRelayClient(await deviceStore())
})

afterEach(async () => {
  await client.forget("machine")
  for (const restore of restores.splice(0)) restore()
})

describe("relay client selection", () => {
  test("does not reconnect the client when making the first selection, and says whether a later one is another project", async () => {
    await client.forget("machine")
    const selectionChanges = mock((_placementChanged: boolean) => {})
    const unsubscribe = client.onSelectionChange(selectionChanges)
    try {
      client.select(selected)
      expect(selectionChanges).not.toHaveBeenCalled()
      // Choosing the same project again asks again on the same project.
      client.select(selected)
      expect(selectionChanges.mock.calls).toEqual([[false]])
      client.select({ runtimeId: "machine", placementId: "other" })
      expect(selectionChanges.mock.calls).toEqual([[false], [true]])
      expect(stored.selection).toEqual({ runtimeId: "machine", placementId: "other" })
    } finally {
      unsubscribe()
    }
  })

  test("forgetting the selected machine stops watching it and clears the selection", async () => {
    watches[0]![3]([live])
    await client.forget("machine")
    expect(client.snapshot().runtimes).toEqual([])
    expect(client.snapshot().selected).toBeUndefined()
    expect(stored).toEqual({ runtimes: [], selection: undefined })
    // The watch the forget closed reports its end; a forgotten machine is not watched again.
    watches[0]![4]("closed")
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(watches).toHaveLength(1)
  })

  test("forgetting the attached machine makes the client leave it, ends a parked wake, and makes the next choice a first one", async () => {
    const dormant: Placement = { ...live, state: "dormant" }
    watches[0]![3]([dormant])
    const attach = spyOn(channel, "attachDeviceChannel").mockRejectedValueOnce(new channel.RelayRefusal("runtime_starting"))
    restores.push(() => attach.mockRestore())
    const starting = nextChange(client, (snapshot) => snapshot.start?.status === "starting")
    const run = runSocket(client)
    await starting
    const selectionChanges = mock((_placementChanged: boolean) => {})
    const unsubscribe = client.onSelectionChange(selectionChanges)
    try {
      await client.forget("machine")
      expect(selectionChanges.mock.calls).toEqual([[true]])
      expect(client.snapshot().start).toBeUndefined()
      // The parked attach fails now rather than at the end of the start window.
      expect(Exit.isFailure(await run)).toBe(true)
      client.select({ runtimeId: "other", placementId: "project" })
      expect(selectionChanges.mock.calls).toEqual([[true]])
    } finally {
      unsubscribe()
    }
  })
})

describe("relay client presence recovery", () => {
  test.each(["closed", "error"] as const)("keeps the selected screen through %s and presence recovery", async (reason) => {
    watches[0]![3]([live])
    const pickerStates: boolean[] = []
    const unsubscribe = client.onChange((snapshot) => pickerStates.push(needsRuntime(snapshot)))
    try {
      watches[0]![4](reason)
      expect(client.snapshot().runtimes[0]?.placements).toEqual([live])
      expect(needsRuntime(client.snapshot())).toBe(false)
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      expect(watches).toHaveLength(2)
      watches[1]![3]([live])
      expect(pickerStates).not.toContain(true)
      expect(client.snapshot().selected).toEqual(selected)
    } finally {
      unsubscribe()
    }
  })

  test("keeps waiting when the first presence connection fails before answering", () => {
    watches[0]![4]("error")
    expect(needsRuntime(client.snapshot())).toBe(false)
  })

  test("requests a runtime stage through a warm offline and dormant transition without changing the selected project", () => {
    watches[0]![3]([live])
    expect(needsRuntime(client.snapshot())).toBe(false)
    watches[0]![3]([])
    expect(needsRuntime(client.snapshot())).toBe(true)
    expect(client.snapshot().runtimes[0]?.presence).toBe("offline")
    expect(client.snapshot().selected).toEqual(selected)
    watches[0]![3]([{ ...live, state: "dormant" }])
    expect(needsRuntime(client.snapshot())).toBe(true)
    expect(client.snapshot().selected).toEqual(selected)
    watches[0]![3]([live])
    expect(needsRuntime(client.snapshot())).toBe(false)
    expect(client.snapshot().selected).toEqual(selected)
  })

  test("adopts and keeps the name the machine placement carries", async () => {
    const named: Placement = { ...live, id: "machine", projectLabel: "dev (desk)" }
    watches[0]![3]([named, live])
    expect(client.snapshot().runtimes[0]?.label).toBe("dev (desk)")
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(stored.runtimes).toEqual([{ ...paired, label: "dev (desk)" }])
  })

  test("keeps the new names of two machines that report them at once", async () => {
    const other: PairedRuntime = { ...paired, runtimeId: "other", label: "Other" }
    const pair = spyOn(pairing, "pairDevice").mockResolvedValue(other)
    restores.push(() => pair.mockRestore())
    await client.pair("https://remote.example/#p=code")
    try {
      watches[0]![3]([{ ...live, id: "machine", projectLabel: "desk" }])
      watches[1]![3]([{ ...live, id: "other", projectLabel: "dev (desk)" }])
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      expect(Object.fromEntries(stored.runtimes.map((runtime) => [runtime.runtimeId, runtime.label]))).toEqual({ machine: "desk", other: "dev (desk)" })
    } finally {
      await client.forget("other")
    }
  })

  test("keeps the paired name when an earlier runtime's machine placement carries no name", async () => {
    watches[0]![3]([{ ...live, id: "machine", projectLabel: creating.LEGACY_MACHINE_PLACEMENT_LABEL }, live])
    expect(client.snapshot().runtimes[0]?.label).toBe("Machine")
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(stored.runtimes).toEqual([paired])
  })

  test("shows the picker when pairing is revoked and does not retry", async () => {
    watches[0]![3]([live])
    watches[0]![4]("device_not_paired")
    expect(needsRuntime(client.snapshot())).toBe(true)
    expect(client.snapshot().runtimes[0]?.placements).toEqual([])
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(watches).toHaveLength(1)
  })
})

describe("relay client pairing", () => {
  test("pairs from a code, keeps the machine, and watches its presence", async () => {
    const other: PairedRuntime = { ...paired, runtimeId: "other", label: "Other" }
    const pair = spyOn(pairing, "pairDevice").mockResolvedValue(other)
    restores.push(() => pair.mockRestore())
    const states: string[] = []
    const unsubscribe = client.onChange((snapshot) => states.push(snapshot.pairing.status))
    try {
      await client.pair("https://remote.example/#p=code")
      expect(pair.mock.calls[0]?.[0]).toBe("https://remote.example/#p=code")
      expect(pair.mock.calls[0]?.[1].label).toBe("Laptop")
      expect(stored.runtimes.map((runtime) => runtime.runtimeId)).toEqual(["machine", "other"])
      expect(watches.map((watch) => watch[1])).toEqual(["machine", "other"])
      expect(client.snapshot().runtimes.map((runtime) => [runtime.runtimeId, runtime.presence])).toEqual([["machine", "watching"], ["other", "watching"]])
      expect(states[0]).toBe("pairing")
      expect(states.at(-1)).toBe("idle")
    } finally {
      unsubscribe()
      await client.forget("other")
    }
  })

  test("a failed pairing carries the reason in the snapshot and the rejection", async () => {
    const pair = spyOn(pairing, "pairDevice").mockRejectedValue(new Error("This pairing code has expired. Show a new one on the machine."))
    restores.push(() => pair.mockRestore())
    await expect(client.pair("https://remote.example/#p=old")).rejects.toThrow("This pairing code has expired")
    expect(client.snapshot().pairing).toEqual({ status: "failed", message: "This pairing code has expired. Show a new one on the machine." })
    expect(stored.runtimes).toEqual([paired])
  })
})

describe("relay client close", () => {
  test("stops watching every machine, ends a parked wake, and dials nothing after a watch ends", async () => {
    const closed = mock(() => {})
    watches.length = 0
    const watch = spyOn(channel, "watchPresence").mockImplementation((...args) => {
      watches.push(args)
      return { close: closed }
    })
    restores.push(() => watch.mockRestore())
    client = await createRelayClient(await deviceStore())
    const dormant: Placement = { ...live, state: "dormant" }
    watches[0]![3]([dormant])
    const attach = spyOn(channel, "attachDeviceChannel").mockRejectedValueOnce(new channel.RelayRefusal("runtime_starting"))
    restores.push(() => attach.mockRestore())
    const starting = nextChange(client, (snapshot) => snapshot.start?.status === "starting")
    const run = runSocket(client)
    await starting
    client.close()
    expect(closed).toHaveBeenCalledTimes(1)
    expect(Exit.isFailure(await run)).toBe(true)
    watches[0]![4]("error")
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(watches).toHaveLength(1)
  })
})

describe("relay client wake", () => {
  test("an asleep project shows starting, waits for presence to report it open, and attaches to it", async () => {
    const dormant: Placement = { ...live, state: "dormant" }
    watches[0]![3]([dormant])
    const attach = spyOn(channel, "attachDeviceChannel")
      .mockImplementationOnce(async (...args) => {
        await args[4]?.(new AbortController().signal)
        throw new channel.RelayRefusal("runtime_starting")
      })
      .mockResolvedValueOnce(endedChannel())
    restores.push(() => attach.mockRestore())
    const starting = nextChange(client, (snapshot) => snapshot.start?.status === "starting")
    const run = runSocket(client)
    const shown = await starting
    expect(projectStatus(shown, "machine", dormant)).toBe("starting")
    expect(attach).toHaveBeenCalledTimes(1)
    watches[0]![3]([live])
    await run
    expect(attach).toHaveBeenCalledTimes(2)
    expect(attach.mock.calls[1]?.slice(0, 3)).toEqual(["wss://relay.example", "machine", "project"])
    expect(client.snapshot().start).toBeUndefined()
  })

  test("a project the machine could not start after starting says so, and choosing it again clears the failure", async () => {
    const dormant: Placement = { ...live, state: "dormant" }
    watches[0]![3]([dormant])
    const opening = Promise.withResolvers<channel.DeviceChannel>()
    const called = Promise.withResolvers<void>()
    const attach = spyOn(channel, "attachDeviceChannel").mockImplementationOnce((...args) => {
      void args[4]?.(new AbortController().signal).catch(() => {})
      called.resolve()
      return opening.promise
    })
    restores.push(() => attach.mockRestore())
    const run = runSocket(client)
    await called.promise
    const starting = projectStatus(client.snapshot(), "machine", dormant)
    opening.reject(new channel.RelayRefusal("runtime_unavailable"))
    const exit = await run
    expect(starting).toBe("starting")
    expect(Exit.isFailure(exit)).toBe(true)
    expect(client.snapshot().start).toEqual({ selection: selected, status: "failed" })
    expect(projectStatus(client.snapshot(), "machine", dormant)).toBe("failed")
    client.select(selected)
    expect(client.snapshot().start).toBeUndefined()
    expect(projectStatus(client.snapshot(), "machine", dormant)).toBe("asleep")
  })

  test.each(["waiting", "handshake", "refusal"] as const)("selection replacement during %s prevents the old wake from replacing the new start", async (stage) => {
    watches[0]![3]([{ ...live, state: "dormant" }])
    const opening = Promise.withResolvers<channel.DeviceChannel>()
    const called = Promise.withResolvers<void>()
    let startWake: ((signal: AbortSignal) => Promise<void>) | undefined
    let waiting: Promise<void> | undefined
    let wakeClosed = false
    const attach = spyOn(channel, "attachDeviceChannel").mockImplementationOnce((...args) => {
      startWake = args[4]
      if (stage === "waiting") {
        waiting = startWake!(new AbortController().signal).finally(() => { wakeClosed = true })
        void waiting.catch((cause: unknown) => opening.reject(cause))
      }
      called.resolve()
      return opening.promise
    })
    restores.push(() => attach.mockRestore())
    const run = runSocket(client)
    await called.promise
    client.select({ runtimeId: "machine", placementId: "other" })
    if (stage === "handshake") {
      waiting = Promise.resolve().then(() => startWake!(new AbortController().signal)).finally(() => { wakeClosed = true })
      void waiting.catch((cause: unknown) => opening.reject(cause))
    }
    try {
      // Cancellation settles the retained channel instead of waiting for presence.
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      if (stage !== "refusal") expect(wakeClosed).toBe(true)
      opening.reject(new channel.RelayRefusal("runtime_unavailable"))
      expect(Exit.isFailure(await run)).toBe(true)
      expect(client.snapshot().selected?.placementId).toBe("other")
      expect(client.snapshot().start).toBeUndefined()
    } finally {
      client.close()
      opening.reject(new Error("test ended"))
      await run
    }
  })

  test("a project that does not report open within the start window says Flywheel could not open it", async () => {
    const dormant: Placement = { ...live, state: "dormant" }
    watches[0]![3]([dormant])
    const attach = spyOn(channel, "attachDeviceChannel").mockRejectedValueOnce(new channel.RelayRefusal("runtime_starting"))
    restores.push(() => attach.mockRestore())
    jest.useFakeTimers()
    try {
      const starting = nextChange(client, (snapshot) => snapshot.start?.status === "starting")
      const run = runSocket(client)
      await starting
      jest.advanceTimersByTime(89_999)
      expect(projectStatus(client.snapshot(), "machine", dormant)).toBe("starting")
      jest.advanceTimersByTime(1)
      expect(projectStatus(client.snapshot(), "machine", dormant)).toBe("failed")
      expect(Exit.isFailure(await run)).toBe(true)
      expect(attach).toHaveBeenCalledTimes(1)
    } finally {
      jest.useRealTimers()
    }
  })

  test("an attach made before any choice waits for the choice", async () => {
    stored.selection = undefined
    client = await createRelayClient(await deviceStore())
    const attach = spyOn(channel, "attachDeviceChannel").mockResolvedValue(endedChannel())
    restores.push(() => attach.mockRestore())
    const run = runSocket(client)
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    expect(attach).not.toHaveBeenCalled()
    client.select(selected)
    await run
    expect(attach.mock.calls[0]?.slice(0, 3)).toEqual(["wss://relay.example", "machine", "project"])
  })
})

describe("relay client project creation", () => {
  test("with nothing chosen, shows cloning, then opening, then chooses the new project and attaches once presence reports it open", async () => {
    await client.forget("machine")
    stored = { runtimes: [paired], selection: undefined }
    client = await createRelayClient(await deviceStore())
    const created = { placementId: "created", projectLabel: "tool" }
    const opened = Promise.withResolvers<creating.CreatedProject>()
    const request = spyOn(creating, "requestProjectCreation").mockImplementation(async (asked) => {
      asked.onOpening(created)
      return opened.promise
    })
    const attach = spyOn(channel, "attachDeviceChannel").mockResolvedValue(endedChannel())
    restores.push(() => request.mockRestore(), () => attach.mockRestore())
    const statuses: (string | undefined)[] = []
    const unsubscribe = client.onChange((snapshot) => statuses.push(creationOn(snapshot, "machine")?.status))
    try {
      const creation = client.createProject("machine", " owner/tool ")
      expect(request.mock.calls[0]?.[0]).toMatchObject({ relay: "wss://relay.example", runtimeId: "machine", repository: "owner/tool" })
      expect(client.snapshot().creation).toEqual({ runtimeId: "machine", repository: "owner/tool", status: "opening", projectLabel: "tool" })
      opened.resolve(created)
      await creation
      expect(statuses).toEqual(["cloning", "opening", undefined])
      const chosen = { runtimeId: "machine", placementId: "created" }
      expect(client.snapshot().selected).toEqual(chosen)
      expect(stored.selection).toEqual(chosen)
      // Presence may not list the new project yet: the row says it is
      // starting, and the attach waits for it to report open.
      const fresh: Placement = { ...live, id: "created", projectLabel: "tool" }
      expect(projectStatus(client.snapshot(), "machine", { ...fresh, state: "dormant" })).toBe("starting")
      const run = runSocket(client)
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      expect(attach).not.toHaveBeenCalled()
      watches.at(-1)![3]([live, fresh])
      await run
      expect(attach.mock.calls[0]?.slice(0, 3)).toEqual(["wss://relay.example", "machine", "created"])
      expect(client.snapshot().start).toBeUndefined()
    } finally {
      unsubscribe()
    }
  })

  test("a project on screen, or one the person chose during the clone, stays chosen when the new project opens", async () => {
    const pending: PromiseWithResolvers<creating.CreatedProject>[] = []
    const request = spyOn(creating, "requestProjectCreation").mockImplementation(() => {
      const opened = Promise.withResolvers<creating.CreatedProject>()
      pending.push(opened)
      return opened.promise
    })
    restores.push(() => request.mockRestore())
    const selectionChanges = mock((_placementChanged: boolean) => {})
    const unsubscribe = client.onSelectionChange(selectionChanges)
    try {
      const onScreen = client.createProject("machine", "owner/tool")
      pending[0]!.resolve({ placementId: "created", projectLabel: "tool" })
      // The new project is the host's to choose: it is answered, not chosen.
      expect(await onScreen).toEqual({ runtimeId: "machine", placementId: "created" })
      expect(client.snapshot().selected).toEqual(selected)
      expect(client.snapshot().creation).toBeUndefined()
      expect(selectionChanges).not.toHaveBeenCalled()

      const chosenMeanwhile = client.createProject("machine", "owner/other")
      const other = { runtimeId: "machine", placementId: "other" }
      client.select(other)
      pending[1]!.resolve({ placementId: "created-other", projectLabel: "other" })
      await chosenMeanwhile
      expect(client.snapshot().selected).toEqual(other)
      expect(client.snapshot().start).toBeUndefined()
      expect(stored.selection).toEqual(other)
      expect(selectionChanges.mock.calls).toEqual([[true]])
    } finally {
      unsubscribe()
    }
  })

  test("a creation the machine refuses carries its reason, and a repository this device cannot read never reaches the machine", async () => {
    const request = spyOn(creating, "requestProjectCreation").mockRejectedValue(new Error("The machine could not read owner/private."))
    restores.push(() => request.mockRestore())
    await expect(client.createProject("machine", "owner/private")).rejects.toThrow("could not read owner/private")
    expect(client.snapshot().creation).toEqual({ runtimeId: "machine", repository: "owner/private", status: "failed", message: "The machine could not read owner/private." })
    expect(client.snapshot().selected).toEqual(selected)
    await expect(client.createProject("machine", "/home/person/secret")).rejects.toThrow("Name a repository as owner/repo")
    expect(request).toHaveBeenCalledTimes(1)
    expect(client.snapshot().creation?.status).toBe("failed")
  })
})

describe("picker states", () => {
  const machine = (overrides: Partial<RemoteRuntimeSummary>): RemoteRuntimeSummary => ({ runtimeId: "r1", label: "desk", relay: "wss://relay", placements: [], presence: "online", ...overrides })
  const snapshot = (overrides: Partial<MachinePickerSnapshot>): MachinePickerSnapshot => ({ deviceLabel: "phone", runtimes: [], selected: undefined, pairing: { status: "idle" }, ...overrides })
  const pick = { runtimeId: "r1", placementId: "p1" }
  const open: Placement = { ...live, id: "p1" }

  test("shows the picker when nothing is chosen or the chosen machine is no longer paired", () => {
    expect(needsRuntime(snapshot({ runtimes: [machine({ placements: [open] })] }))).toBe(true)
    expect(needsRuntime(snapshot({ selected: pick, runtimes: [] }))).toBe(true)
  })

  test("keeps the loading screen while presence has not answered for the chosen machine", () => {
    expect(needsRuntime(snapshot({ selected: pick, runtimes: [machine({ presence: "watching" })] }))).toBe(false)
  })

  test("shows the picker once the relay reports the machine offline or the project asleep", () => {
    expect(needsRuntime(snapshot({ selected: pick, runtimes: [machine({ presence: "offline" })] }))).toBe(true)
    expect(needsRuntime(snapshot({ selected: pick, runtimes: [machine({ placements: [{ ...open, state: "dormant" }] })] }))).toBe(true)
    expect(needsRuntime(snapshot({ selected: pick, runtimes: [machine({ placements: [open] })] }))).toBe(false)
  })

  test("lists the machine placement as an offer to create a project, never as a project", () => {
    const offer: Placement = { ...live, id: "r1", projectLabel: "desk" }
    expect(canCreateProject(machine({ placements: [offer, open] }))).toBe(true)
    expect(canCreateProject(machine({ placements: [open] }))).toBe(false)
    expect(projectPlacements(machine({ placements: [offer, open] }))).toEqual([open])
    // A machine with no project yet is awake and offers to create one.
    expect(machineStatus(machine({ placements: [offer] }))).toEqual({ kind: "awake", open: 0 })
  })

  test("names a machine checking, offline, or awake with its open projects", () => {
    expect(machineStatus(machine({ presence: "watching" }))).toEqual({ kind: "checking" })
    expect(machineStatus(machine({ presence: "offline" }))).toEqual({ kind: "offline" })
    expect(machineStatus(machine({ placements: [{ ...open, state: "dormant" }] }))).toEqual({ kind: "awake", open: 0 })
    expect(machineStatus(machine({ placements: [open, { ...open, id: "p2" }, { ...open, id: "p3", state: "dormant" }] }))).toEqual({ kind: "awake", open: 2 })
  })

  // The fault notice of a page that reaches the machine through the relay
  // names it, and says it is asleep exactly when its row says so.
  test("names the chosen machine for a fault notice, offline exactly when its row says asleep", () => {
    expect(selectedMachine(snapshot({ selected: pick, runtimes: [machine({ placements: [open] })] }))).toEqual({ machine: "desk", offline: false })
    expect(selectedMachine(snapshot({ selected: pick, runtimes: [machine({ presence: "offline" })] }))).toEqual({ machine: "desk", offline: true })
    expect(selectedMachine(snapshot({ selected: pick, runtimes: [machine({ presence: "watching" })] }))).toEqual({ machine: "desk", offline: false })
    expect(selectedMachine(snapshot({ runtimes: [machine({ placements: [open] })] }))).toBeUndefined()
  })

  // A machine that is awake lists the chosen project asleep, starting, or
  // failed, and the page shows that list. The notice states the same state
  // from the same rule, and never that the machine does not answer.
  test("names the chosen project's state for a fault notice exactly as its row states it, while no runtime serves it", () => {
    const dormant: Placement = { ...open, state: "dormant" }
    expect(selectedMachine(snapshot({ selected: pick, runtimes: [machine({ placements: [dormant] })] }))).toEqual({ machine: "desk", offline: false, project: { name: "Project", status: "asleep" } })
    expect(selectedMachine(snapshot({ selected: pick, start: { selection: pick, status: "starting" }, runtimes: [machine({ placements: [dormant] })] }))).toEqual({ machine: "desk", offline: false, project: { name: "Project", status: "starting" } })
    expect(selectedMachine(snapshot({ selected: pick, start: { selection: pick, status: "failed" }, runtimes: [machine({ placements: [dormant] })] }))).toEqual({ machine: "desk", offline: false, project: { name: "Project", status: "failed" } })
  })

  // An awake machine that lists other projects but not the chosen one, as
  // during a start or a stop of the machine, shows no row for it. The
  // notice says that, and never that the awake machine does not answer.
  test("names the chosen project as not offered while the awake machine lists no row for it", () => {
    const other: Placement = { ...open, id: "p2", projectLabel: "Other", state: "dormant" }
    expect(selectedMachine(snapshot({ selected: pick, runtimes: [machine({ placements: [other] })] }))).toEqual({ machine: "desk", offline: false, project: { status: "unlisted" } })
  })

  test("names a project open, asleep, starting, or failed, and a start for another project leaves it asleep", () => {
    const dormant: Placement = { ...open, state: "dormant" }
    expect(projectStatus(snapshot({}), "r1", open)).toBe("open")
    expect(projectStatus(snapshot({ start: { selection: pick, status: "starting" } }), "r1", open)).toBe("open")
    expect(projectStatus(snapshot({}), "r1", dormant)).toBe("asleep")
    expect(projectStatus(snapshot({ start: { selection: pick, status: "starting" } }), "r1", dormant)).toBe("starting")
    expect(projectStatus(snapshot({ start: { selection: pick, status: "failed" } }), "r1", dormant)).toBe("failed")
    expect(projectStatus(snapshot({ start: { selection: { runtimeId: "r1", placementId: "p2" }, status: "starting" } }), "r1", dormant)).toBe("asleep")
    expect(projectStatus(snapshot({ start: { selection: pick, status: "starting" } }), "r2", dormant)).toBe("asleep")
  })
})
