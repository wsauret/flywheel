import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"

import { createCliLauncher, guardianCommand } from "../../../src/cli/runtime-launch.js"
import { serveOwnedProcessBridge } from "../../../src/infra/owned-process-bridge.js"
import { ownedProcessBackend } from "../../../src/infra/owned-subprocess-backend.js"
import { createRealProcessFixture, processAlive, type RealProcessFixture } from "../../helpers/real-process-fixture.js"
import { payloadThatRunsForever } from "../../helpers/payload.js"

/** Ownership of what a command launches, proved against real containers and
 *  the real guardian. The guardian here is this CLI's own entry re-entered
 *  with its internal role, so these tests also prove that re-entry: a broken
 *  role would never reach readiness and every launch below would fail. */

const fixtures: RealProcessFixture[] = []

/** The report `owned-process-bridge-worker.ts` posts for its launch. */
const decodeWorkerReport = Schema.decodeUnknownSync(Schema.Struct({
  kind: Schema.String,
  pid: Schema.optionalKey(Schema.Number),
  token: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
}))

function fixture(name: string): RealProcessFixture {
  const created = createRealProcessFixture(name)
  fixtures.push(created)
  return created
}

afterEach(() => {
  for (const created of fixtures.splice(0)) created.cleanup()
})

describe("the command launcher context", () => {
  test("this CLI entry serves the guardian role it spawns itself as", async () => {
    const command = guardianCommand()
    const scratch = fixture("generation-guardian")
    const launcher = await createCliLauncher()

    try {
      const owned = await launcher.scope.spawnOwned(payloadThatRunsForever())
      scratch.guard(owned.pid)

      expect(command.at(-1)).toBe("--internal-role=guardian")
      expect(processAlive(owned.pid)).toBe(true)
    } finally {
      await launcher.dispose()
    }
  }, 30_000)

  test("closing the context ends every container its generations still hold", async () => {
    const scratch = fixture("generation-context-close")
    const launcher = await createCliLauncher()
    const generation = launcher.scope.open()

    const direct = await launcher.scope.spawnOwned(payloadThatRunsForever())
    const nested = await generation.spawnOwned(payloadThatRunsForever())
    scratch.guard(direct.pid)
    scratch.guard(nested.pid)

    await launcher.dispose()
    await scratch.waitForGone(direct.pid, 15_000)
    await scratch.waitForGone(nested.pid, 15_000)

    expect(processAlive(direct.pid)).toBe(false)
    expect(processAlive(nested.pid)).toBe(false)
  }, 30_000)
})

describe("runtime generation ownership", () => {
  test("a generation surrenders its containers when it closes, and its replacement launches into a live context", async () => {
    const scratch = fixture("generation-replacement")
    const launcher = await createCliLauncher()

    try {
      const replaced = launcher.scope.open()
      const held = await replaced.spawnOwned(payloadThatRunsForever())
      scratch.guard(held.pid)

      // Close is the whole settlement: it resolves only once the containers the
      // generation held have settled, which is what makes it safe to hand the
      // project to the next generation.
      await replaced.close()

      expect(processAlive(held.pid)).toBe(false)

      const replacement = launcher.scope.open()
      const admitted = await replacement.spawnOwned(payloadThatRunsForever())
      scratch.guard(admitted.pid)

      expect(processAlive(admitted.pid)).toBe(true)
    } finally {
      await launcher.dispose()
    }
  }, 30_000)

  test("a dead generation admits nothing and cannot mutate its replacement into an owner", async () => {
    const launcher = await createCliLauncher()

    try {
      const dead = launcher.scope.open()
      await dead.close()

      await expect(dead.spawnOwned(payloadThatRunsForever())).rejects.toThrow("launcher scope is closed")
      await expect(dead.open().spawnOwned(payloadThatRunsForever())).rejects.toThrow("launcher scope is closed")
    } finally {
      await launcher.dispose()
    }
  }, 30_000)

  test("closing one generation leaves the containers of its siblings alone", async () => {
    const scratch = fixture("generation-sibling")
    const launcher = await createCliLauncher()

    try {
      const first = launcher.scope.open()
      const second = launcher.scope.open()
      const ending = await first.spawnOwned(payloadThatRunsForever())
      const surviving = await second.spawnOwned(payloadThatRunsForever())
      scratch.guard(ending.pid)
      scratch.guard(surviving.pid)

      await first.close()

      expect(processAlive(ending.pid)).toBe(false)
      expect(processAlive(surviving.pid)).toBe(true)
    } finally {
      await launcher.dispose()
    }
  }, 30_000)

  test("a live Worker acknowledges generation termination only after its owned container settles", async () => {
    const scratch = fixture("generation-worker-bridge")
    const launcher = await createCliLauncher()
    // A command's stdio cannot cross a thread boundary, so the Worker launches
    // its own containers and records ownership with this process's guardian
    // over the transferred port. Closing the generation is the only way those
    // containers end.
    const worker = new Worker(new URL("../../helpers/owned-process-bridge-worker.ts", import.meta.url).href)
    const ownership = new MessageChannel()
    const generation = serveOwnedProcessBridge({ port: ownership.port1, guardian: launcher.guardian })

    try {
      const launched = new Promise<unknown>((resolve) => {
        worker.addEventListener("message", (event: MessageEvent) => { resolve(event.data) }, { once: true })
      }).then(decodeWorkerReport)
      const workerEnded = new Promise<void>((resolve) => {
        worker.addEventListener("message", (event: MessageEvent) => {
          const value: unknown = event.data
          if (typeof value === "object" && value !== null && "kind" in value && value.kind === "ended") resolve()
        })
      })
      worker.postMessage({ ownership: ownership.port2, command: payloadThatRunsForever() }, [ownership.port2])
      const result = await launched
      expect(result.kind).toBe("launched")
      const pid = result.pid ?? 0
      scratch.guard(pid)
      expect(processAlive(pid)).toBe(true)

      const normalClose = Promise.all([generation.close(), workerEnded])
      const guardianFallbackGuard = Bun.sleep(12_000).then(() => { throw new Error("live Worker close reached the guardian fallback window") })
      await Promise.race([normalClose, guardianFallbackGuard])
      await scratch.waitForGone(pid, 5_000)
      expect(processAlive(pid)).toBe(false)
    } finally {
      worker.terminate()
      await launcher.dispose()
    }
  }, 60_000)

  test("a dead Worker's guardian fallback ends the container it launched", async () => {
    const scratch = fixture("generation-dead-worker")
    const launcher = await createCliLauncher()
    const worker = new Worker(new URL("../../helpers/owned-process-bridge-worker.ts", import.meta.url).href)
    const ownership = new MessageChannel()
    const generation = serveOwnedProcessBridge({ port: ownership.port1, guardian: launcher.guardian, closeDeadlineMs: 2_000 })

    try {
      const launched = new Promise<unknown>((resolve) => {
        worker.addEventListener("message", (event: MessageEvent) => { resolve(event.data) }, { once: true })
      }).then(decodeWorkerReport)
      worker.postMessage({ ownership: ownership.port2, command: payloadThatRunsForever() }, [ownership.port2])
      const result = await launched
      expect(result.kind).toBe("launched")
      const pid = result.pid ?? 0
      const token = result.token ?? ""
      scratch.guard(pid)

      // The thread is gone, so nothing on that side can settle the container it
      // launched, and nothing is left to reap the container leader either: its
      // pid stays in the table as an unreaped exit. The guardian holds the
      // lease, so closing the generation is what ends the container, and an
      // empty container is what proves it ended.
      worker.terminate()
      expect(await generation.close()).toEqual({ settled: true })

      expect(ownedProcessBackend.container({ pid, token }).populated()).toBe(false)
    } finally {
      await launcher.dispose()
    }
  }, 60_000)
})
