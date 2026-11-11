import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { test } from "node:test"
import { importBuiltModule } from "../../test-support/import-built-module.js"
import { loadSolidFixture } from "../../test-support/solid-transform.js"
import { loadSemanticRowsFixture } from "../../app/semantic-rows-loader-fixture.js"
import type { RemoteHostSnapshot } from "../../host.js"
import type { RuntimeRemoteView } from "../../../../src/protocol/modules/remote.js"
import { actionOwner } from "../../app/action-owner-fixture.js"
import { fakePanelSettings } from "../../app/client-context-fixture.js"
import { createRemoteMutation } from "./mutation.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("sheet-fixture.ts", import.meta.url))],
  target: "bun",
  format: "esm",
  plugins: [{
    name: "solid-ssr",
    setup(builder) {
      builder.onLoad({ filter: /\.css$/ }, () => ({ contents: "", loader: "js" }))
      builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("ssr"))
    },
  }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find((output) => output.kind === "entry-point")
if (javascript === undefined) throw new Error("SSR build produced no JavaScript entry point")
const { renderMachinesSheet, renderRemoteSheet }: typeof import("./sheet-fixture.js") = await importBuiltModule(javascript)

const { mountSemanticRows } = await loadSemanticRowsFixture<typeof import("./semantic-rows-fixture.js")>(new URL("semantic-rows-fixture.tsx", import.meta.url))

test("remote rows keep their nodes and a rename draft through current view updates", async () => {
  const remote: RuntimeRemoteView = { relayUrl: "", connection: "connected", attachedClients: 1, pairing: null, lastError: null, pushPublicKey: null,
    devices: [{ id: "phone", label: "Phone", pairedAt: 0, notifies: true, attached: true }],
    projects: [{ placementId: "project", projectRoot: "/repo", displayPath: "/repo", projectLabel: "Project", lastAttachedAt: 0, state: "open" }] }
  const initial = { modules: { remote }, settings: fakePanelSettings({ moduleIds: ["remote"] }) }
  const mounted = mountSemanticRows("remote", initial, { connection: { mutations: { "remote.device.rename": () => ({ kind: "committed" }) } } })
  try {
    const rename = mounted.elements().find(node => String(node.properties["aria-label"]).startsWith("Device name:"))
    const device = rename?.parent
    const project = mounted.button("Forget")?.parent
    assert.ok(rename && device && project)
    assert.equal(mounted.text().match(/Phone/g)?.length, 1)
    const click = rename.properties.onClick
    if (typeof click === "function") click()
    assert.deepEqual(mounted.prompts(), [])
    const input = mounted.elements().find(node => node.properties["aria-label"] === "Device name")
    assert.ok(input)
    input.focus()
    const type = input.properties.onInput
    assert.equal(typeof type, "function")
    if (typeof type === "function") type({ currentTarget: { value: "Unsent name" } })
    mounted.publish({ ...initial, modules: { remote: { ...remote, devices: remote.devices.map(row => ({ ...row, label: "Current phone", attached: false })), projects: remote.projects.map(row => ({ ...row, state: "asleep" })) } } })
    assert.ok(mounted.elements().includes(device))
    assert.ok(mounted.elements().includes(project))
    assert.equal(mounted.prompts().length, 0)
    assert.ok(mounted.elements().includes(input))
    assert.equal(input.properties.value, "Unsent name")
    assert.equal(input.ownerDocument.activeElement, input)
    assert.match(mounted.text(), /Current phone/)
    assert.match(mounted.text(), /asleep/)
    assert.ok(!mounted.button("Save"))
    const blur = input.properties.onBlur
    assert.equal(typeof blur, "function")
    if (typeof blur === "function") blur()
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()
    assert.deepEqual(mounted.calls(), [{ type: "remote.device.rename", deviceId: "phone", label: "Unsent name" }])
  } finally { mounted.dispose() }
})

test("machine and placement actions retain their nodes while labels and presence change", async () => {
  const snapshot: RemoteHostSnapshot = { deviceLabel: "Phone", selected: undefined, pairing: { status: "idle" }, runtimes: [{ runtimeId: "machine", label: "Machine", relay: "", presence: "online", placements: [{ id: "project", projectLabel: "Project", state: "live", version: "0.0.1", protocolVersion: 1 }] }] }
  const mounted = mountSemanticRows("machines", { modules: {} }, { snapshot })
  try {
    const project = mounted.button("Project")
    const machine = mounted.elements().find(node => node.properties.class === "runtime")
    assert.ok(project && machine)
    project.focus()
    mounted.publishSnapshot(structuredClone(snapshot))
    assert.equal(mounted.button("Project"), project)
    mounted.publishSnapshot({ ...snapshot, runtimes: snapshot.runtimes.map(runtime => ({ ...runtime, presence: "watching", label: "Current machine", placements: runtime.placements.map(placement => ({ ...placement, state: "dormant", projectLabel: "Current project" })) })) })
    assert.equal(mounted.button("Current project"), project)
    assert.ok(mounted.elements().includes(machine))
    assert.match(mounted.text(), /Current machine/)
    assert.match(mounted.text(), /checking/)
    assert.match(mounted.text(), /Asleep\. Tap to start\./)
    const click = project.properties.onClick
    if (typeof click === "function") click()
    await Promise.resolve()
    assert.deepEqual(mounted.calls(), [{ runtimeId: "machine", placementId: "project" }])
    const forget = mounted.elements().find(node => node.properties["aria-label"] === "Forget Current machine")?.properties.onClick
    assert.equal(typeof forget, "function")
    if (typeof forget === "function") forget()
    mounted.settleConfirmation(true)
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()
    assert.deepEqual(mounted.calls().at(-1), "machine")
    mounted.publishSnapshot({ ...snapshot, runtimes: [] })
    assert.ok(!mounted.elements().includes(machine))
    assert.ok(!mounted.elements().includes(project))
  } finally { mounted.dispose() }
})

test("the phone name commits once when finished or closed and returns to the saved name after a failed write", async () => {
  const snapshot: RemoteHostSnapshot = { deviceLabel: "Phone", selected: undefined, pairing: { status: "idle" }, runtimes: [] }
  for (const finish of ["Enter", "Escape", "blur", "close"] as const) {
    const pending = Promise.withResolvers<void>()
    const mounted = mountSemanticRows("machines", { modules: {} }, { snapshot, setLabel: () => pending.promise })
    let disposed = false
    try {
      const edit = mounted.elements().find(node => String(node.properties["aria-label"]).startsWith("This phone's name:"))
      assert.ok(edit)
      const open = edit.properties.onClick
      if (typeof open === "function") open()
      for (let turn = 0; turn < 2; turn++) await Promise.resolve()
      const input = mounted.elements().find(node => node.properties["aria-label"] === "This phone's name")
      assert.ok(input)
      const change = input.properties.onInput
      if (typeof change === "function") change({ currentTarget: { value: "New phone" } })
      assert.deepEqual(mounted.calls(), [])
      if (finish === "close") { mounted.dispose(); disposed = true }
      else {
        const handler = input.properties[finish === "blur" ? "onBlur" : "onKeyDown"]
        if (typeof handler === "function") handler({ key: finish, preventDefault() {}, stopPropagation() {} })
        assert.equal(input.ownerDocument.activeElement, input)
        assert.equal(input.properties["aria-disabled"], true)
        assert.equal(input.properties.value, "New phone")
        assert.ok(!mounted.button("Save"))
      }
      assert.deepEqual(mounted.calls(), ["New phone"])
      pending.reject(new Error("Storage unavailable"))
      for (let turn = 0; turn < 12; turn++) await Promise.resolve()
      assert.match(mounted.reports().at(-1)!.message, /Storage unavailable/)
      if (!disposed) assert.match(String(edit.properties["aria-label"]), /Phone/)
    } finally { if (!disposed) mounted.dispose() }
  }
})

const base = {
  relayUrl: "", connection: "off", devices: [], attachedClients: 0, pairing: null,
  lastError: null, pushPublicKey: null, projects: [], processInitiation: "off",
} as const

test("source builds omit process initiation", () => {
  const { processInitiation: _capability, ...source } = base
  assert.doesNotMatch(renderRemoteSheet(source), /Process initiation/)
})

test("installed status failure offers Repair", () => {
  const html = renderRemoteSheet({ ...base, processInitiation: "unavailable" })
  assert.match(html, /Process initiation/)
  assert.match(html, />Repair</)
})

test("installed status states show explicit actions", () => {
  assert.match(renderRemoteSheet({ ...base, processInitiation: "on" }), />Turn off</)
  assert.match(renderRemoteSheet(base), />Turn on</)
})

test("a pairing code tells a phone that has Flywheel installed to scan it from inside the app", () => {
  const html = renderRemoteSheet({ ...base, pairing: { windowId: "w", code: "https://remote.flywl.sh/#p=1.abc", expiresAt: Date.now() + 60_000 } })
  assert.match(html, /If Flywheel is on your phone(&#39;|')s Home Screen, open it, open Machines, and tap Scan a code\./)
})

const LINGER_NOTICE = "Flywheel stops when you log out, because lingering is off for wes. To keep Flywheel running after you log out, run `sudo loginctl enable-linger wes` on this machine."

test("an account whose lingering is off reads the logout notice as a warning under Process initiation, whether or not this host can change it", () => {
  for (const mutable of [true, false]) {
    assert.ok(renderRemoteSheet({ ...base, processInitiation: "on", lingerOffFor: "wes" }, mutable).includes(`<span class="remote-notice warn">${LINGER_NOTICE}</span>`))
    assert.doesNotMatch(renderRemoteSheet({ ...base, processInitiation: "on" }, mutable), /lingering/)
  }
})

test("the phone's Machines sheet reads the logout notice as a warning under the attached machine's Process initiation", () => {
  assert.ok(renderMachinesSheet({ ...base, processInitiation: "on", lingerOffFor: "wes" }).includes(`<p class="runtime-note warn">${LINGER_NOTICE}</p>`))
  assert.doesNotMatch(renderMachinesSheet({ ...base, processInitiation: "on" }), /lingering/)
})

test("read-only unavailable status gives command and report-bug guidance", () => {
  const html = renderRemoteSheet({ ...base, processInitiation: "unavailable" }, false)
  assert.doesNotMatch(html, />Repair</)
  assert.match(html, /flywheel serve install/)
  assert.match(html, /report a bug/)
  assert.match(html, /tone-warn/)
})

test("repair dispatches once while it works, shows working on its own control only, and preserves rejected guidance", async () => {
  const deferred = Promise.withResolvers<{ readonly kind: "rejected"; readonly message: string }>()
  const dispatched: unknown[] = []
  const reports: string[] = []
  const operation = createRemoteMutation({
    dispatch: async (mutation) => { dispatched.push(mutation); return mutation.type === "remote.process_initiation.set" ? deferred.promise : { kind: "committed" } },
    report: (_severity, message) => reports.push(message),
    actions: actionOwner(),
  }, () => true, () => true)
  const first = operation.mutate({ type: "remote.process_initiation.set", enabled: true }, true)
  void operation.mutate({ type: "remote.process_initiation.set", enabled: true }, true)
  assert.equal(operation.working("remote.process_initiation.set"), true)
  assert.equal(dispatched.length, 1)
  // Another device's control is its own action: it runs at once, and the
  // repair's control is the only one that reads working for the repair.
  await operation.mutate({ type: "remote.device.revoke", deviceId: "phone" })
  assert.equal(dispatched.length, 2)
  assert.equal(operation.working("remote.device.revoke", "phone"), false)
  assert.equal(operation.working("remote.device.revoke", "tablet"), false)
  deferred.resolve({ kind: "rejected", message: "launch agent was denied" })
  await first
  assert.equal(operation.working("remote.process_initiation.set"), false)
  assert.deepEqual(reports, ["launch agent was denied. Run `flywheel serve install` on this machine. If that command also fails, report a bug."])
})

test("thrown repair preserves the concrete error and guidance", async () => {
  const reports: string[] = []
  const operation = createRemoteMutation({
    dispatch: async () => { throw new Error("service manager is unavailable") },
    report: (_severity, message) => reports.push(message),
    actions: actionOwner(),
  }, () => true, () => true)
  await operation.mutate({ type: "remote.process_initiation.set", enabled: true }, true)
  assert.deepEqual(reports, ["service manager is unavailable. Run `flywheel serve install` on this machine. If that command also fails, report a bug."])
})

test("a second new name for a device runs after the rename in flight instead of joining it, and the same name joins", async () => {
  const gates: (() => void)[] = []
  const dispatched: string[] = []
  const operation = createRemoteMutation({
    dispatch: async (mutation) => {
      if (mutation.type === "remote.device.rename") dispatched.push(mutation.label)
      await new Promise<void>((resolve) => { gates.push(resolve) })
      return { kind: "committed" }
    },
    report: () => {},
    actions: actionOwner(),
  }, () => true, () => true)
  const first = operation.mutate({ type: "remote.device.rename", deviceId: "phone", label: "Pocket" })
  const second = operation.mutate({ type: "remote.device.rename", deviceId: "phone", label: "Desk" })
  const repeat = operation.mutate({ type: "remote.device.rename", deviceId: "phone", label: "Desk" })
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
  assert.deepEqual(dispatched, ["Pocket"])
  assert.equal(operation.working("remote.device.rename", "phone"), true)
  gates.shift()?.()
  await first
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
  assert.deepEqual(dispatched, ["Pocket", "Desk"])
  gates.shift()?.()
  await Promise.all([second, repeat])
  assert.deepEqual(dispatched, ["Pocket", "Desk"])
  assert.equal(operation.working("remote.device.rename", "phone"), false)
})

test("the phone's Machines sheet offers a new project from a repository on a machine that announces the offer, and never lists the offer as a project", () => {
  const offer = { id: "machine", projectLabel: "New project from repository", version: "1.0.0", protocolVersion: 1, state: "live" } as const
  const project = { id: "project", projectLabel: "project", version: "1.0.0", protocolVersion: 1, state: "live" } as const
  const machine = { runtimeId: "machine", label: "Machine", relay: "https://relay.example", presence: "online" } as const
  const offered = renderMachinesSheet(base, { runtimes: [{ ...machine, placements: [offer, project] }] })
  assert.match(offered, /<button class="ghost-text new-project-open">New project from repository<\/button>/)
  assert.doesNotMatch(offered, /<span class="placement-name">New project from repository<\/span>/)
  assert.match(offered, /1 project open/)
  assert.doesNotMatch(renderMachinesSheet(base), /New project from repository/)
  const failed = renderMachinesSheet(base, {
    runtimes: [{ ...machine, placements: [offer] }],
    creation: { runtimeId: "machine", repository: "owner/private", status: "failed", message: "The machine could not read owner/private." },
  })
  assert.match(failed, /awake, nothing open/)
  assert.match(failed, /<span class="placement-name">owner\/private<\/span>/)
  assert.match(failed, /The machine could not read owner\/private\./)
})
