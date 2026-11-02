import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import * as channel from "../../src/protocol/modules/remote/relay-channel.js"
import type { DeviceStore } from "../../src/protocol/modules/remote/relay-device.js"
import type { Placement } from "../../src/protocol/modules/remote/relay-protocol.js"
import type { RemoteHostSnapshot } from "../src/host.js"
import { createRelayHost, type RelayHost } from "./relay-host.js"

/** The phone's own additions to the shared relay client: the install guide,
 *  with the browser's install prompt where it offers one. The shared picker's
 *  behavior is tested at its owner, `relay-client.test.ts`. */

const live: Placement = { id: "project", projectLabel: "Project", version: "0.0.8", protocolVersion: 2, state: "live" }
const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window")
const watches: Parameters<typeof channel.watchPresence>[] = []
const windowListeners = new Map<string, (event: Event) => void>()
let host: RelayHost
let restoreWatch: () => void

beforeEach(async () => {
  windowListeners.clear()
  watches.length = 0
  Object.defineProperty(globalThis, "window", { configurable: true, value: { matchMedia: () => ({ matches: false }), addEventListener: (type: string, listener: (event: Event) => void) => windowListeners.set(type, listener) } })
  const watch = spyOn(channel, "watchPresence").mockImplementation((...args) => {
    watches.push(args)
    return { close() {} }
  })
  restoreWatch = () => watch.mockRestore()
  const keyPair = await crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])
  const store: DeviceStore = {
    device: { keyPair, deviceId: "phone", publicKey: new Uint8Array(32) },
    label: () => "Phone",
    setLabel: async () => {},
    runtimes: async () => [{ runtimeId: "machine", publicKey: "", relay: "wss://relay.example", label: "Machine", pairedAt: 0 }],
    putRuntime: async () => {},
    removeRuntime: async () => {},
    selection: async () => ({ runtimeId: "machine", placementId: "project" }),
    setSelection: async () => {},
  }
  host = await createRelayHost(store)
})

afterEach(async () => {
  await host.capability.forget("machine")
  restoreWatch()
  if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor)
  else Reflect.deleteProperty(globalThis, "window")
})

describe("phone relay host", () => {
  test("publishes the shared picker's changes with the install guide beside them", () => {
    const published: RemoteHostSnapshot[] = []
    const unsubscribe = host.capability.onChange((snapshot) => published.push(snapshot))
    try {
      watches[0]![3]([live])
      expect(published.at(-1)?.runtimes[0]?.placements).toEqual([live])
      expect(published.at(-1)?.install?.canPrompt).toBe(false)
    } finally {
      unsubscribe()
    }
  })

  test("offers the browser's install prompt once, and the guide stops offering it after the answer", async () => {
    let prevented = false
    const prompt = { preventDefault: () => { prevented = true }, prompt: async () => {}, userChoice: Promise.resolve({ outcome: "accepted" as const }) }
    windowListeners.get("beforeinstallprompt")?.(Object.assign(new Event("beforeinstallprompt"), prompt))
    expect(prevented).toBe(true)
    expect(host.capability.snapshot().install?.canPrompt).toBe(true)
    expect(await host.capability.promptInstall?.()).toBe(true)
    expect(host.capability.snapshot().install?.canPrompt).toBe(false)
    expect(await host.capability.promptInstall?.()).toBe(false)
  })
})
