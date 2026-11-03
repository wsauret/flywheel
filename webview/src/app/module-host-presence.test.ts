import { describe, expect, it } from "bun:test"
import { Layer } from "effect"
import { Socket } from "effect/socket"
import { createRoot, createSignal, onCleanup } from "solid-js"

import type { ModuleId } from "../../../src/protocol/module-ids.js"
import type { ClientHost } from "../host.js"
import type { WebModule } from "../web-module.js"
import { createModuleHostPresence } from "./module-host-presence.js"
import type { ScreenStack } from "./screen-stack.js"

const host: ClientHost = { capabilities: {}, socket: Layer.sync(Socket.Socket, () => { throw new Error("No socket in this test") }) }
const tick = async () => { await Promise.resolve(); await Promise.resolve() }

describe("module host presence ownership", () => {
  it("admits preconnection presence, keeps equivalent selections stable, and owns each enabled generation", async () => {
    let acquired = 0
    let released = 0
    let stacks = 0
    let closedStacks = 0
    const Stage = () => "Acquiring workspace"
    const module: WebModule = { id: "development", hostPresence: () => {
      acquired += 1
      onCleanup(() => { released += 1 })
      return { stage: () => Stage, placement: () => ({ project: "workspace", machine: "host" }), reach: () => ({ machine: "host", offline: true }), navigation: "stack" }
    } }
    const createStack = (placement: ScreenStack["placement"]): ScreenStack => {
      stacks += 1
      onCleanup(() => { closedStacks += 1 })
      return { placement, screen: () => "sessions", canForward: () => false, dragX: () => undefined, openChat() {}, showSessions() {}, back() {}, forward() {}, bindSwipe: () => () => {} }
    }
    const h = createRoot((dispose) => {
      const [enabled, setEnabled] = createSignal<readonly ModuleId[] | undefined>()
      return { dispose, setEnabled, presence: createModuleHostPresence([module], host, enabled, () => {}, { createStack }) }
    })
    try {
      await tick()
      expect(acquired).toBe(1)
      expect(stacks).toBe(1)
      expect(h.presence.stage()).toBe(Stage)
      expect(h.presence.reach()).toEqual({ machine: "host", offline: true })
      h.setEnabled(["development"])
      h.setEnabled(["development"])
      await tick()
      expect(acquired).toBe(1)
      expect(stacks).toBe(1)
      h.setEnabled([])
      await tick()
      expect(released).toBe(1)
      expect(closedStacks).toBe(1)
      expect(h.presence.stage()).toBeUndefined()
      expect(h.presence.placement()).toBeUndefined()
      expect(h.presence.reach()).toBeUndefined()
      expect(h.presence.stack()).toBeUndefined()
      h.setEnabled(["development"])
      await tick()
      expect(acquired).toBe(2)
      expect(stacks).toBe(2)
      h.dispose()
      expect(released).toBe(2)
      expect(closedStacks).toBe(2)
    } finally { h.dispose() }
  })

  it("tells the connection once each time the runtime it reaches appears, never for a runtime already there", async () => {
    // A machine that restarted lists the chosen project asleep, then open.
    // The open is the evidence that a fault from the asleep time is stale.
    const [served, setServed] = createSignal(true)
    const module: WebModule = { id: "remote", hostPresence: () => ({ stage: () => undefined, placement: () => undefined, served }) }
    let appeared = 0
    const h = createRoot((dispose) => ({ dispose, presence: createModuleHostPresence([module], host, () => ["remote"], () => {}, { appeared: () => { appeared += 1 } }) }))
    try {
      await tick()
      expect(appeared).toBe(0)
      setServed(false)
      await tick()
      expect(appeared).toBe(0)
      setServed(true)
      await tick()
      expect(appeared).toBe(1)
      setServed(true)
      await tick()
      expect(appeared).toBe(1)
    } finally { h.dispose() }
  })

  it("does not acquire a disabled module or its browser navigation", async () => {
    let acquired = 0
    const module: WebModule = { id: "development", hostPresence: () => { acquired += 1; throw new Error("Must not acquire") } }
    const h = createRoot((dispose) => ({ dispose, presence: createModuleHostPresence([module], host, () => [], () => { throw new Error("Must not report") }) }))
    try { await tick(); expect(acquired).toBe(0); expect(h.presence.stack()).toBeUndefined() }
    finally { h.dispose() }
  })

  it("releases a failed stack factory once, preserves other slots, and retries after readmission", async () => {
    let acquired = 0
    let released = 0
    const reports: { module: ModuleId; error: unknown }[] = []
    const failure = new Error("stack failed")
    const Stage = () => "independent stage"
    const modules: readonly WebModule[] = [
      { id: "development", hostPresence: () => ({ stage: () => undefined, placement: () => undefined, navigation: "stack" }) },
      { id: "mcp", hostPresence: () => ({ stage: () => Stage, placement: () => ({ project: "workspace", machine: "host" }) }) },
    ]
    const createStack = (placement: ScreenStack["placement"]): ScreenStack => {
      acquired += 1
      onCleanup(() => { released += 1 })
      if (acquired === 1) throw failure
      return { placement, screen: () => "sessions", canForward: () => false, dragX: () => undefined, openChat() {}, showSessions() {}, back() {}, forward() {}, bindSwipe: () => () => {} }
    }
    const h = createRoot((dispose) => {
      const [enabled, setEnabled] = createSignal<readonly ModuleId[] | undefined>(["development", "mcp"])
      return { dispose, setEnabled, presence: createModuleHostPresence(modules, host, enabled, (module, error) => { reports.push({ module: module.id, error }) }, { createStack }) }
    })
    try {
      await tick()
      expect(h.presence.stack()).toBeUndefined()
      expect(h.presence.stage()).toBe(Stage)
      expect(h.presence.placement()).toEqual({ project: "workspace", machine: "host" })
      expect(acquired).toBe(1)
      expect(released).toBe(1)
      expect(reports).toEqual([{ module: "development", error: failure }])
      h.setEnabled(["development", "mcp"])
      await tick()
      expect(acquired).toBe(1)
      expect(released).toBe(1)
      expect(reports).toHaveLength(1)
      h.setEnabled(["mcp"])
      await tick()
      expect(released).toBe(1)
      expect(h.presence.stage()).toBe(Stage)
      h.setEnabled(["development", "mcp"])
      await tick()
      expect(h.presence.stack()?.placement()).toEqual({ project: "workspace", machine: "host" })
      expect(acquired).toBe(2)
      expect(released).toBe(1)
      expect(reports).toHaveLength(1)
    } finally { h.dispose() }
    expect(released).toBe(2)
  })

  it("selects defined slots independently and contains a failed factory with its acquired cleanup", async () => {
    const reports: string[] = []
    let released = 0
    const Stage = () => "second stage"
    const modules: readonly WebModule[] = [
      { id: "development", hostPresence: () => ({ stage: () => undefined, placement: () => ({ project: "first", machine: "host" }) }) },
      { id: "experiments", hostPresence: () => { onCleanup(() => { released += 1 }); throw new Error("factory failed") } },
      { id: "mcp", hostPresence: () => ({ stage: () => Stage, placement: () => undefined }) },
    ]
    const h = createRoot((dispose) => ({ dispose, presence: createModuleHostPresence(modules, host, () => undefined, (_module, error) => { reports.push(String(error)) }) }))
    try {
      await tick()
      expect(h.presence.stage()).toBe(Stage)
      expect(h.presence.placement()).toEqual({ project: "first", machine: "host" })
      expect(reports).toEqual(["Error: factory failed"])
      expect(released).toBe(1)
    } finally { h.dispose() }
    expect(released).toBe(1)
  })
})
