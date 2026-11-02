import { expect, test } from "bun:test"
import { enablePush } from "./push-actions.js"
import { EMPTY_REMOTE_VIEW } from "../../../../src/protocol/modules/remote.js"
import type { HostCapabilities } from "../../host.js"
import { fakeRuntimeConnection } from "../../client/runtime-connection-fixture.js"

test("turn-on calls the permission path in the tap, without waiting for a subscription read", async () => {
  let prompted = false
  const mutations: unknown[] = []
  const connection = fakeRuntimeConnection({ onDispatch: (mutation) => { mutations.push(mutation) }, mutations: { "remote.push.subscribe": () => ({ kind: "committed" }) } })
  const capabilities: HostCapabilities = {
    remote: {
      deviceId: "phone", snapshot: () => ({ deviceLabel: "Phone", runtimes: [], selected: { runtimeId: "machine", placementId: "project" }, pairing: { status: "idle" } }),
      onChange: () => () => {}, pair: async () => {}, setLabel: async () => {}, select: () => {}, forget: async () => {}, createProject: async (runtimeId) => ({ runtimeId, placementId: "created" }),
    },
    push: {
      state: () => "granted",
      current: () => new Promise(() => {}),
      subscribe: async () => { prompted = true; return { endpoint: "https://push.test", expirationTime: null, keys: { auth: "auth", p256dh: "key" } } },
      unsubscribe: async () => {},
    },
  }
  const pending = enablePush(connection, capabilities, { ...EMPTY_REMOTE_VIEW, pushPublicKey: "key" }, new AbortController().signal)
  expect(prompted).toBe(true)
  expect(await pending).toEqual({ kind: "on" })
  expect(mutations).toHaveLength(1)
})

