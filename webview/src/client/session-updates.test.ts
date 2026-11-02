import assert from "node:assert/strict"
import { test } from "node:test"

import type { FrontendEvent } from "../../../src/protocol/app-service-types.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { UpdateStatusView } from "../../../src/protocol/update-protocol-types.js"
import { createRuntimeSession } from "./session.js"
import { fakeRuntimeConnection } from "./runtime-connection-fixture.js"

const AUTO_INSTALL = { persisted: true, forcedOff: false, effective: true } as const

const AVAILABLE: UpdateStatusView = {
  revision: 2,
  autoInstall: AUTO_INSTALL,
  status: { kind: "available", version: "1.6.0", blocking: "nothing" },
}

function fakeConnection() {
  const listeners = new Set<(event: FrontendEvent) => void>()
  const connection: RuntimeConnection = fakeRuntimeConnection({ queries: {
    updateSnapshot: async () => ({ snapshotPosition: 1, update: { revision: 1, autoInstall: AUTO_INSTALL, status: { kind: "installed", version: "1.5.0" } } }),
    authStatusSnapshot: () => new Promise(() => {}),
  } }, {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  const publish = (view: UpdateStatusView, position: number) => {
    for (const listener of listeners) listener({ type: "patch", patch: { cursor: { scope: "workspace", domain: "updates" }, position, prevPosition: position - 1, payload: { kind: "update.changed", update: view } } })
  }
  return { connection, publish }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

test("the updates view is seeded from its snapshot and follows each live patch", async () => {
  const fake = fakeConnection()
  const session = createRuntimeSession({ connection: fake.connection })
  await settle()
  const seeded = session.update
  assert.equal(seeded?.status.kind, "installed")

  fake.publish(AVAILABLE, 2)
  const live = session.update
  assert.equal(live?.status.kind, "available")
  assert.equal(live?.revision, 2)

  fake.publish({ ...AVAILABLE, revision: 3, status: { kind: "installed", version: "1.6.0" } }, 3)
  const next = session.update
  assert.equal(next?.status.kind, "installed")
  session.dispose()
})
