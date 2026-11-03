import { expect, it, spyOn } from "bun:test"
import { createRoot } from "solid-js"
import { Socket } from "effect/socket"
import { UNANSWERED_ACTION } from "../../../../../src/protocol/client/runtime-fault-copy.js"
import type { FrontendMutation, RuntimeClient } from "../../../../../src/protocol/app-service-types.js"
import type { RuntimeRemoteView } from "../../../../../src/protocol/modules/remote.js"
import { createModalStack } from "../../../../../src/tui/components/modal-stack.js"
import { useRemoteModal } from "../../../../../src/tui/modules/remote/use-remote-modal.js"
import { recordedDispatch, runtimeDispatch } from "../../../../helpers/runtime-dispatch.js"

const view: RuntimeRemoteView = {
  relayUrl: "https://relay.flywl.sh",
  connection: "connected",
  devices: [],
  attachedClients: 0,
  pairing: null,
  lastError: null,
  pushPublicKey: null,
  projects: [{ placementId: "web-uat", projectRoot: "/private/tmp/web-uat", displayPath: "/private/tmp/web-uat", projectLabel: "web-uat", lastAttachedAt: 0, state: "asleep" }],
  processInitiation: "off",
}

type RemoteResult = { readonly kind: "committed" } | { readonly kind: "rejected"; readonly message: string }
function harness(remoteView: RuntimeRemoteView, currentProjectRoot = "/repo", result: RemoteResult | Promise<RemoteResult> = { kind: "committed" }) {
  return createRoot((dispose) => {
    const commands: FrontendMutation[] = []
    const toasts: Array<{ message: string; variant: string }> = []
    // The runtime answers every remote action with `result`.
    const answer = async () => result
    const dispatch = recordedDispatch((command) => { commands.push(command) }, runtimeDispatch({
      "remote.pair.open": answer, "remote.pair.cancel": answer, "remote.device.revoke": answer,
      "remote.device.rename": answer, "remote.project.forget": answer, "remote.process_initiation.set": answer,
    }))
    const appService: Pick<RuntimeClient, "dispatch"> = { dispatch }
    const modal = createModalStack()
    const hook = useRemoteModal({
      modal,
      renderModal: () => null,
      view: () => remoteView,
      currentProjectRoot: () => currentProjectRoot,
      appService,
      showToast: (toast) => { toasts.push(toast) },
    })
    return { commands, dispose, hook, modal, toasts }
  })
}

it("stops offering the selected saved project", async () => {
    const h = harness(view)
    h.hook.openRemoteModal()
    h.modal.input({ name: "d" })
    await Promise.resolve()

    expect(h.commands).toEqual([{ type: "remote.project.forget", placementId: "web-uat" }])
    expect(h.toasts).toEqual([{ message: "web-uat is no longer offered", variant: "success" }])
    h.dispose()
})

it.each(["escape", "tab", "frame", "click"])("commits a device rename on %s without keystroke writes", async (finish) => {
  const h = harness({ ...view, devices: [{ id: "phone", label: "Phone", pairedAt: 0, notifies: false, attached: false }] })
  try {
    h.hook.openRemoteModal()
    h.modal.input({ name: "r" })
    h.modal.input({ name: "a", ctrl: true, shift: true })
    h.modal.paste("New phone")
    expect(h.commands).toEqual([])
    if (finish === "frame") h.modal.clear()
    else if (finish === "click") h.hook.select(1)
    else h.modal.input({ name: finish })
    await Promise.resolve()
    expect(h.commands).toEqual([{ type: "remote.device.rename", deviceId: "phone", label: "New phone" }])
  } finally { h.dispose() }
})

it("retains invalid device text until leaving and writes nothing for an unchanged label", () => {
  const h = harness({ ...view, devices: [{ id: "phone", label: "Phone", pairedAt: 0, notifies: false, attached: false }] })
  try {
    h.hook.openRemoteModal()
    h.modal.input({ name: "r" })
    h.modal.input({ name: "escape" })
    expect(h.commands).toEqual([])
    h.modal.input({ name: "r" })
    h.modal.input({ name: "a", ctrl: true, shift: true })
    h.modal.input({ name: "backspace" })
    h.modal.input({ name: "return" })
    expect(h.hook.rename()).toMatchObject({ presentation: { value: "" }, error: "Enter a device name" })
    h.modal.input({ name: "escape" })
    expect(h.hook.rename()).toBeUndefined()
    expect(h.commands).toEqual([])
    expect(h.toasts).toEqual([{ message: "Enter a device name", variant: "error" }])
  } finally { h.dispose() }
})

it.each([{}, { ctrl: true }, { shift: true }])("keeps left and right as device rename editing keys: %j", (modifier) => {
  const h = harness({ ...view, devices: [{ id: "phone", label: "Phone", pairedAt: 0, notifies: false, attached: false }] })
  try {
    h.hook.openRemoteModal()
    h.modal.input({ name: "r" })
    h.modal.input({ name: "left", ...modifier })
    h.modal.input({ name: "right", ...modifier })
    expect(h.hook.rename()).toBeDefined()
    expect(h.commands).toEqual([])
  } finally { h.dispose() }
})

it("shows pending device writes after blur without a success toast", async () => {
  const pending = Promise.withResolvers<RemoteResult>()
  const h = harness({ ...view, devices: [{ id: "phone", label: "Phone", pairedAt: 0, notifies: false, attached: false }] }, "/repo", pending.promise)
  try {
    h.hook.openRemoteModal()
    h.modal.input({ name: "r" })
    h.modal.paste("!")
    h.modal.input({ name: "return" })
    expect(h.hook.rename()).toMatchObject({ saving: true })
    h.modal.input({ name: "tab" })
    expect(h.hook.rename()).toBeUndefined()
    expect(h.hook.renameSaving("phone")).toBe(true)
    pending.resolve({ kind: "committed" })
    for (let index = 0; index < 10; index++) await Promise.resolve()
    expect(h.hook.renameSaving("phone")).toBe(false)
    expect(h.toasts).toEqual([])
  } finally { h.dispose() }
})

it("does not dispatch process initiation from a source build", () => {
  const { processInitiation: _capability, ...sourceView } = view
  const h = harness(sourceView)
  h.hook.openRemoteModal()
  h.modal.input({ name: "i" })
  expect(h.commands).toEqual([])
  h.dispose()
})

it("repairs unavailable process initiation and gives command guidance on failure", async () => {
  const h = harness({ ...view, processInitiation: "unavailable" }, "/repo", { kind: "rejected", message: "launch agent was denied" })
  h.hook.openRemoteModal()
  h.modal.input({ name: "i" })
  await Promise.resolve()
  expect(h.commands).toEqual([{ type: "remote.process_initiation.set", enabled: true }])
  expect(h.toasts).toEqual([{
    message: "launch agent was denied. Run `flywheel serve install` on this machine. If that command also fails, report a bug.",
    variant: "error",
  }])
  h.dispose()
})

it("holds one process initiation operation in flight", async () => {
  const pending = Promise.withResolvers<{ readonly kind: "committed" }>()
  const h = createRoot((dispose) => {
    const commands: FrontendMutation[] = []
    const modal = createModalStack()
    const dispatch = runtimeDispatch({ "remote.process_initiation.set": (command) => {
      commands.push(command)
      return pending.promise
    } })
    const hook = useRemoteModal({
      modal, renderModal: () => null, view: () => ({ ...view, processInitiation: "unavailable" }),
      currentProjectRoot: () => "/repo",
      appService: { dispatch },
      showToast: () => {},
    })
    return { commands, dispose, hook, modal }
  })
  h.hook.openRemoteModal()
  h.modal.input({ name: "i" })
  h.modal.input({ name: "i" })
  expect(h.commands).toHaveLength(1)
  expect(h.hook.processInitiationPending()).toBe(true)
  pending.resolve({ kind: "committed" })
  await Promise.resolve()
  await Promise.resolve()
  expect(h.hook.processInitiationPending()).toBe(false)
  h.dispose()
})

it("says in plain words that an action did not run while the runtime does not answer, never the transport's words", async () => {
  const h = createRoot((dispose) => {
    const toasts: Array<{ message: string; variant: string }> = []
    const dispatch = runtimeDispatch({ "remote.pair.open": () => Promise.reject(new Socket.SocketError({ reason: new Socket.SocketWriteError({ cause: new Error("the channel closed") }) })) })
    const modal = createModalStack()
    const hook = useRemoteModal({
      modal, renderModal: () => null, view: () => view,
      currentProjectRoot: () => "/repo",
      appService: { dispatch },
      showToast: (toast) => { toasts.push(toast) },
    })
    return { dispose, hook, modal, toasts }
  })
  h.hook.openRemoteModal()
  h.modal.input({ name: "p" })
  await Promise.resolve()
  await Promise.resolve()
  expect(h.toasts).toEqual([{ message: UNANSWERED_ACTION, variant: "error" }])
  h.dispose()
})

it("skips the current project and reports a rejected removal", async () => {
    const h = harness({
      ...view,
      devices: [{ id: "phone", label: "Phone", pairedAt: 0, notifies: false, attached: false }],
      projects: [
        { placementId: "repo", projectRoot: "/repo", displayPath: "/repo", projectLabel: "repo", lastAttachedAt: 0, state: "open" },
        ...view.projects,
      ],
    }, "/repo", { kind: "rejected", message: "Project was already removed" })

    h.hook.openRemoteModal()
    h.modal.input({ name: "down" })
    expect(h.hook.cursor()).toBe(2)
    h.modal.input({ name: "d" })
    await Promise.resolve()

    expect(h.commands).toEqual([{ type: "remote.project.forget", placementId: "web-uat" }])
    expect(h.toasts).toEqual([{ message: "Project was already removed", variant: "error" }])
    h.dispose()
})

it("does not select or remove the current project", async () => {
    const h = harness({ ...view, projects: [{ placementId: "repo", projectRoot: "/repo", displayPath: "/repo", projectLabel: "repo", lastAttachedAt: 0, state: "open" }] })
    h.hook.openRemoteModal()
    h.hook.select(0)
    h.modal.input({ name: "d" })
    await Promise.resolve()

    expect(h.commands).toEqual([])
    h.dispose()
})


it("keeps a deadline ticker across reopen and clears it on close and disposal", () => {
  const start = spyOn(globalThis, "setInterval")
  const stop = spyOn(globalThis, "clearInterval")
  const h = harness(view)
  try {
    h.hook.openRemoteModal()
    expect(start).toHaveBeenCalledTimes(1)
    h.hook.openRemoteModal()
    expect(start).toHaveBeenCalledTimes(2)
    expect(stop).toHaveBeenCalledWith(start.mock.results[0]?.value)
    h.hook.closeRemoteModal()
    expect(stop).toHaveBeenCalledWith(start.mock.results[1]?.value)
    expect(h.modal.stack.length).toBe(0)
    h.hook.openRemoteModal()
    expect(start).toHaveBeenCalledTimes(3)
    h.dispose()
    expect(stop).toHaveBeenCalledWith(start.mock.results[2]?.value)
    expect(h.modal.stack.length).toBe(0)
  } finally { h.dispose(); start.mockRestore(); stop.mockRestore() }
})

it("does not publish a late action toast after the module surface is disposed", async () => {
  const h = harness(view)
  h.hook.openRemoteModal()
  h.modal.input({ name: "i" })
  expect(h.commands).toEqual([{ type: "remote.process_initiation.set", enabled: true }])
  h.dispose()
  await Promise.resolve()
  await Promise.resolve()
  expect(h.toasts).toEqual([])
})
