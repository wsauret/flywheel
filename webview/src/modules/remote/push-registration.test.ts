import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { fakeClient, fakeClientHost, fakePanelSettings, fakeViewState } from "../../app/client-context-fixture.js"
import { fakeRuntimeConnection } from "../../client/runtime-connection-fixture.js"
import type { SessionSummary } from "../../client/view-state.js"
import type { HostCapabilities, RemoteHostSnapshot } from "../../host.js"
import type { FrontendEvent } from "../../../../src/protocol/app-service-types.js"
import { EMPTY_REMOTE_VIEW } from "../../../../src/protocol/modules/remote.js"
import { createPushRegistration } from "./push-registration.js"
import { mountPerPlacement } from "../../../phone/placement-client.js"

const settle = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const subscription = { endpoint: "https://push.test/one", expirationTime: null, keys: { p256dh: "key", auth: "auth" }, applicationServerKey: "ours" }
const waitingSessions = (ids: readonly string[]): SessionSummary[] => ids.map((id) => ({ id, awaitingAnswer: true, title: id, kind: "chat", lifecycleState: "active", active: true, working: false, lastUpdated: "", totalsLoading: false }))
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
let clock: ReturnType<typeof spyOn<typeof Date, "now">>
beforeEach(() => {
  clock = spyOn(Date, "now").mockReturnValue(1000)
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value), removeItem: (key: string) => values.delete(key) } })
})
afterEach(() => {
  clock.mockRestore()
  if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor)
  else Reflect.deleteProperty(globalThis, "localStorage")
})

function mount(initialPermission: NotificationPermission | "unavailable", input: { install?: boolean; other?: boolean; unknownOwner?: boolean; recorded?: boolean; fail?: boolean; missing?: boolean; forward?: "throw" | "reject"; selectionKnown?: boolean; cold?: boolean; unselected?: boolean; waiting?: string[]; openedAt?: number; placementId?: string } = {}) {
  let permission = initialPermission
  let current = input.missing ? undefined : { ...subscription, ...(input.other ? { applicationServerKey: "theirs", ...(input.unknownOwner ? {} : { runtimeId: "other" }) } : {}) }
  let changed = () => {}
  let event = (_event: FrontendEvent) => {}
  let dispatches = 0
  let prompts = 0
  const diagnostics: unknown[] = []
  const h = createRoot((dispose) => {
    let snapshot: RemoteHostSnapshot = { deviceLabel: "Phone", runtimes: [{ runtimeId: "other", label: "Studio", relay: "relay", placements: [], presence: "online" }, { runtimeId: "ours", label: "Laptop", relay: "relay", placements: [], presence: "online" }], selected: input.unselected ? undefined : { runtimeId: "ours", placementId: input.placementId ?? "project" }, pairing: { status: "idle" }, ...(input.install ? { install: { browser: "Safari", steps: [], canPrompt: false } } : {}) }
    const listeners = new Set<(snapshot: RemoteHostSnapshot) => void>()
    const capabilities: HostCapabilities = {
      remote: { deviceId: "phone", snapshot: () => snapshot, onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, pair: async () => {}, setLabel: async () => {}, select: () => {}, forget: async () => {}, createProject: async (runtimeId) => ({ runtimeId, placementId: "created" }) },
      push: {
        state: () => permission, current: async () => current,
        subscribe: async () => { prompts++; if (input.fail) throw new DOMException("raw browser detail", "AbortError"); return subscription },
        unsubscribe: async () => {}, onChange: (listener) => { changed = listener; return () => { changed = () => {} } },
      },
    }
    const idle = fakeViewState()
    const [state, setState] = createSignal(fakeViewState({ projectRoot: input.cold ? undefined : "/workspace", newestQuestionOpenedAt: input.openedAt, settings: input.selectionKnown === false ? undefined : fakePanelSettings({ moduleIds: ["remote"] }), sessions: waitingSessions(input.waiting ?? []), modules: { ...idle.modules, remote: input.cold ? null : { ...EMPTY_REMOTE_VIEW, pushPublicKey: "ours", devices: [{ id: "phone", label: "Phone", pairedAt: 0, attached: true, notifies: input.recorded ?? false }] } } }))
    const client = fakeClient({
      state,
      host: fakeClientHost({ capabilities, onDiagnostic: (_name, detail) => { diagnostics.push(detail) } }),
      connection: fakeRuntimeConnection({
        onDispatch: () => { dispatches++ },
        mutations: { "remote.push.subscribe": () => {
          if (input.forward === "throw") throw new Error("transport detail")
          return input.forward === "reject" ? { kind: "rejected", message: "This phone is no longer paired. Pair it again." } : { kind: "committed" }
        } },
      }, { subscribe: (listener) => { event = listener; return () => {} } }),
    })
    return {
      ...createPushRegistration(client), dispose, setState,
      catalog: () => setState((previous) => ({ ...previous, projectRoot: "/workspace", settings: fakePanelSettings({ ...previous.settings, moduleIds: ["remote"] }) })),
      remote: () => setState((previous) => ({ ...previous, modules: { ...previous.modules, remote: { ...EMPTY_REMOTE_VIEW, pushPublicKey: "ours" } } })),
      choose: (placementId = "project") => { snapshot = { ...snapshot, selected: { runtimeId: "ours", placementId } }; for (const listener of listeners) listener(snapshot) },
      waiting: (ids: string[], openedAt?: number) => setState((previous) => ({ ...previous, newestQuestionOpenedAt: openedAt, sessions: waitingSessions(ids) })),
    }
  })
  return {
    ...h, dispatches: () => dispatches, prompts: () => prompts, diagnostics,
    renewed: () => { current = { ...subscription, endpoint: "https://push.test/renewed" }; changed() },
    deny: () => { permission = "denied"; changed() },
    question: (timestamp = 1100, paint = true) => {
      event({ type: "patch", patch: { cursor: { scope: "session", domain: "question", sessionId: "chat" }, position: 1, prevPosition: 0, payload: { kind: "question.updated", question: { kind: "question", toolUseId: "q", questions: [], timestamp } } } })
      if (paint) h.waiting(["chat"], timestamp)
    },
    answered: () => event({ type: "patch", patch: { cursor: { scope: "session", domain: "question", sessionId: "chat" }, position: 2, prevPosition: 1, payload: { kind: "question.removed" } } }),
  }
}

test("the card offers install, permission, blocked settings, or a named move without a background prompt", async () => {
  for (const [permission, input, expected] of [
    ["default", { install: true }, { kind: "install" }],
    ["default", {}, { kind: "permission" }],
    ["denied", {}, { kind: "denied" }],
    ["unavailable", {}, { kind: "unavailable" }],
    ["granted", { other: true }, { kind: "move", machine: "Studio" }],
    ["granted", { other: true, unknownOwner: true }, { kind: "move", machine: undefined }],
  ] as const) {
    const h = mount(permission, input)
    try {
      await settle()
      expect(h.state()).toEqual(expected)
      expect(h.prompts()).toBe(0)
      h.dismiss()
      expect(h.dismissed()).toBe(true)
      h.question()
      expect(h.dismissed()).toBe(false)
    } finally { h.dispose() }
  }
})

test("a failed forward stays off when a question refreshes recorded subscription state", async () => {
  for (const forward of ["throw", "reject"] as const) {
    const h = mount("granted", { recorded: true, forward })
    try {
      await settle()
      expect(h.state()).toEqual({ kind: "failed", ...(forward === "reject" ? { message: "This phone is no longer paired. Pair it again." } : {}) })
      h.question()
      await settle()
      expect(h.dispatches()).toBe(2)
      expect(h.state().kind).toBe("failed")
    } finally { h.dispose() }
  }
})

test("allowed notifications repair missing runtime and browser subscriptions and forward renewal", async () => {
  for (const input of [{ missing: false }, { missing: true }, { recorded: true }, { selectionKnown: false }]) {
    const h = mount("granted", input)
    try {
      await settle()
      expect(h.dispatches()).toBe(1)
      expect(h.state()).toEqual({ kind: "on" })
      h.renewed()
      await settle()
      expect(h.dispatches()).toBe(2)
      h.dispose()
      h.renewed()
      await settle()
      expect(h.dispatches()).toBe(2)
    } finally { h.dispose() }
  }
})

test("a failed registration records only error name and permission, not browser text", async () => {
  const h = mount("default", { fail: true })
  try {
    await settle()
    await h.enable()
    expect(h.state()).toEqual({ kind: "failed" })
    expect(h.diagnostics).toEqual([{ errorName: "AbortError", permission: "default" }])
  } finally { h.dispose() }
})

test("the move button stays live through either first-snapshot order and the first project choice", async () => {
  for (const first of ["remote", "catalog", "selection"] as const) {
    const h = mount("granted", { other: true, cold: first !== "selection", unselected: first === "selection" })
    try {
      await settle()
      if (first === "selection") h.choose()
      else {
        h[first]()
        await settle()
        h[first === "remote" ? "catalog" : "remote"]()
      }
      await settle()
      expect(h.state().kind).toBe("move")
      await h.enable()
      expect(h.prompts()).toBe(1)
      expect(h.dispatches()).toBe(1)
      expect(h.state().kind).toBe("on")
    } finally { h.dispose() }
  }
})

test("Later survives remounts and a selection published before the placement remount", async () => {
  const key = (placementId: string) => `flywheel.push-guide.dismissed:${JSON.stringify(["ours", placementId])}`
  const first = mount("denied", { waiting: ["chat"], openedAt: 900 })
  await settle()
  clock.mockReturnValue(2000)
  first.dismiss()
  first.dispose()
  const other = mount("denied", { placementId: "other", waiting: ["other-chat"], openedAt: 900 })
  await settle()
  expect(other.dismissed()).toBe(false)
  clock.mockReturnValue(1000)
  other.dismiss()
  other.dispose()
  clock.mockReturnValue(2000)
  let selected = "project"
  let selectionChanged = (_changed: boolean) => {}
  const mounts: ReturnType<typeof mount>[] = []
  const placement = mountPerPlacement({
    capability: { select: () => {} },
    onSelectionChange(listener) { selectionChanged = listener; return () => {} },
  }, () => {
    const guide = mount("denied", { placementId: selected, waiting: selected === "project" ? ["chat"] : ["other-chat"], openedAt: selected === "project" ? 1500 : 900 })
    mounts.push(guide)
    return { dispose: guide.dispose, command: () => {} }
  })
  try {
    await settle()
    selected = "other"
    mounts[0]!.choose(selected)
    selectionChanged(true)
    await settle()
    expect(localStorage.getItem(key("other"))).toBe("1000")
    expect(mounts[1]!.dismissed()).toBe(true)
  } finally { placement.handle.dispose() }
  for (const loaded of [false, true]) {
    const next = mount("denied", { cold: !loaded, unselected: !loaded, waiting: loaded ? ["chat"] : [], openedAt: loaded ? 900 : undefined })
    try {
      await settle()
      if (!loaded) { expect(next.dismissed()).toBe(false); next.choose(); await settle() }
      expect(next.dismissed()).toBe(true)
      next.catalog()
      next.remote()
      next.waiting(["chat"], 900)
      await settle()
      expect(next.dismissed()).toBe(true)
      expect(localStorage.getItem(key("project"))).toBe("2000")
      next.answered()
      next.question(2100, false)
      expect(next.dismissed()).toBe(true)
      next.waiting(["chat"], 2100)
      await settle()
      expect(next.dismissed()).toBe(false)
      expect(localStorage.getItem(key("project"))).toBeNull()
      next.dismiss()
    } finally { next.dispose() }
  }
})

test("Later tapped before question presence loads stays dismissed when only older questions arrive", async () => {
  const first = mount("denied", { cold: true })
  try {
    await settle()
    first.dismiss()
    first.catalog()
    first.remote()
    first.question(900, false)
    expect(first.dismissed()).toBe(true)
    first.waiting(["chat"], 900)
    await settle()
    expect(first.dismissed()).toBe(true)
  } finally { first.dispose() }
  const next = mount("denied", { waiting: ["chat"], openedAt: 900 })
  try {
    await settle()
    expect(next.dismissed()).toBe(true)
    next.question()
    await settle()
    expect(next.dismissed()).toBe(false)
  } finally { next.dispose() }
})

test("a question this phone was notified of keeps Later after notifications turn off", async () => {
  localStorage.setItem(`flywheel.push-guide.dismissed:${JSON.stringify(["ours", "project"])}`, "1000")
  const h = mount("granted", { recorded: true })
  try {
    await settle()
    expect(h.state().kind).toBe("on")
    h.question(2100)
    await settle()
    expect(h.dismissed()).toBe(true)
    h.deny()
    await settle()
    expect(h.state().kind).toBe("denied")
    expect(h.dismissed()).toBe(true)
    h.question(3100)
    await settle()
    expect(h.dismissed()).toBe(false)
  } finally { h.dispose() }
})

test("an unreadable or unshipped array dismissal does not hide the card", async () => {
  for (const value of ["not-json", '["chat"]', "null", '"1000"']) {
    localStorage.setItem(`flywheel.push-guide.dismissed:${JSON.stringify(["ours", "project"])}`, value)
    const h = mount("denied")
    try {
      await settle()
      expect(h.dismissed()).toBe(false)
    } finally { h.dispose() }
  }
})
