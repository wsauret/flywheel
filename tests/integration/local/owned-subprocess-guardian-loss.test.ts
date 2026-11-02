import { afterEach, expect, spyOn, test } from "bun:test"

import { Log } from "../../../src/infra/log.js"
import { ownedProcessBackend, type OwnedProcessBackend } from "../../../src/infra/owned-subprocess-backend.js"
import { createProcessSupervisor } from "../../../src/infra/process-supervisor.js"
import { payloadThatRunsForever } from "../../helpers/payload.js"
import { createRealProcessFixture, type RealProcessFixture } from "../../helpers/real-process-fixture.js"

// The owners of the launches that a dead guardian held, as the supervisor
// tells them of its loss. owned-subprocess-guardian.test.ts owns the guardian's
// own lifecycle.

let scratch: RealProcessFixture | undefined

// Runs even when a failure escapes the test body.
afterEach(() => {
  scratch?.cleanup()
  scratch = undefined
})

test("an owner that fails when told of its guardian's loss keeps no launch from being ended", async () => {
  const fixture = createRealProcessFixture("owned-guardian-lost-throws")
  scratch = fixture
  const stopped: number[] = []
  // Records each launch this side ends, in order.
  const backend: OwnedProcessBackend = {
    ...ownedProcessBackend,
    launch: (command, options) => {
      const launch = ownedProcessBackend.launch(command, options)
      const stop = launch.stop
      return Object.assign(launch, { stop: () => { stopped.push(launch.pid); stop() } })
    },
  }
  const supervisor = createProcessSupervisor({ killGraceMs: 200, backend })
  const log = Log.create({ service: "process-supervisor" })
  const error = spyOn(log, "error")

  try {
    const failing = await supervisor.spawnOwned(payloadThatRunsForever(), { onGuardianLost: () => { throw new Error("owner failed") } })
    const next = await supervisor.spawnOwned(payloadThatRunsForever())
    fixture.guard(failing.pid)
    fixture.guard(next.pid)
    const dead = fixture.guard(await supervisor.guardian.pid())
    process.kill(dead, "SIGKILL")
    await Promise.all([failing.exited, next.exited])

    // This side ends both launches, the one whose owner failed and the ones
    // after it, and the failure is one record.
    expect(stopped).toEqual([failing.pid, next.pid])
    expect(error.mock.calls).toEqual([[expect.any(String), expect.objectContaining({ guardianPid: dead })]])
  } finally {
    error.mockRestore()
    await supervisor.dispose()
  }
}, 30_000)
