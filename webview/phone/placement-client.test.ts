import { expect, test } from "bun:test"

import type { ClientCommand } from "../../src/protocol/client/host-contract.js"
import { mountPerPlacement } from "./placement-client.js"
import { decodeInputReloadCheckpoint } from "../src/client/input-reload-checkpoint.js"
import type { NotificationAddress } from "../../src/protocol/modules/remote/notification-address.js"

test("input checkpoints belong to the selected runtime and placement, not the phone page or bundle", () => {
  const selected = { runtimeId: "machine", placementId: "windows" }
  const saved = { version: 1, scope: JSON.stringify(selected), composer: { sessionId: "chat", active: { text: "windows draft", attachments: [] }, drafts: {}, questions: {} } }
  expect(decodeInputReloadCheckpoint(saved, JSON.stringify({ ...selected, placementId: "wsl:Debian" }))).toBeUndefined()
  expect(decodeInputReloadCheckpoint(saved, JSON.stringify({ ...selected, runtimeId: "other-machine" }))).toBeUndefined()
  expect(decodeInputReloadCheckpoint(saved, JSON.stringify(selected))?.composer?.active.text).toBe("windows draft")
})

/** A relay whose choices the test makes, and a record of every client mount. */
function harness(address?: NotificationAddress) {
  let choose: (placementChanged: boolean) => void = () => {}
  const mounts: { readonly commands: ClientCommand[]; disposed: boolean; readonly initialSessionId?: string; readonly initialAttention?: boolean }[] = []
  const selected: unknown[] = []
  let selectedKey = ""
  const placement = mountPerPlacement(
    { capability: { select: (selection) => { selected.push(selection); const key = `${selection.runtimeId}:${selection.placementId}`; const changed = key !== selectedKey; selectedKey = key; choose(changed) } }, onSelectionChange(listener) { choose = listener; return () => {} } },
    (initialSessionId, initialAttention) => {
      const commands: ClientCommand[] = []
      const mount = { commands, disposed: false, ...(initialSessionId === undefined ? {} : { initialSessionId }), ...(initialAttention ? { initialAttention: true } : {}) }
      mounts.push(mount)
      return { command: (command) => { mount.commands.push(command) }, dispose() { mount.disposed = true } }
    },
    address,
  )
  return { placement, mounts, selected, choose: (placementChanged: boolean) => choose(placementChanged) }
}

test("choosing the same project again keeps the client and its lane, and only asks it to make sure it is connected", () => {
  // A reconnect would close a working lane and make every view read again
  // (PI-REMOTE-007). The client's connection decides whether its lane needs
  // a new attach.
  const { mounts, choose } = harness()
  choose(false)
  expect(mounts).toEqual([{ commands: [{ type: "ensureConnected" }], disposed: false }])
})

test("another project gets a fresh client, so nothing of the old project stays on screen under the new name", () => {
  const { placement, mounts, choose } = harness()
  const first = placement.handle
  choose(true)
  expect(mounts).toEqual([{ commands: [], disposed: true }, { commands: [], disposed: false }])
  expect(placement.handle).not.toBe(first)
  // A later command reaches the client on screen, not the one that left.
  placement.handle.command({ type: "openSurface", surface: "runtimes" })
  expect(mounts[1]?.commands).toEqual([{ type: "openSurface", surface: "runtimes" }])
})

test("the first client opens the session a tapped notification names, and a client for another project opens none", () => {
  const { mounts, choose } = harness({ sessionId: "run-1", attention: false })
  choose(true)
  expect(mounts).toEqual([{ commands: [], disposed: true, initialSessionId: "run-1" }, { commands: [], disposed: false }])
})

test("an open app selects the notification project before delivering attention, also to the same session", () => {
  const h = harness()
  const address = { sessionId: "chat", selection: { runtimeId: "studio", placementId: "project" }, attention: true }
  h.placement.openAddress(address)
  expect(h.selected).toEqual([address.selection])
  expect(h.mounts).toHaveLength(2)
  expect(h.mounts[1]).toEqual({ commands: [], disposed: false, initialSessionId: "chat", initialAttention: true })
  h.placement.openAddress(address)
  expect(h.mounts[1]?.commands).toEqual([{ type: "ensureConnected" }, { type: "attendQuestion", sessionId: "chat" }])
})
