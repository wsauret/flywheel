import { describe, expect, it } from "bun:test"
import { moduleDomainReader } from "../../../../src/protocol/client/module-domain.js"
import { EMPTY_REMOTE_VIEW, remoteDomain, remoteProtocol, REMOTE_COMMAND_NAME, REMOTE_SURFACE, type RuntimeRemoteView } from "../../../../src/protocol/modules/remote.js"
import { protocolModuleComposerStatus, protocolModuleRows } from "../../../../src/protocol/protocol-module.js"

const paired: RuntimeRemoteView = { ...EMPTY_REMOTE_VIEW, connection: "connected", devices: [{ id: "phone", label: "Phone", pairedAt: 1, notifies: false, attached: false }] }
const read = (view: RuntimeRemoteView | undefined) => moduleDomainReader((domain) => domain.domain === "remote" ? view : undefined)
const label = (view: RuntimeRemoteView | undefined) => remoteProtocol.composer.status(read(view))
const suffix = { text: "✓", tone: "success" } as const
const action = { kind: "surface", id: REMOTE_SURFACE } as const

describe("Remote composer presence", () => {
  it("stays absent before a view and while the machine has no paired device or active pairing", () => {
    expect(label(undefined)).toEqual([])
    expect(label(EMPTY_REMOTE_VIEW)).toEqual([])
    expect(label({ ...EMPTY_REMOTE_VIEW, connection: "connected" })).toEqual([])
  })

  it("shows the pairing state even before a device exists", () => {
    expect(label({ ...EMPTY_REMOTE_VIEW, pairing: { windowId: "window", code: "https://example.test/pair", expiresAt: 20 } })).toEqual([{ id: "remote", text: "pairing", action }])
  })

  it("keeps reachable metadata separate from the muted connection text", () => {
    expect(label(paired)).toEqual([{ id: "remote", text: "remote control", suffix, action }])
    expect(label({ ...paired, attachedClients: 2 })).toEqual([{ id: "remote", text: "2 remote", suffix, action }])
    expect(label({ ...paired, connection: "reconnecting" })).toEqual([{ id: "remote", text: "remote control…", action }])
    expect(label({ ...paired, connection: "off" })).toEqual([])
  })

  it("keeps remote readings in the terminal prompt frame and omits them on web surfaces", () => {
    for (const view of [paired, { ...paired, attachedClients: 2 }, { ...EMPTY_REMOTE_VIEW, pairing: { windowId: "window", code: "https://example.test/pair", expiresAt: 20 } }]) {
      expect(protocolModuleComposerStatus([remoteProtocol], read(view), ["remote"], "terminal")).toEqual(label(view))
      expect(protocolModuleComposerStatus([remoteProtocol], read(view), ["remote"], "webview")).toEqual([])
    }
  })

  // The machine's last reading stays on screen through a recovery, which
  // shows nothing. Once the runtime does not answer, that reading is no
  // longer current, and the relay may have dropped the machine with it, so
  // every reading of the domain says not attached (PI-REMOTE-004).
  it("reads the machine as not attached while the runtime does not answer, in the indicator and in the status rows", () => {
    const unanswered = (view: RuntimeRemoteView) => moduleDomainReader((domain) => domain.domain === "remote" ? view : undefined, () => false)
    const attached: RuntimeRemoteView = { ...paired, attachedClients: 1, devices: paired.devices.map((device) => ({ ...device, attached: true })) }
    for (const view of [paired, attached]) {
      expect(remoteProtocol.composer.status(unanswered(view))).toEqual([{ id: "remote", text: "remote control…", action }])
    }
    expect(protocolModuleRows([remoteProtocol], "status", unanswered(attached), ["remote"])).toEqual([
      { id: "remote-relay", label: "Remote relay", value: "not attached; the relay dropped the machine", action },
      { id: "remote-devices", label: "Paired devices", value: "1 paired, 0 attached", action },
    ])
    expect(unanswered(attached)(remoteDomain)?.devices.map((device) => device.attached)).toEqual([false])
    expect(remoteProtocol.composer.status(unanswered({ ...paired, connection: "off" }))).toEqual([])
  })

  it("gives every client's Settings one Remote access row, named as its command, that opens the surface", () => {
    expect(protocolModuleRows([remoteProtocol], "settings", read(undefined), ["remote"])).toEqual([])
    expect(protocolModuleRows([remoteProtocol], "settings", read(paired), ["remote"])).toEqual([
      { id: "remote", label: REMOTE_COMMAND_NAME, value: "1 paired", hint: "Pair devices and manage access to this machine", action },
    ])
  })

  it("removes retained status and chrome immediately when the selection disables the module", () => {
    expect(protocolModuleRows([remoteProtocol], "status", read(paired), ["remote"])).toHaveLength(2)
    expect(protocolModuleRows([remoteProtocol], "status", read(paired), [])).toEqual([])
    expect(protocolModuleRows([remoteProtocol], "settings", read(paired), [])).toEqual([])
    expect(protocolModuleComposerStatus([remoteProtocol], read(paired), [])).toEqual([])
    expect(protocolModuleComposerStatus([remoteProtocol], read(paired), ["remote"])).toEqual(label(paired))
  })
})
