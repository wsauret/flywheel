import { describe, expect, it } from "bun:test"
import { createEffect, createRoot, createSignal, on } from "solid-js"

import { EMPTY_REMOTE_VIEW } from "../../../../src/protocol/modules/remote.js"
import { fakeClient, fakeClientHost, fakePanelSettings, fakeViewState } from "../../app/client-context-fixture.js"
import { fakeRuntimeConnection } from "../../client/runtime-connection-fixture.js"
import type { ClientViewState } from "../../client/view-state.js"
import type { HostCapabilities, PushSubscriptionRecord, RemoteHostSnapshot } from "../../host.js"
import { remoteMenu } from "./menu.js"
import { createPushRegistration } from "./push-registration.js"
import { mountPerPlacement } from "../../../phone/placement-client.js"

const tick = async () => { for (let n = 0; n < 8; n += 1) await Promise.resolve() }
const subscription: PushSubscriptionRecord = { endpoint: "https://push.example/device", expirationTime: null, keys: { auth: "auth", p256dh: "key" } }

describe("remote menu action lifetime", () => {
  for (const boundary of ["disabled", "disposed", "selection"] as const) it(`does not dispatch a late browser permission after ${boundary}`, async () => {
    const permission = Promise.withResolvers<PushSubscriptionRecord | undefined>()
    const reports: string[] = []
    let dispatches = 0
    let requests = 0
    const listeners = new Set<(snapshot: RemoteHostSnapshot) => void>()
    const initial: RemoteHostSnapshot = { deviceLabel: "phone", runtimes: [], selected: { runtimeId: "machine", placementId: "project" }, pairing: { status: "idle" } }
    const capabilities: HostCapabilities = {
      remote: {
        deviceId: "device", snapshot: () => initial,
        onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
        pair: async () => {}, setLabel: async () => {}, select: () => {}, forget: async () => {}, createProject: async (runtimeId) => ({ runtimeId, placementId: "created" }),
      },
      push: { state: () => "default", current: async () => undefined, subscribe: () => { requests += 1; return permission.promise }, unsubscribe: async () => {} },
    }
    const idle = fakeViewState()
    const frame = (enabled: boolean): ClientViewState => ({
      ...idle, projectRoot: "/workspace", modules: { ...idle.modules, remote: { ...EMPTY_REMOTE_VIEW, pushPublicKey: "public-key" } }, settings: fakePanelSettings({ moduleIds: enabled ? ["remote"] : [] }),
    })
    const mountApp = () => createRoot((dispose) => {
      const [state, setState] = createSignal(frame(true))
      const client = fakeClient({
        state, host: fakeClientHost({ capabilities }),
        connection: fakeRuntimeConnection({ onDispatch: () => { dispatches += 1 }, mutations: { "remote.push.subscribe": () => ({ kind: "committed" }) } }),
        report: (_severity, message) => { reports.push(message) },
      })
      let registration!: ReturnType<typeof createPushRegistration>
      // The app's module notice unmounts when its published selection turns off.
      createEffect(on(() => state().settings?.moduleIds.includes("remote"), (enabled) => {
        if (enabled) registration = createPushRegistration(client)
      }))
      return { dispose, setState, client, registration: () => registration }
    })
    let choose = (_changed: boolean) => {}
    const mounts: ReturnType<typeof mountApp>[] = []
    const placement = mountPerPlacement({
      capability: { select: () => choose(true) },
      onSelectionChange(listener) { choose = listener; return () => {} },
    }, () => {
      const app = mountApp()
      mounts.push(app)
      return { dispose: app.dispose, command: () => {} }
    })
    const h = mounts[0]!
    try {
      const pushRow = remoteMenu(h.client, "panel").find((row) => row.id === "push")
      expect(pushRow?.value).toBe(h.registration().state().kind)
      pushRow?.run()
      await tick()
      expect(requests).toBe(1)
      expect(remoteMenu(h.client, "panel").find((row) => row.id === "push")?.working).toBe(true)
      if (boundary === "disabled") { h.setState(frame(false)); h.setState(frame(true)) }
      else if (boundary === "disposed") placement.handle.dispose()
      else choose(true)
      permission.resolve(subscription)
      await tick()
      expect(dispatches).toBe(0)
      expect(reports).toEqual([])
      expect(listeners.size).toBe(boundary === "disposed" ? 0 : 1)
    } finally { for (const app of mounts) app.dispose() }
  })
})
