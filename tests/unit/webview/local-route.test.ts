import { describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"

import { createAddressFollower, pathForSession, sessionFromPath } from "../../../webview/local/route.js"
import { createWorkflowAgentAdoption, createWorkflowNavigation, type HistoryPort } from "../../../webview/src/modules/workflows/navigation.js"
import type { WorkflowReading } from "../../../webview/src/modules/workflows/inspection.js"
import type { FrontendAttempt } from "../../../src/protocol/workflow-view-protocol-types.js"
import { plainAgentTree } from "../../helpers/workflow-view.js"
import { importBuiltModule } from "../../../webview/src/test-support/import-built-module.js"
import { fileURLToPath } from "node:url"
import { headlessClient } from "../../../webview/src/client/session-host-loader-fixture.js"
import { selectionConnection } from "../../../webview/src/client/session-selection-fixture.js"
import { settle } from "../../../webview/src/client/session-connection-fixture.js"
import type { ComposerCheckpoint } from "../../../webview/src/client/input-reload-checkpoint.js"

// The fixture compiles under the web client's JSX project, not the root test project.
const composerFixture = new URL("../../../webview/src/app/composer-submission-loader-fixture.ts", import.meta.url).href
const { mountComposerSubmission }: { mountComposerSubmission(): {
  openChat(id: string): void; leaveSession(): void; type(text: string): void
  capture(): ComposerCheckpoint; adopt(checkpoint: ComposerCheckpoint): void
  text(): string; readonly sent: readonly unknown[]; dispose(): void
} } = await import(composerFixture)

// The boundary must replace the page entry on every platform. When the
// filter misses, the entry reads the real global document at load and the
// file fails with a ReferenceError that does not name the cause.
let entryReplaced = false
const bootstrap = await Bun.build({
  entrypoints: [fileURLToPath(new URL("../../../webview/local/main.tsx", import.meta.url))],
  target: "bun",
  conditions: ["browser"],
  plugins: [{
    name: "local-host-boundary",
    setup(builder) {
      builder.onLoad({ filter: /webview[\\/]local[\\/]main\.tsx$/ }, async ({ path }) => {
        entryReplaced = true
        return {
          contents: `import { document, window, location, history } from "local-test-host";\n${await Bun.file(path).text()}\nexport { host } from "local-test-host";\nexport function remount() { mountLocalClient(document.querySelector("#root"), "token") }`,
          loader: "tsx",
        }
      })
      builder.onResolve({ filter: /^local-test-host$/ }, () => ({ path: "host", namespace: "local-test" }))
      builder.onLoad({ filter: /.*/, namespace: "local-test" }, () => ({
        contents: `
          export let host;
          export const location = { pathname: "/session/old", host: "localhost" };
          export const history = {
            state: null,
            replaceState(state, unused, path) { this.state = state; location.pathname = path },
            pushState(state, unused, path) { this.replaceState(state, unused, path) }
          };
          export const document = { querySelector: () => ({ dataset: {} }) };
          export const window = { addEventListener() {} };
          export function mountClient(root, options) { host = options; return { dispose() {}, command() {} } }
          export function consumeLocalBrowserToken() { return "token" }
          export function localSocketUrl() { return "ws://localhost" }
          export function reloadOnFreshLink() {}
          export function tokenAdmitted() {}
          export function applyTabIdentity() {}
          export function releaseWhileCached() {}
          export function showGate() {}
        `, loader: "js",
      }))
      builder.onResolve({ filter: /(?:src\/index|\/token|\/tab|\/gate)\.js$/ }, () => ({ path: "host", namespace: "local-test" }))
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
    },
  }],
})
if (!bootstrap.success) throw new Error(bootstrap.logs.map(String).join("\n"))
if (!entryReplaced) throw new Error("local-host-boundary did not replace webview/local/main.tsx")
const bootstrapArtifact = bootstrap.outputs[0]
if (!bootstrapArtifact) throw new Error("Local host fixture produced no entrypoint")
const localHost: { host: import("../../../webview/src/host.js").ClientHost; remount(): void } = await importBuiltModule(bootstrapArtifact)

describe("local browser session address", () => {
  test("New Chat clears the previous session address and remains selected on replacement", async () => {
    const original = mountComposerSubmission()
    original.openChat("old")
    const summary = {
      ready: true, sessionId: "old", health: { kind: "healthy" }, rootSessionId: "old",
      sessionTitle: "Chat", executionCwd: "/project", activity: undefined, busy: false,
      budget: undefined, hasUsableProvider: true, providers: [], changes: undefined,
    } as const
    localHost.host.onSummary?.(summary)
    original.leaveSession()
    localHost.host.onSummary?.({ ...summary, sessionId: undefined })
    original.type("new chat words")
    const saved = { version: 1, scope: "headless", composer: original.capture() } as const
    original.dispose()
    localHost.remount()
    expect(localHost.host.initialSessionId).toBeUndefined()
    const previous = Object.getOwnPropertyDescriptor(globalThis, "document")
    Object.defineProperty(globalThis, "document", { configurable: true, value: { addEventListener() {}, removeEventListener() {} } })
    const connection = selectionConnection()
    headlessClient.setConnection(connection)
    const successor = headlessClient.mountForTest({
      ...localHost.host,
      inputStorage: { load: async () => saved, save: async () => {}, consume: async () => {} },
    })
    try {
      await settle()
      connection.publishCatalog()
      await settle()
      expect(headlessClient.session.sessionId).toBeUndefined()
      expect(connection.detailReads).toEqual([])
      const composer = mountComposerSubmission()
      try {
        composer.leaveSession()
        composer.adopt(saved.composer)
        expect(composer.text()).toBe("new chat words")
        expect(composer.sent).toEqual([])
      } finally { composer.dispose() }
    } finally {
      successor.dispose()
      if (previous) Object.defineProperty(globalThis, "document", previous)
      else Reflect.deleteProperty(globalThis, "document")
    }
  })
  test("names a session under /session and nothing else", () => {
    expect(sessionFromPath("/session/abc-123")).toBe("abc-123")
    expect(sessionFromPath("/session/a%2Fb")).toBe("a/b")
    expect(sessionFromPath("/")).toBeUndefined()
    expect(sessionFromPath("/session/")).toBeUndefined()
    expect(sessionFromPath("/session/abc/more")).toBeUndefined()
    expect(sessionFromPath("/sessions/abc")).toBeUndefined()
    expect(sessionFromPath("/session/%E0%A4%A")).toBeUndefined()
  })

  test("round-trips a session id through its address", () => {
    expect(pathForSession(undefined)).toBe("/")
    expect(pathForSession("abc-123")).toBe("/session/abc-123")
    expect(sessionFromPath(pathForSession("a/b c"))).toBe("a/b c")
  })
})

/** One browser tab: its entries with their addresses, and the page that the
 *  local host and the client's workflow navigation share. */
function memoryTab(initialPath: string, state: unknown = null) {
  const entries: { state: unknown; path: string }[] = [{ state, path: initialPath }]
  let index = 0
  const listeners = new Set<(event: { readonly state: unknown }) => void>()
  const at = () => entries[index]!
  const history = {
    get state() { return at().state },
    pushState(next: unknown, _unused: string, url?: string | URL | null) { const path = typeof url === "string" ? url : at().path; entries.splice(++index, entries.length, { state: next, path }) },
    replaceState(next: unknown, _unused: string, url?: string | URL | null) { entries[index] = { state: next, path: typeof url === "string" ? url : at().path } },
  }
  const port: HistoryPort = {
    get state() { return at().state },
    pushState: (next) => history.pushState(next, ""),
    replaceState: (next) => history.replaceState(next, ""),
    back() { if (index > 0) { index -= 1; for (const listener of listeners) listener({ state: at().state }) } },
    addPopStateListener: (listener) => listeners.add(listener),
    removePopStateListener: (listener) => listeners.delete(listener),
  }
  return { history, port, location: { get pathname() { return at().path } }, listeners, entries: () => entries.length,
    forward() { if (index + 1 < entries.length) { index += 1; for (const listener of listeners) listener({ state: at().state }) } },
  }
}

const attempts: readonly FrontendAttempt[] = [{ id: "agent", definitionId: "agent", briefId: "agent", name: "Agent", status: "running", sessionId: "member", history: [] }]

/** The local host and the client as `webview/local/main.tsx` composes them:
 *  the address follows each selection, and a pop selects what its entry shows. */
function mountPage(tab: ReturnType<typeof memoryTab>, initial: string) {
  return createRoot((dispose) => {
    const address = createAddressFollower(tab)
    const [selected, setSelected] = createSignal(initial)
    const select = (id: string) => { setSelected(id); address.follow(id) }
    tab.listeners.add(() => { const id = address.popped(); if (id !== undefined) select(id) })
    const agents = createWorkflowNavigation({
      reading: () => ({ detail: undefined, view: { attemptsStatus: "loaded", state: "running", attempts, tree: plainAgentTree(attempts) }, live: [] }),
      selected, select,
    }, tab.port)
    address.follow(initial)
    return { dispose, agents, selected }
  })
}

describe("Back from a workflow agent view on the local browser page", () => {
  test("preserves Back and Forward with the adoption effect and no host pop listener", () => {
    const tab = memoryTab("/")
    const page = createRoot(dispose => {
      const [selected, select] = createSignal("member")
      const usage = { totalCost: 0, totalBilledCost: 0, priceUnavailable: false, totalInputTokens: 0, totalOutputTokens: 0 }
      const reading = (): WorkflowReading => ({
        detail: {
          workflowId: "run", title: "Run", workflowDefinitionId: "fixture", createdAt: "", lastUpdated: "",
          executionCwd: "", roleAssignments: { defaults: {}, overrides: {} }, launchedFrom: { parentSessionId: "chat", conversationId: "conversation", toolUseId: "tool" },
          auth: null, readability: "readable", admittedActions: [], totals: usage, policyUsage: usage,
          attribution: "available", durationMs: 0, streamingStartedAt: null, activeIntervals: [], totalsLoading: false,
        },
        view: { attemptsStatus: "loaded", state: "running", attempts, tree: plainAgentTree(attempts) }, live: [],
      })
      const agents = createWorkflowNavigation({ reading, selected, select }, tab.port)
      createWorkflowAgentAdoption(agents, () => selected() === "chat" ? undefined : ({
        id: selected(), workflowMembership: { kind: "attempt", workflowId: "run", attemptId: "agent" },
      }), reading)
      return { dispose, agents, selected }
    })
    try {
      expect(page.agents.place()?.kind).toBe("agent")
      expect(tab.entries()).toBe(2)
      page.agents.back()
      expect(page.selected()).toBe("chat")
      expect(page.agents.place()).toBeUndefined()
      expect(tab.entries()).toBe(2)
      tab.forward()
      expect(page.selected()).toBe("member")
      expect(page.agents.place()?.kind).toBe("agent")
      page.agents.back()
      page.agents.openAgent("run", "chat", { kind: "agent", agentNodeId: "agent", follow: false, historySessionId: "another" }, "chat")
      expect(page.selected()).toBe("another")
      page.agents.back()
      expect(page.selected()).toBe("chat")
      expect(page.agents.place()).toBeUndefined()
    } finally { page.dispose() }
    expect(tab.listeners.size).toBe(0)
  })
  test("returns to the chat whose inline card opened the agent, also after a reload", () => {
    const tab = memoryTab("/session/chat")
    const page = mountPage(tab, "chat")
    page.agents.openAgent("run", "chat", { kind: "agent", agentNodeId: "agent", follow: true }, "chat")
    expect(page.selected()).toBe("member")
    expect(tab.location.pathname).toBe("/session/member")
    expect(tab.entries()).toBe(2)
    page.dispose()

    const reloaded = mountPage(tab, "member")
    try {
      expect(reloaded.agents.place()?.kind).toBe("agent")
      expect(reloaded.agents.back()).toBe(true)
      expect(reloaded.selected()).toBe("chat")
      expect(reloaded.agents.place()).toBeUndefined()
      expect(tab.location.pathname).toBe("/session/chat")
    } finally {
      reloaded.dispose()
    }
  })

  test("returns to the launching chat from an agent opened directly by its address", () => {
    const tab = memoryTab("/session/member")
    const page = mountPage(tab, "member")
    try {
      page.agents.adoptAgent("run", "chat", { kind: "agent", agentNodeId: "agent", follow: false, historySessionId: "member" })
      expect(tab.location.pathname).toBe("/session/member")
      expect(page.agents.back()).toBe(true)
      expect(page.selected()).toBe("chat")
      expect(tab.location.pathname).toBe("/session/chat")
    } finally {
      page.dispose()
    }
  })
})
