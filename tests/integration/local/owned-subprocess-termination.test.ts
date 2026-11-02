import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { ownedProcessBackend } from "../../../src/infra/owned-subprocess-backend.js"
import { createLauncherScope, createProcessSupervisor } from "../../../src/infra/process-supervisor.js"
import { containerHolds, createRealProcessFixture, FORCED_END, processAlive, suspendProcess, type RealProcessFixture } from "../../helpers/real-process-fixture.js"
import { payloadThatExits, payloadThatRunsForever } from "../../helpers/payload.js"

/** How an owned container ends and settles: by its owner's terminate, by a
 *  scope's close, and by its own supervisor, with real processes. */

const TARGET = fileURLToPath(new URL("../../fixtures/owned-process-target.ts", import.meta.url))

const fixtures: RealProcessFixture[] = []

function fixture(name: string): RealProcessFixture {
  const created = createRealProcessFixture(name)
  fixtures.push(created)
  return created
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

describe("owned subprocess termination", () => {
  test.skipIf(process.platform === "win32")("returns the guarded control descriptor to the baseline after settlement", async () => {
    const supervisor = createProcessSupervisor()

    try {
      const warmup = await supervisor.spawnOwned(payloadThatExits())
      await warmup.exited
      const baseline = readdirSync("/dev/fd").length
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const owned = await supervisor.spawnOwned(payloadThatExits())
        await owned.exited
      }
      expect(readdirSync("/dev/fd").length).toBe(baseline)
    } finally {
      await supervisor.dispose()
    }
  })

  test("terminating twice signals once and yields one settlement", async () => {
    const scratch = fixture("owned-idempotent")
    const supervisor = createProcessSupervisor({ killGraceMs: 200 })

    try {
      const owned = await supervisor.spawnOwned([process.execPath, TARGET, scratch.file("payload-ran"), "--stubborn"])
      scratch.guard(owned.pid)
      await scratch.waitForFile(scratch.file("payload-ran"))

      const [first, second] = await Promise.all([owned.terminate(), owned.terminate()])

      expect(second).toBe(first)
      expect(FORCED_END).toEqual({ code: first.code, signal: first.signal })
      expect(processAlive(owned.pid)).toBe(false)
    } finally {
      await supervisor.dispose()
    }
  }, 30_000)

  test.skipIf(process.platform === "win32")("a payload that exits on TERM settles once with TERM, not a forced end, and surrenders its container", async () => {
    // TERM reaches the payload through its process group, and the supervisor
    // reads its own copy of that TERM as part of the escalation it runs.
    const scratch = fixture("owned-term")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor({ killGraceMs: 10_000 })

    try {
      const owned = await supervisor.spawnOwned([process.execPath, TARGET, marker])
      scratch.guard(owned.pid)
      await scratch.waitForFile(marker)

      const [first, second] = await Promise.all([owned.terminate(), owned.terminate()])

      expect(second).toBe(first)
      expect(await owned.exited).toBe(first)
      expect(first).toEqual({ code: null, signal: "SIGTERM", statusOf: "payload", ownership: "surrendered" })
      expect(ownedProcessBackend.container(owned).populated()).toBe(false)
    } finally {
      await supervisor.dispose()
    }
  }, 30_000)

  test.skipIf(process.platform === "win32")("a payload that answers TERM with exit 0 settles once with that status, so the supervisor survived its own group TERM", async () => {
    // The group TERM reaches the supervisor too. Only a supervisor that read
    // its own copy as part of its escalation lives to report the payload's
    // exit 0; one that died of it would settle as a signal.
    const scratch = fixture("owned-graceful-term")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor({ killGraceMs: 10_000 })

    try {
      const owned = await supervisor.spawnOwned([process.execPath, TARGET, marker, "--graceful"])
      scratch.guard(owned.pid)
      await scratch.waitForFile(marker)

      const [first, second] = await Promise.all([owned.terminate(), owned.terminate()])

      expect(second).toBe(first)
      expect(await owned.exited).toBe(first)
      expect(first).toEqual({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" })
      expect(await Bun.file(`${marker}.term`).text()).toBe("term")
    } finally {
      await supervisor.dispose()
    }
  }, 30_000)

  test("a payload that exits first keeps ownership until the descendant holding its container is gone", async () => {
    const scratch = fixture("owned-root-exits")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor({ killGraceMs: 300 })

    try {
      const owned = await supervisor.spawnOwned([process.execPath, TARGET, marker, "--grandchild", "--exit"])
      scratch.guard(owned.pid)
      const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker, 15_000)))
      const grandchildPid = scratch.guard(Number(await scratch.waitForFile(`${marker}.grandchild`, 15_000)))
      await scratch.waitForGone(payloadPid, 15_000)

      // The payload is already gone and the descendant ignores SIGTERM, so the
      // settlement can only arrive after the escalation emptied the container.
      const settled = await owned.exited

      expect(processAlive(grandchildPid)).toBe(false)
      expect(settled).toEqual({ code: 7, signal: null, statusOf: "payload", ownership: "surrendered" })
      expect(processAlive(owned.pid)).toBe(false)
    } finally {
      await supervisor.dispose()
    }
  }, 30_000)

  test("a supervisor that dies abnormally surrenders its container only once the payload tree is gone", async () => {
    const scratch = fixture("owned-supervisor-crash")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor({ killGraceMs: 300 })

    try {
      const owned = await supervisor.spawnOwned([process.execPath, TARGET, marker, "--stubborn", "--grandchild"])
      scratch.guard(owned.pid)
      const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker, 15_000)))
      const grandchildPid = scratch.guard(Number(await scratch.waitForFile(`${marker}.grandchild`, 15_000)))

      // The supervisor dies without running its own escalation, which is what
      // a crash of it looks like. Its guardian watch dies with it, so nothing
      // inside the container is left to end the payload.
      process.kill(owned.pid, "SIGKILL")
      const settled = await owned.exited

      // Settlement is the container's emptiness, not its leader's exit: the
      // lease is released only after every member is gone.
      expect(ownedProcessBackend.container(owned).populated()).toBe(false)
      expect(settled.ownership).toBe("surrendered")
      await scratch.waitForGone(payloadPid, 5_000)
      await scratch.waitForGone(grandchildPid, 5_000)
    } finally {
      await supervisor.dispose()
    }
  }, 30_000)

  // An owner whose payload holds nothing to save, such as a project executor
  // that never reported ready, ends its containers at once. That end must
  // not wait for the container's supervisor, which under load can wait a
  // minute for the scheduler at its background priority.
  test("a scope that ends what it holds at once ends a container whose supervisor cannot run", async () => {
    const scratch = fixture("owned-end-at-once")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor({ killGraceMs: 300 })
    const scope = createLauncherScope(supervisor)

    try {
      const owned = await scope.spawnOwned([process.execPath, TARGET, marker, "--stubborn"])
      scratch.guard(owned.pid)
      const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker, 15_000)))
      suspendProcess(owned.pid)

      const started = performance.now()
      expect(await scope.close({ reason: "the test ends it at once" })).toEqual({ settled: true })

      expect(performance.now() - started).toBeLessThan(5_000)
      expect(processAlive(payloadPid)).toBe(false)
    } finally {
      await supervisor.dispose()
    }
  }, 30_000)

  // A project executor's container lets the processes its members start
  // leave it. The executor itself must still be held from its first
  // instruction: a supervisor that dies at any moment, before any owner can
  // act, takes the executor with it. An executor started outside its
  // container and put there afterwards outlived a supervisor that died in
  // between, and kept running with no owner.
  test.skipIf(process.platform !== "win32")("a payload whose container lets its children leave ends with its supervisor before any owner acts", async () => {
    const scratch = fixture("owned-breakaway-supervisor-crash")
    const marker = scratch.file("payload-ran")
    const supervisor = createProcessSupervisor({ killGraceMs: 300 })

    try {
      const owned = await supervisor.spawnOwned([process.execPath, TARGET, marker, "--stubborn"], { childrenBreakAway: true })
      scratch.guard(owned.pid)
      const payloadPid = scratch.guard(Number(await scratch.waitForFile(marker, 15_000)))
      expect(containerHolds(owned, payloadPid)).toBe(true)

      process.kill(owned.pid, "SIGKILL")
      // The wait blocks this process's event loop, so neither the launcher
      // scope nor anything else here can end the payload on its behalf.
      const deadline = Date.now() + 5_000
      while (processAlive(payloadPid) && Date.now() < deadline) Bun.sleepSync(25)

      expect(processAlive(payloadPid)).toBe(false)
    } finally {
      await supervisor.dispose()
    }
  }, 30_000)

  test("repeated spawn and terminate cycles leave no stray containers", async () => {
    const scratch = fixture("owned-soak")
    const supervisor = createProcessSupervisor({ killGraceMs: 200 })

    try {
      // Each cycle proves its own process lived and is gone before the next
      // spawn. Windows reuses the pid of a process that just exited, so pids
      // collected across cycles neither identify distinct processes nor stay
      // safe to probe later. Awaited rather than sampled: a container's last
      // member stays openable for a moment after the container is emptied.
      for (let cycle = 0; cycle < 15; cycle += 1) {
        const owned = await supervisor.spawnOwned(payloadThatRunsForever())
        expect(processAlive(scratch.guard(owned.pid))).toBe(true)
        await owned.terminate()
        await scratch.waitForGone(owned.pid, 10_000)
      }
    } finally {
      await supervisor.dispose()
    }
  }, 60_000)
})
