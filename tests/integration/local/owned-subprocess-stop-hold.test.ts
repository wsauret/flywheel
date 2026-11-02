import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { onTermination } from "../../../src/infra/process-container.js"
import { createProcessSupervisor } from "../../../src/infra/process-supervisor.js"
import { payloadThatRunsForever } from "../../helpers/payload.js"
import { createRealProcessFixture, processAlive, type RealProcessFixture } from "../../helpers/real-process-fixture.js"

const TARGET = fileURLToPath(new URL("../../fixtures/owned-process-target.ts", import.meta.url))
const SUPERVISOR_MODULE = new URL("../../../src/infra/process-supervisor.ts", import.meta.url).href

const fixtures: RealProcessFixture[] = []

function fixture(name: string): RealProcessFixture {
  const created = createRealProcessFixture(name)
  fixtures.push(created)
  return created
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

/** A launch's stop hold against the ends that outlive or replace its
 *  launcher: the host's own exit, and the disposal of its guardian. Each case
 *  holds the lock past the bound that it would overrun without the hold. */
describe("owned subprocess stop hold", () => {
  // On Windows the host's runtime ends the members of the job it keeps for its
  // children when the host exits, so a launch with a stop hold must stay out of
  // that job for its supervisor to carry the hold.
  test("a host crash ends a payload with a stop hold only once its hold is gone", async () => {
    const scratch = fixture("owned-crash-hold")
    const marker = scratch.file("payload-ran")
    const lock = scratch.file(".oauth_refresh.lock")
    await Bun.write(lock, "refreshing")
    const hostSource = [
      `import { createProcessSupervisor } from ${JSON.stringify(SUPERVISOR_MODULE)}`,
      `const supervisor = createProcessSupervisor()`,
      `await supervisor.spawnOwned([${JSON.stringify(process.execPath)}, ${JSON.stringify(TARGET)}, ${JSON.stringify(marker)}], { stopHold: { path: ${JSON.stringify(lock)}, boundMs: 20_000 } })`,
      `await new Promise(() => {})`,
    ].join("\n")

    const host = Bun.spawn([process.execPath, "-e", hostSource], { stdout: "ignore", stderr: "pipe", windowsHide: true })
    const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker, 15_000)))

    host.kill("SIGKILL")
    await host.exited
    await Bun.sleep(2_000)
    expect(processAlive(payloadPid)).toBe(true)

    rmSync(lock, { force: true })
    await scratch.waitForGone(payloadPid, 15_000)
    expect(processAlive(payloadPid)).toBe(false)
  }, 40_000)

  // The guardian's sweep waits each lease's stop hold before its TERM, so
  // disposal gives the guardian that hold beyond its own exit bound rather
  // than killing it in the middle of the sweep.
  test("disposal lets the guardian's sweep wait a lease's stop hold past the guardian's exit bound", async () => {
    const scratch = fixture("owned-dispose-hold")
    const lock = scratch.file(".oauth_refresh.lock")
    await Bun.write(lock, "refreshing")
    const kills: string[] = []
    const stopWatching = onTermination((decision) => { kills.push(decision.reason) })
    try {
      const supervisor = createProcessSupervisor()
      const running = await supervisor.spawnOwned(payloadThatRunsForever(), { stopHold: { path: lock, boundMs: 20_000 } })
      scratch.guard(running.pid)
      const started = performance.now()
      // The refresh ends past the guardian's 10 s exit bound.
      const refreshEnds = setTimeout(() => { rmSync(lock, { force: true }) }, 11_000)

      await supervisor.dispose()
      clearTimeout(refreshEnds)

      expect(performance.now() - started).toBeGreaterThan(10_500)
      expect(kills).not.toContain("process exit deadline exceeded")
      await scratch.waitForGone(running.pid, 15_000)
    } finally {
      stopWatching()
    }
  }, 40_000)
})
