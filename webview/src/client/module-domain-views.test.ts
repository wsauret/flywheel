import assert from "node:assert/strict"
import { test } from "node:test"

import type { RuntimeHealth } from "../../../src/protocol/app-service-types.js"
import { EMPTY_REMOTE_VIEW, remoteDomain, type RuntimeRemoteView } from "../../../src/protocol/modules/remote.js"
import { pageDomainReader } from "./module-domain-views.js"

// Status and Remote access read the machine's remote view through this
// reader. The page holds that view through a fault, and the relay drops a
// machine that stops answering, so the held attachment is not current.
test("the page reads a held remote view as not attached while its runtime does not answer, and as held while it does", () => {
  const attached: RuntimeRemoteView = { ...EMPTY_REMOTE_VIEW, connection: "connected", attachedClients: 1, devices: [{ id: "phone", label: "Phone", pairedAt: 1, notifies: false, attached: true }] }
  let health: RuntimeHealth = { kind: "faulted", since: 1 }
  const read = pageDomainReader(() => ({ modules: { remote: attached }, health }))
  const faulted = read(remoteDomain)
  assert.equal(faulted?.attachedClients, 0)
  assert.equal(faulted?.connection, "reconnecting")
  assert.deepEqual(faulted?.devices.map((device) => device.attached), [false])
  health = { kind: "healthy" }
  assert.deepEqual(read(remoteDomain), attached)
})
