import assert from "node:assert/strict"
import { describe, test } from "node:test"
import { Redacted } from "effect"

import { createRuntimeRecovery } from "./runtime-recovery.js"
import type { PrepareAccountResult } from "./supervisor.js"

const LISTENING: PrepareAccountResult = {
  ok: true,
  target: { socketPath: "/account/serve.sock", projectRoot: "/project", credential: Redacted.make("token") },
  service: { pid: 7, lane: "installed", version: "0.0.11", protocolVersion: 12 },
}

describe("finding or starting the account service again after a connection found nothing listening", () => {
  test("runs one find-or-start for every connection that asks meanwhile", async () => {
    const answer = Promise.withResolvers<PrepareAccountResult>()
    let runs = 0
    const recovery = createRuntimeRecovery({ ensure: () => { runs++; return answer.promise }, log: { info: () => {} } })

    const host = recovery.ensureRuntime()
    const client = recovery.ensureRuntime()
    answer.resolve(LISTENING)
    await Promise.all([host, client])

    assert.equal(runs, 1)
  })

  test("rejects with the start's own reason", async () => {
    const recovery = createRuntimeRecovery({
      ensure: async () => ({ ok: false, failure: { kind: "startup_failed", error: "no disk" } }),
      log: { info: () => {} },
    })

    await assert.rejects(recovery.ensureRuntime(), { message: "The Flywheel runtime could not start: no disk" })
  })

  test("logs the loss and the reconnect that follows it, once each", async () => {
    const lines: string[] = []
    const recovery = createRuntimeRecovery({ ensure: async () => LISTENING, log: { info: (line) => { lines.push(line) } } })

    recovery.observeState("connected")
    recovery.observeState("recovering")
    await recovery.ensureRuntime()
    recovery.observeState("connected")
    recovery.observeState("connected")

    assert.deepEqual(lines, [
      "a runtime connection found nothing listening; finding or starting the account service",
      "reconnected to the account service after a connection found nothing listening",
    ])
  })

  test("runs nothing for a client that asks after the host has connected again", async () => {
    let runs = 0
    const recovery = createRuntimeRecovery({ ensure: async () => { runs++; return LISTENING }, log: { info: () => {} } })

    recovery.observeState("recovering")
    await recovery.ensureRuntime()
    recovery.observeState("connected")
    await recovery.ensureRuntime()
    recovery.observeState("recovering")
    await recovery.ensureRuntime()

    assert.equal(runs, 2)
  })
})
