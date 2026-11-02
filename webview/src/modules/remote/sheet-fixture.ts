import { createComponent } from "solid-js"
import { renderToString } from "solid-js/web"

import type { RuntimeRemoteView } from "../../../../src/protocol/modules/remote.js"
import { ClientContext } from "../../app/client-context.js"
import { fakeClient, fakeClientHost, fakePanelSettings, fakeViewState } from "../../app/client-context-fixture.js"
import type { RemoteHostCapability, RemoteHostSnapshot } from "../../host.js"
import { RuntimesSheet } from "./runtimes.js"
import { RemoteSheet } from "./sheet.js"

/** The idle frame of a project whose runtime publishes `remote` with the module on. */
function remoteFrame(remote: RuntimeRemoteView) {
  const idle = fakeViewState()
  const view = fakeViewState({ projectRoot: "/repo", modules: { ...idle.modules, remote }, settings: fakePanelSettings({ moduleIds: ["remote"] }) })
  return () => view
}

export function renderRemoteSheet(remote: RuntimeRemoteView, mutable = true): string {
  const client = fakeClient({ state: remoteFrame(remote), host: fakeClientHost({ capabilities: { canMutate: () => mutable } }) })
  return renderToString(() => createComponent(ClientContext.Provider, {
    value: client,
    get children() { return createComponent(RemoteSheet, {}) },
  }))
}

/** The phone's Machines sheet while it is attached to the one project of one
 *  machine, whose runtime publishes `remote`, unless `overrides` says
 *  otherwise. */
export function renderMachinesSheet(remote: RuntimeRemoteView, overrides: Partial<RemoteHostSnapshot> = {}): string {
  const snapshot: RemoteHostSnapshot = {
    deviceLabel: "phone", selected: { runtimeId: "machine", placementId: "project" }, pairing: { status: "idle" },
    runtimes: [{ runtimeId: "machine", label: "Machine", relay: "https://relay.example", presence: "online", placements: [{ id: "project", projectLabel: "project", version: "1.0.0", protocolVersion: 1, state: "live" }] }],
    ...overrides,
  }
  const host: RemoteHostCapability = { deviceId: "phone", snapshot: () => snapshot, onChange: () => () => {}, pair: async () => {}, setLabel: async () => {}, select: () => {}, forget: async () => {}, createProject: async (runtimeId) => ({ runtimeId, placementId: "created" }) }
  const client = fakeClient({ state: remoteFrame(remote) })
  return renderToString(() => createComponent(ClientContext.Provider, {
    value: client,
    get children() { return createComponent(RuntimesSheet, { remote: host }) },
  }))
}
