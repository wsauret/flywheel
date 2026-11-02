import { describe, expect, test } from "bun:test"
import { composeModuleServices } from "../../../../../src/infra/module-service.js"
import { composeAccountModuleProtocolRuntimes, type AccountModuleProtocolServices } from "../../../../../src/orchestration/app-service/module-protocol-host.js"
import { remoteModule } from "../../../../../src/orchestration/modules/remote/module.js"
import type { RemoteAccess } from "../../../../../src/orchestration/modules/remote/remote-access.js"
import type { RemoteService } from "../../../../../src/orchestration/modules/remote/service.js"
import { EMPTY_REMOTE_VIEW, remoteProtocol } from "../../../../../src/protocol/modules/remote.js"

function fixture() {
  let enabled = true
  let found = true
  const calls: unknown[][] = []
  const view = { ...EMPTY_REMOTE_VIEW, connection: "connected" as const }
  const access: RemoteAccess = {
    view: () => view,
    async openPairing() { calls.push(["pair"]); return { windowId: "window", code: "link", expiresAt: 100 } },
    async cancelPairing() { calls.push(["cancel"]) },
    async revokeDevice(id) { calls.push(["revoke", id]); return found },
    async renameDevice(id, label) { calls.push(["rename", id, label]); return found },
    async forgetProject(root) { calls.push(["forget", root]); return found },
    async setProcessInitiation(value) { calls.push(["initiation", value]) },
    async setPushSubscription(id, value) { calls.push(["push", id, value]); return found },
    pushTargets: () => [], forgetPushSubscription: async () => {}, acceptChannels: () => () => {}, onChange: () => () => {}, dispose: async () => {},
    notificationAddress: async () => ({ runtimeId: "machine", placementId: "project", machine: "Machine", project: "Project" }),
  }
  const service: RemoteService = { access: () => access, ready: async () => access, dispose: async () => {} }
  const services: Omit<AccountModuleProtocolServices, "enabled"> = {
    publish: (patch) => ({ ...patch, position: 1, prevPosition: 0 }), snapshotPosition: () => 37,
    modules: composeModuleServices([[remoteModule.id, service]]),
  }
  const routes = composeAccountModuleProtocolRuntimes([remoteModule], services, () => enabled ? [remoteModule.id] : [])
  return { routes, calls, view, select(value: boolean) { enabled = value }, found(value: boolean) { found = value } }
}

const subscription = { endpoint: "https://push.example/send", expirationTime: null, keys: { p256dh: "key", auth: "auth" } }
const requests = [
  { type: "remote.pair.open" }, { type: "remote.pair.cancel" },
  { type: "remote.device.revoke", deviceId: "phone" },
  { type: "remote.device.rename", deviceId: "phone", label: " New name " },
  { type: "remote.push.subscribe", deviceId: "phone", subscription },
  { type: "remote.push.unsubscribe", deviceId: "phone" },
  { type: "remote.project.forget", placementId: "placement" },
  { type: "remote.process_initiation.set", enabled: true },
] as const

describe("Remote protocol registration", () => {
  test("routes its snapshot and all eight editor-omitted actions through the registry", async () => {
    const f = fixture()
    expect(await f.routes.serve({ type: "remoteSnapshot" })).toEqual({ remote: f.view, snapshotPosition: 37 })
    for (const request of requests) expect(await f.routes.mutate(request)).toEqual({ kind: "committed" })
    expect(f.calls).toEqual([["pair"], ["cancel"], ["revoke", "phone"], ["rename", "phone", "New name"], ["push", "phone", subscription], ["push", "phone", undefined], ["forget", "placement"], ["initiation", true]])
    expect(remoteProtocol.mutations.map(({ type }) => type)).toEqual(requests.map(({ type }) => type))
    expect(remoteProtocol.mutations.every(({ editor, policy }) => editor === "omitted" && policy === "lossless")).toBe(true)
    f.routes.dispose()
  })

  test("disabled selection hides retained state and refuses every action before a later enable", async () => {
    const f = fixture()
    f.select(false)
    expect(await f.routes.serve({ type: "remoteSnapshot" })).toEqual({ remote: EMPTY_REMOTE_VIEW, snapshotPosition: 37 })
    for (const request of requests) expect(await f.routes.mutate(request)).toEqual({ kind: "rejected", message: "Remote access is off" })
    expect(f.calls).toEqual([])
    f.select(true)
    expect(await f.routes.mutate({ type: "remote.pair.open" })).toEqual({ kind: "committed" })
    f.routes.dispose()
  })

  test("preserves device and project refusal messages", async () => {
    const f = fixture()
    f.found(false)
    expect(await f.routes.mutate({ type: "remote.device.revoke", deviceId: "missing" })).toEqual({ kind: "rejected", message: "That device is not paired." })
    expect(await f.routes.mutate({ type: "remote.project.forget", placementId: "missing" })).toEqual({ kind: "rejected", message: "That project is not recorded." })
    f.routes.dispose()
  })
})
