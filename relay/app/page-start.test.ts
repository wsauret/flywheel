import { expect, test } from "bun:test"

import type { DeviceStore, PairedRuntime, RemoteSelection } from "../../src/protocol/modules/remote/relay-device.js"
import type { ClientSource, KnownRuntime } from "./client-choice.js"
import { createPageStart, type PairingRequest } from "./page-start.js"

const A = "a".repeat(64)
const RELAY = "wss://relay.flywl.sh"

function machine(runtimeId: string, label: string): PairedRuntime {
  return { runtimeId, publicKey: `key-${runtimeId}`, relay: RELAY, label, pairedAt: 1 }
}

/** A phone as the page finds it at load: what its store holds, the code its
 *  URL carries, and which client each machine's relay names. Every effect
 *  the page has is recorded in the order it happened. */
async function phone(input: { readonly runtimes: readonly PairedRuntime[]; readonly selection: RemoteSelection | undefined; readonly code: string | undefined; readonly current: ReadonlyMap<string, string>; readonly served?: ReadonlySet<string>; readonly address?: RemoteSelection }) {
  const generated = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])
  if (!("privateKey" in generated)) throw new Error("expected an asymmetric key pair")
  let runtimes = [...input.runtimes]
  let selection = input.selection
  let code = input.code
  const events: unknown[] = []
  const screens: PairingRequest[] = []
  const store: DeviceStore = {
    device: { keyPair: generated, deviceId: "phone", publicKey: new Uint8Array(32) },
    label: () => "iPhone",
    setLabel: async () => {},
    runtimes: async () => runtimes,
    putRuntime: async (runtime) => { runtimes = [...runtimes.filter((existing) => existing.runtimeId !== runtime.runtimeId), runtime] },
    removeRuntime: async (runtimeId) => { runtimes = runtimes.filter((existing) => existing.runtimeId !== runtimeId) },
    selection: async () => selection,
    setSelection: async (next) => { selection = next },
  }
  const values = new Map<string, string>()
  const page = createPageStart({
    store,
    notificationAddress: () => input.address ? { selection: input.address, sessionId: "chat", attention: true } : undefined,
    storage: { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) } },
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
  return { page, events, screens, runtimes: () => runtimes, selection: () => selection }
}

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
  expect(labels).toEqual(["Studio"])
  // The new machine joins the saved ones and is the one the page opens: the
  // project selection on another machine is cleared, and the page waits as
  // long as a first pairing does for the new machine to name its client.
  expect(subject.runtimes().map((runtime) => runtime.runtimeId)).toEqual(["desk", "laptop", "studio"])
  expect(subject.selection()).toBeUndefined()
  expect(subject.events.slice(1)).toEqual([
    { paired: "#p=studio" },
    { asked: ["desk", "laptop", "studio"], preferred: "studio", waitMs: 30_000 },
    { loaded: { runtimeId: "studio", relay: RELAY, identity: A } },
  ])
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
