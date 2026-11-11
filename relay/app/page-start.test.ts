import { expect, test } from "bun:test"

import type { PairedRuntime, RemoteSelection } from "../../src/protocol/modules/remote/relay-device.js"
import type { ClientSource, KnownRuntime } from "./client-choice.js"
import type { PageDeviceStore } from "./device-store.js"
import { createPageStart, type PairingRequest } from "./page-start.js"

const A = "a".repeat(64)
const RELAY = "wss://relay.flywl.sh"

function machine(runtimeId: string, label: string): PairedRuntime {
  return { runtimeId, publicKey: `key-${runtimeId}`, relay: RELAY, label, pairedAt: 1 }
}

/** A phone as the page finds it at load: what its store holds, the code its
 *  URL carries, and which client each machine's relay names. Every effect
 *  the page has is recorded in the order it happened. */
async function phone(input: { readonly runtimes: readonly PairedRuntime[]; readonly selection: RemoteSelection | undefined; readonly code: string | undefined; readonly current: ReadonlyMap<string, string>; readonly served?: ReadonlySet<string>; readonly address?: RemoteSelection; readonly installed?: boolean }) {
  const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])
  if (!("privateKey" in generated)) throw new Error("expected an asymmetric key pair")
  let runtimes = [...input.runtimes]
  let selection = input.selection
  let code = input.code
  const events: unknown[] = []
  const screens: PairingRequest[] = []
  const listeners: Parameters<PageDeviceStore["onRuntimePut"]>[0][] = []
  const store: PageDeviceStore = {
    device: { keyPair: generated, deviceId: "phone", publicKey: new Uint8Array(32) },
    label: () => "iPhone",
    setLabel: async () => {},
    runtimes: async () => runtimes,
    putRuntime: async (runtime) => {
      const previous = runtimes.find((existing) => existing.runtimeId === runtime.runtimeId)
      runtimes = [...runtimes.filter((existing) => existing.runtimeId !== runtime.runtimeId), runtime]
      for (const listener of listeners) listener(runtime, previous)
    },
    removeRuntime: async (runtimeId) => { runtimes = runtimes.filter((existing) => existing.runtimeId !== runtimeId) },
    selection: async () => selection,
    setSelection: async (next) => { selection = next },
    onRuntimePut: (listener) => { listeners.push(listener) },
  }
  const values = new Map<string, string>()
  const page = createPageStart({
    store,
    installed: input.installed ?? false,
    notificationAddress: () => input.address ? { selection: input.address, sessionId: "chat", attention: true } : undefined,
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: (key) => { values.delete(key) } },
    reload: () => { events.push("reload") },
    takePairingCode: () => {
      const taken = code
      code = undefined
      return taken
    },
    currentClients: async (paired, preferred, waitMs): Promise<KnownRuntime[]> => {
      events.push({ asked: paired.map((runtime) => runtime.runtimeId), preferred, waitMs })
      return paired.map((runtime) => ({ runtimeId: runtime.runtimeId, relay: runtime.relay, current: input.current.get(runtime.runtimeId) }))
    },
    pairDevice: async (text) => {
      events.push({ paired: text })
      return machine("studio", "Studio")
    },
    loadShell: async (source: ClientSource) => {
      if (input.served !== undefined && !input.served.has(source.identity)) throw new Error("not served")
      events.push({ loaded: source })
    },
    showPairing: (request) => {
      events.push({ pairing: request.code, unreachable: request.unreachable })
      screens.push(request)
    },
  })
  return { page, store, events, screens, runtimes: () => runtimes, selection: () => selection }
}

/** Lets the page finish what a store write started. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0) })

test("a pairing link is used first, before the page asks about the machines it already pairs with", async () => {
  const subject = await phone({
    runtimes: [machine("desk", "Desk"), machine("laptop", "Laptop")],
    selection: { runtimeId: "desk", placementId: "p1" },
    code: "#p=studio",
    current: new Map([["studio", A]]),
  })
  await subject.page.start()
  expect(subject.events).toEqual([{ pairing: "#p=studio", unreachable: undefined }])

  const labels: string[] = []
  await subject.screens[0]!.pair("#p=studio", (label) => labels.push(label))
  await settle()
  expect(labels).toEqual(["Studio"])
  // The new machine joins the saved ones, and the page loads afresh, so that
  // the manifest it builds at load carries the new machine into an app the
  // person installs next (PI-REMOTE-032).
  expect(subject.runtimes().map((runtime) => runtime.runtimeId)).toEqual(["desk", "laptop", "studio"])
  expect(subject.selection()).toBeUndefined()
  expect(subject.events.slice(1)).toEqual([{ paired: "#p=studio" }, "reload"])

  // The fresh page opens the new machine: the project selection on another
  // machine was cleared, and the page waits as long as a first pairing does
  // for the new machine to name its client. A later load is ordinary again.
  await subject.page.start()
  await subject.page.start()
  expect(subject.events.slice(3)).toEqual([
    { asked: ["desk", "laptop", "studio"], preferred: "studio", waitMs: 30_000 },
    { loaded: { runtimeId: "studio", relay: RELAY, identity: A } },
    { asked: ["desk", "laptop", "studio"], preferred: undefined, waitMs: 3_000 },
    { loaded: { runtimeId: "studio", relay: RELAY, identity: A } },
  ])
})

test("a pairing the loaded shell makes also loads the page again, and a new name for a machine does not", async () => {
  const subject = await phone({ runtimes: [machine("desk", "Desk")], selection: { runtimeId: "desk", placementId: "p1" }, code: undefined, current: new Map([["desk", A], ["studio", A]]) })
  await subject.page.start()
  expect(subject.events).toEqual([{ asked: ["desk"], preferred: "desk", waitMs: 30_000 }, { loaded: { runtimeId: "desk", relay: RELAY, identity: A } }])
  const loaded = subject.events.length

  // The shell keeps the name the machine now goes by: the same pairing.
  await subject.store.putRuntime({ ...machine("desk", "Desk"), label: "Studio desk" })
  await settle()
  expect(subject.events.length).toBe(loaded)
  expect(subject.selection()).toEqual({ runtimeId: "desk", placementId: "p1" })

  // The shell pairs a new machine, from Scan a code or a link tapped while it
  // is open. Safari built this load's manifest without it, so the page loads
  // again and opens the new machine, as a pairing on the page's own screen does.
  await subject.store.putRuntime(machine("studio", "Studio"))
  await settle()
  expect(subject.events.slice(loaded)).toEqual(["reload"])
  expect(subject.selection()).toBeUndefined()
  await subject.page.start()
  expect(subject.events.slice(loaded + 1)).toEqual([
    { asked: ["desk", "studio"], preferred: "studio", waitMs: 30_000 },
    { loaded: { runtimeId: "studio", relay: RELAY, identity: A } },
  ])

  // Pairing a machine again gives it a new pairing time, so it counts too.
  await subject.store.putRuntime({ ...machine("desk", "Studio desk"), pairedAt: 2 })
  await settle()
  expect(subject.events.at(-1)).toBe("reload")
})

test("the installed app loads again after a pairing on the page's screen, and its shell opens a machine it pairs in place", async () => {
  const subject = await phone({ installed: true, runtimes: [], selection: undefined, code: undefined, current: new Map([["studio", A]]) })
  await subject.page.start()
  await subject.screens[0]!.pair("#p=studio", () => {})
  await settle()
  expect(subject.events).toEqual([{ pairing: undefined, unreachable: undefined }, { paired: "#p=studio" }, "reload"])

  // The app has no manifest to rebuild, so the shell keeps the screen it shows.
  await subject.page.start()
  const loaded = subject.events.length
  await subject.store.putRuntime(machine("laptop", "Laptop"))
  await settle()
  expect(subject.events.slice(loaded - 1)).toEqual([{ loaded: { runtimeId: "studio", relay: RELAY, identity: A } }])
})

test("a notification chooses its machine and project before loading that machine's shell", async () => {
  const subject = await phone({ runtimes: [machine("desk", "Desk"), machine("studio", "Studio")], selection: { runtimeId: "desk", placementId: "old" }, address: { runtimeId: "studio", placementId: "target" }, code: undefined, current: new Map([["desk", A], ["studio", "b".repeat(64)]]) })
  await subject.page.start()
  expect(subject.selection()).toEqual({ runtimeId: "studio", placementId: "target" })
  expect(subject.events).toEqual([{ asked: ["desk", "studio"], preferred: "studio", waitMs: 30_000 }, { loaded: { runtimeId: "studio", relay: RELAY, identity: "b".repeat(64) } }])
})

test("saved machines that are all offline, with no link, show the pairing instructions rather than a load error", async () => {
  const subject = await phone({ runtimes: [machine("desk", "Desk")], selection: { runtimeId: "desk", placementId: "p1" }, code: undefined, current: new Map() })
  await subject.page.start()
  expect(subject.events).toEqual([
    { asked: ["desk"], preferred: "desk", waitMs: 30_000 },
    { pairing: undefined, unreachable: { machine: "Desk" } },
  ])
})

test("a machine whose relay names a client it cannot serve also shows the pairing instructions", async () => {
  const subject = await phone({ runtimes: [machine("desk", "Desk")], selection: undefined, code: undefined, current: new Map([["desk", A]]), served: new Set() })
  await subject.page.start()
  expect(subject.events).toEqual([
    { asked: ["desk"], preferred: undefined, waitMs: 30_000 },
    { pairing: undefined, unreachable: { machine: "Desk" } },
  ])
})

test("the only saved machine is named in the note even when the phone has no project selection", async () => {
  const subject = await phone({ runtimes: [machine("desk", "Desk")], selection: undefined, code: undefined, current: new Map() })
  await subject.page.start()
  expect(subject.events).toEqual([
    { asked: ["desk"], preferred: undefined, waitMs: 30_000 },
    { pairing: undefined, unreachable: { machine: "Desk" } },
  ])
})
