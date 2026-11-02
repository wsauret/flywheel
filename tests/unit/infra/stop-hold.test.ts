import { afterEach, describe, expect, setSystemTime, test } from "bun:test"
import * as fs from "node:fs"
import { join } from "node:path"

import { emptyContainers, type ManagedContainer } from "../../../src/infra/process-container.js"
import { waitForStopHolds, type StopHold } from "../../../src/infra/stop-hold.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const GRACE_MS = 5_000

describe("container stop hold", () => {
  const temporaryDirectory = temporaryDirectories()

  afterEach(() => {
    setSystemTime()
  })

  /** A hold file that exists until the test removes it. */
  function holdFile(boundMs: number) {
    const path = join(temporaryDirectory("stop-hold-"), ".oauth_refresh.lock")
    fs.writeFileSync(path, "")
    const hold: StopHold = { path, boundMs }
    return { hold, release: () => { fs.rmSync(path, { force: true }) } }
  }

  /** A virtual clock: the hold and the grace are wall-clock reads, so each
   *  sleep moves the clock instead of waiting. */
  function virtualClock(onSleep: (elapsedMs: number) => void = () => {}) {
    const startedAt = Date.now()
    let now = startedAt
    setSystemTime(new Date(now))
    return {
      elapsed: () => now - startedAt,
      sleep: (ms: number): Promise<void> => {
        now += ms
        setSystemTime(new Date(now))
        onSleep(now - startedAt)
        return Promise.resolve()
      },
    }
  }

  test("sends no signal while a container's hold file exists, then gives the escalation its whole grace", async () => {
    const file = holdFile(35_000)
    const signalledAt: Array<{ readonly signal: string; readonly atMs: number }> = []
    const clock = virtualClock((elapsedMs) => { if (elapsedMs >= 3_000) file.release() })
    const container: ManagedContainer = {
      signal: (signal) => { signalledAt.push({ signal, atMs: clock.elapsed() }) },
      populated: () => true,
      stopHold: file.hold,
    }

    const settlement = await emptyContainers([container], GRACE_MS, clock.sleep, { reason: "test" })

    expect(settlement).toEqual({ kind: "unsettled", remaining: 1 })
    expect(signalledAt.map(({ signal }) => signal)).toEqual(["SIGTERM", "SIGKILL"])
    expect(signalledAt[0]?.atMs).toBeGreaterThanOrEqual(3_000)
    expect(signalledAt[0]?.atMs).toBeLessThan(3_100)
    // The kill still waits the grace after the term the hold delayed.
    expect((signalledAt[1]?.atMs ?? 0) - (signalledAt[0]?.atMs ?? 0)).toBeGreaterThanOrEqual(GRACE_MS - 100)
  })

  test("delays only the containers that declared a hold", async () => {
    const file = holdFile(35_000)
    const termAt = new Map<string, number>()
    const clock = virtualClock((elapsedMs) => { if (elapsedMs >= 3_000) file.release() })
    const ending = (name: string, stopHold?: StopHold): ManagedContainer => ({
      signal: (signal) => { if (signal === "SIGTERM") termAt.set(name, clock.elapsed()) },
      populated: () => !termAt.has(name),
      ...(stopHold === undefined ? {} : { stopHold }),
    })

    const settlement = await emptyContainers([ending("tool"), ending("cli", file.hold)], GRACE_MS, clock.sleep, { reason: "test" })

    expect(settlement).toEqual({ kind: "empty" })
    expect(termAt.get("tool")).toBeLessThan(100)
    expect(termAt.get("cli")).toBeGreaterThanOrEqual(3_000)
  })

  // The decision names a hold only when one delayed it, so time that passes
  // while the check runs on a loaded machine is no hold.
  test("answers no wait when no hold stood, however long the check took", async () => {
    const file = holdFile(35_000)
    const clock = virtualClock()
    const slowEmpty = { stopHold: file.hold, populated: () => { void clock.sleep(5); return false } }

    expect(await waitForStopHolds([slowEmpty, { populated: () => true }], 200, clock.sleep)).toBe(0)
  })

  test("stops waiting for a hold file at the hold's bound", async () => {
    const file = holdFile(1_000)
    const signalledAt: number[] = []
    const clock = virtualClock()
    const container: ManagedContainer = {
      signal: (signal) => { if (signal === "SIGTERM") signalledAt.push(clock.elapsed()) },
      populated: () => signalledAt.length === 0,
      stopHold: file.hold,
    }

    expect(await emptyContainers([container], GRACE_MS, clock.sleep, { reason: "test" })).toEqual({ kind: "empty" })
    expect(signalledAt).toHaveLength(1)
    expect(signalledAt[0]).toBeGreaterThanOrEqual(1_000)
    expect(signalledAt[0]).toBeLessThan(1_100)
  })
})
