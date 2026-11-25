import assert from "node:assert/strict"
import { test } from "node:test"

import type { RuntimeConnection } from "../../../../../src/protocol/client/runtime/connection.js"
import { restartNoSuccessorReason } from "../../../../../src/protocol/client/runtime/service-restart-copy.js"
import { fakeRuntimeConnection } from "../../../test-support/runtime-connection-fixture.js"
import { restartService } from "./service-restart.js"

test("a restart whose old service left and whose successor never answers fails with the reason after its deadline", async () => {
  const listeners = new Set<(state: RuntimeConnection["state"]) => void>()
  const connection = fakeRuntimeConnection({
    queries: { restartReadiness: () => ({ kind: "ready", serviceStart: "start-1" }) },
    mutations: { "service.restart": () => ({ ok: true }) },
  }, {
    onStateChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  const restarted = restartService(connection, 20)
  await new Promise((resolve) => { setTimeout(resolve, 1) })
  for (const listener of listeners) listener("recovering")

  await assert.rejects(restarted, { message: restartNoSuccessorReason(0) })
  assert.equal(listeners.size, 0)
})
