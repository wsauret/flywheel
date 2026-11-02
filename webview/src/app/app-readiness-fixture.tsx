import { createComponent, createRoot } from "solid-js"
import type { RuntimeHealth } from "../../../src/protocol/app-service-types.js"
import type { LocalChatSubmission } from "../../../src/protocol/client/chat-submissions.js"
import type { ProviderSetup } from "../../../src/protocol/client/provider-setup.js"
import type { SessionMemory } from "../client/session-residents.js"
import { fakeLanes } from "../../../tests/helpers/fake-lanes.js"
import { fakeRuntimeConnection } from "../client/runtime-connection-fixture.js"
import { fakeClientHost, fakePanelSettings, fakeRuntimeSession, fakeViewState } from "./client-context-fixture.js"
import type { ClientCommand } from "../../../src/protocol/client/host-contract.js"
import { createClientActions } from "../client/actions.js"
import type { RemoteHostSnapshot, RemoteHostCapability } from "../host.js"
import type { WebModule } from "../web-module.js"
import { App, type AppProps } from "./app.js"
import { WEB_MODULES } from "../modules.js"
import type { ModuleId } from "../../../src/protocol/module-ids.js"
import { createElement, insert, MemoryElement, nodes, textContent } from "./render-ownership-host-fixture.js"

/** A held project and a host that can publish real placement and auth changes. */
/** What the held project publishes; `health` and `publish` change it. */
interface HeldProject {
  health: RuntimeHealth
  providerSetup: ProviderSetup
  projectRoot: string | undefined
  localSubmissions: readonly LocalChatSubmission[]
}

export function createAppReadiness(options: { readonly phone?: boolean; readonly cold?: boolean; readonly noProvider?: boolean; readonly chat?: boolean; readonly sessionCount?: number; readonly waiting?: readonly string[]; readonly moduleIds?: readonly ModuleId[] } = {}) {
  const changes = new Set<() => void>()
  const sent: string[] = []
  let reconnects = 0
  let appearances = 0
  const remoteChanges = new Set<(snapshot: RemoteHostSnapshot) => void>()
  let command: (command: ClientCommand) => void = () => {}
  const noticeOpeners = new Set<(sessionId: string) => void>()
  const selected = { runtimeId: "machine", placementId: "project" }
  const live = { id: "project", projectLabel: "Project", version: "test", protocolVersion: 2, state: "live" } as const
  let remoteSnapshot: RemoteHostSnapshot = {
    deviceLabel: "Phone", selected, pairing: { status: "idle" },
    install: { browser: "Safari", steps: [{ glyph: "share", label: "Share" }, { glyph: "add-home", label: "Add to Home Screen" }], canPrompt: false },
    runtimes: [{ runtimeId: "machine", label: "Machine", relay: "wss://example.invalid", placements: [live], presence: "online" }],
  }
  const remote: RemoteHostCapability = {
    deviceId: "phone",
    snapshot: () => remoteSnapshot,
    onChange: listener => { remoteChanges.add(listener); return () => { remoteChanges.delete(listener) } },
    select() {}, forget: async () => {}, pair: async () => {}, setLabel: async () => {}, createProject: async (runtimeId) => ({ runtimeId, placementId: "created" }),
  }
  const memories = new Map<string, SessionMemory>()
  const held: HeldProject = {
    health: { kind: "healthy" },
    providerSetup: options.noProvider ? "none" : "usable",
    projectRoot: options.cold ? undefined : "/workspace",
    localSubmissions: (options.waiting ?? []).map((text, index) => ({ id: `waiting-${index}`, input: { text }, timestamp: index, delivery: { kind: "waiting" } })),
  }
  const idle = fakeViewState()
  const session = fakeRuntimeSession({
    sessionId: options.chat ? "chat" : undefined, rootSessionId: options.chat ? "chat" : undefined,
    get projectRoot() { return held.projectRoot },
    get providerSetup() { return held.providerSetup },
    get health() { return held.health },
    get localSubmissions() { return held.localSubmissions },
    sessions: Array.from({ length: options.sessionCount ?? 1 }, (_, index) => ({
      id: index === 0 ? "chat" : `chat-${index}`, kind: "chat", title: index === 0 ? "Chat" : `Chat ${index}`, shortTitle: index === 0 ? "Chat" : `Chat ${index}`,
      lifecycleState: "active", activity: "idle", inputMode: { kind: "chat" }, createdAt: "2026-10-19T00:00:00.000Z", lastUpdated: "2026-10-19T00:00:00.000Z",
      notices: [], executionCwd: "/workspace",
      totalsLoading: false, totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalTokens: 0, contextPercent: 0, contextPromptTokens: 0, durationMs: 0,
    })),
    desktopNotifier: {
      permission: () => "unsupported", request: async () => "unsupported", show: () => {}, onChange: () => () => {},
      onOpen: (listener) => { noticeOpeners.add(listener); return () => { noticeOpeners.delete(listener) } },
    },
    modules: options.phone ? { ...idle.modules, remote: { relayUrl: "wss://example.invalid", connection: "connected", devices: [], attachedClients: 1, pairing: null, lastError: null, pushPublicKey: "key", projects: [] } } : idle.modules,
    send: async (text) => { sent.push(text) },
    settings: fakePanelSettings({
      moduleIds: options.moduleIds ?? (options.phone ? WEB_MODULES.filter((module: WebModule) => module.hostPresence).map(module => module.id) : []),
      compactionThreshold: 270_000,
    }),
    memory: (id) => { const memory = memories.get(id) ?? {}; memories.set(id, memory); return memory },
    onChange: (listener) => { changes.add(listener); return () => { changes.delete(listener) } },
  })
  // The page's lane never opens, so its surfaces read only what the session holds.
  const connection = fakeRuntimeConnection({}, { ...fakeLanes({ open: false }).client, reconnect: () => { reconnects++ }, appeared: () => { appearances++ } })
  const actions = createClientActions({ session, connection, capabilities: {}, report() {}, captureSurfaceOpener: () => () => {} })
  const props: AppProps = {
    session, connection, actions, readingPlace: { restored: undefined, track: () => () => {} },
    host: fakeClientHost({ capabilities: options.phone ? { remote, push: { state: () => "default", current: async () => undefined, subscribe: async () => undefined, unsubscribe: async () => {} } } : {} }),
    onCommand: listener => { command = listener; return () => {} },
    onReport: () => () => {}, onCaptureSurfaceOpener: () => () => {},
  }
  return {
    props,
    sent: () => sent,
    reconnects: () => reconnects,
    /** How many times the page told its connection that the runtime appeared. */
    appearances: () => appearances,
    command: (value: ClientCommand) => command(value),
    /** A click on the desktop notice of a question that `sessionId` asks. */
    openNotice: (sessionId: string) => { for (const open of noticeOpeners) open(sessionId) },
    health(health: RuntimeHealth) {
      held.health = health
      held.localSubmissions = []
      for (const listener of changes) listener()
    },
    publish(providerSetup: "none" | "usable", projectRoot = held.projectRoot) {
      held.providerSetup = providerSetup
      held.projectRoot = projectRoot
      held.localSubmissions = []
      for (const listener of changes) listener()
    },
    presence(state: "live" | "offline" | "dormant") {
      remoteSnapshot = { ...remoteSnapshot, runtimes: remoteSnapshot.runtimes.map(machine => ({
        ...machine, presence: state === "offline" ? "offline" : "online",
        placements: state === "offline" ? [] : [{ ...live, state: state === "dormant" ? "dormant" : "live" }],
      })) }
      for (const listener of remoteChanges) listener(remoteSnapshot)
    },
    dispose: () => actions.dispose(),
  }
}

/** Runs the real App and its navigation surfaces without a layout engine. */
export function mountAppReadiness(options: Parameters<typeof createAppReadiness>[0] & { readonly chat?: boolean; readonly historyState?: unknown } = {}) {
  const app = createAppReadiness(options)
  const resizes = new Set<() => void>()
  const root = createElement("root")
  const view = root.ownerDocument.defaultView
  const previousMatchMedia = Object.getOwnPropertyDescriptor(view, "matchMedia")
  Object.defineProperty(view, "matchMedia", { configurable: true, value: () => ({ matches: false }) })
  // A browser history that Back walks and that tells its popstate listeners.
  const entries: unknown[] = [options.historyState ?? (options.chat ? { flywheelScreen: "chat" } : undefined)]
  let entryIndex = 0
  const popListeners = new Set<(event: { readonly state: unknown }) => void>()
  const shims = {
    HTMLElement: MemoryElement,
    document: root.ownerDocument,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    history: {
      get state() { return entries[entryIndex] },
      replaceState(state: unknown) { entries[entryIndex] = state },
      pushState(state: unknown) { entries.splice(++entryIndex, entries.length, state) },
      back() {
        if (entryIndex === 0) return
        entryIndex -= 1
        for (const listener of popListeners) listener({ state: entries[entryIndex] })
      },
      forward() {},
    },
    window: {
      addEventListener(type: string, listener: (event: { readonly state: unknown }) => void) { if (type === "popstate") popListeners.add(listener) },
      removeEventListener(type: string, listener: (event: { readonly state: unknown }) => void) { if (type === "popstate") popListeners.delete(listener) },
      matchMedia: () => ({ matches: false }),
    },
    ResizeObserver: class {
      constructor(callback: () => void) { resizes.add(callback) }
      observe() {}
      disconnect() {}
    },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ lineHeight: "20" }),
  }
  const originals = Object.keys(shims).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const)
  for (const [name, value] of Object.entries(shims)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value })
  return createRoot(dispose => {
    insert(root, createComponent(App, app.props))
    return {
      ...app,
      elements: () => nodes(root),
      textOf: textContent,
      text: () => textContent(root),
      layout() {
        const client = nodes(root).find(node => node.properties.class === "client")
        if (client) client.clientWidth = options.phone ? 390 : 1600
        for (const node of nodes(root)) Object.assign(node, { getBoundingClientRect: () => ({ top: 0, bottom: 600, height: 600, width: node.properties.class === "workspace-fit" ? 600 : 1000 }) })
        for (const resize of resizes) resize()
      },
      dispose() {
        dispose()
        app.dispose()
        if (previousMatchMedia) Object.defineProperty(view, "matchMedia", previousMatchMedia)
        else Reflect.deleteProperty(view, "matchMedia")
        for (const [name, descriptor] of originals) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor)
          else Reflect.deleteProperty(globalThis, name)
        }
      },
    }
  })
}
