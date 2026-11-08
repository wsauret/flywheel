import { describe, expect, test } from "bun:test"

import { createKeepAwake, type KeepAwakeInput } from "../../../../../src/orchestration/modules/remote/keep-awake.js"

/** The idle-sleep inhibitor on each platform: one owned process on macOS and
 *  Linux that ends with the release and starts again a bounded number of
 *  times when it ends on its own, the execution-state flag on Windows, and a
 *  hold that cannot be taken costing nothing but log lines. */

const EXIT = { code: 0, signal: null, statusOf: "payload" as const, ownership: "surrendered" as const }

/** Owned processes that end on terminate, on `end(index)`, or at once when the
 *  command cannot hold (`endsAtOnce`). `fail` rejects that many spawns first. */
function fakeSpawn(behavior: { readonly fail?: number; readonly endsAtOnce?: boolean } = {}) {
  const launched: string[][] = []
  const terminated: string[][] = []
  const ends: Array<(exit: typeof EXIT) => void> = []
  let failures = behavior.fail ?? 0
  const spawnOwned: KeepAwakeInput["spawnOwned"] = async (command) => {
    if (failures > 0) {
      failures -= 1
      throw new Error("caffeinate: not found")
    }
    launched.push([...command])
    const exited = Promise.withResolvers<typeof EXIT>()
    ends.push(exited.resolve)
    if (behavior.endsAtOnce) exited.resolve({ ...EXIT, code: 127 })
    return {
      exited: exited.promise,
      terminate: async () => {
        terminated.push([...command])
        exited.resolve(EXIT)
        return EXIT
      },
    }
  }
  return { spawnOwned, launched, terminated, end: (index: number) => ends[index]!({ ...EXIT, code: 127 }) }
}

/** Timers that fire only when the test says so. */
function fakeTimers() {
  const pending: Array<{ readonly fire: () => void; readonly delayMs: number }> = []
  const setTimer: NonNullable<KeepAwakeInput["setTimer"]> = (fire, delayMs) => {
    const timer = { fire, delayMs }
    pending.push(timer)
    return () => {
      pending.splice(pending.indexOf(timer), 1)
    }
  }
  const fireNext = async (): Promise<number> => {
    const timer = pending.shift()
    if (timer === undefined) throw new Error("no timer pending")
    timer.fire()
    await flush()
    return timer.delayMs
  }
  return { setTimer, pending, fireNext }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe("keep awake", () => {
  test("macOS holds caffeinate for the length of the hold, once", async () => {
    const spawn = fakeSpawn()
    const keepAwake = createKeepAwake({ platform: "darwin", spawnOwned: spawn.spawnOwned })
    await keepAwake.hold()
    await keepAwake.hold()
    expect(spawn.launched).toEqual([["caffeinate", "-i"]])
    await keepAwake.release()
    await keepAwake.release()
    expect(spawn.terminated).toEqual([["caffeinate", "-i"]])
  })

  test("Linux holds a systemd idle inhibitor", async () => {
    const spawn = fakeSpawn()
    const keepAwake = createKeepAwake({ platform: "linux", spawnOwned: spawn.spawnOwned })
    await keepAwake.hold()
    expect(spawn.launched[0]?.slice(0, 2)).toEqual(["systemd-inhibit", "--what=idle"])
    expect(spawn.launched[0]).toContain("--mode=block")
    await keepAwake.release()
    expect(spawn.terminated.length).toBe(1)
  })

  test("Windows sets and clears the execution state", async () => {
    const calls: string[] = []
    const keepAwake = createKeepAwake({ platform: "win32", spawnOwned: fakeSpawn().spawnOwned, windowsApi: () => ({ keepSystemAwake: () => { calls.push("awake"); return true }, allowSleep: () => { calls.push("sleep"); return true } }) })
    await keepAwake.hold()
    await keepAwake.hold()
    await keepAwake.release()
    await keepAwake.release()
    expect(calls).toEqual(["awake", "sleep"])
  })

  test("a hold that cannot be taken is not an error, and it starts again after a wait", async () => {
    const spawn = fakeSpawn({ fail: 1 })
    const timers = fakeTimers()
    const keepAwake = createKeepAwake({ platform: "darwin", spawnOwned: spawn.spawnOwned, setTimer: timers.setTimer })
    await keepAwake.hold()
    expect(spawn.launched).toEqual([])
    await timers.fireNext()
    expect(spawn.launched).toEqual([["caffeinate", "-i"]])
    await keepAwake.release()
    expect(spawn.terminated).toEqual([["caffeinate", "-i"]])
  })

  test("an inhibitor that ends right after it started starts again with no further hold", async () => {
    let clock = 0
    const spawn = fakeSpawn()
    const timers = fakeTimers()
    const keepAwake = createKeepAwake({ platform: "darwin", spawnOwned: spawn.spawnOwned, now: () => clock, setTimer: timers.setTimer })
    await keepAwake.hold()
    clock += 5_000
    spawn.end(0)
    await flush()
    expect(spawn.launched.length).toBe(1)
    expect(await timers.fireNext()).toBe(1_000)
    expect(spawn.launched.length).toBe(2)
    await keepAwake.release()
    expect(spawn.terminated.length).toBe(1)
  })

  test("a command that cannot hold stops after a bounded number of starts, and the next hold tries again", async () => {
    const spawn = fakeSpawn({ endsAtOnce: true })
    const timers = fakeTimers()
    const keepAwake = createKeepAwake({ platform: "linux", spawnOwned: spawn.spawnOwned, now: () => 0, setTimer: timers.setTimer })
    await keepAwake.hold()
    await flush()
    const delays: number[] = []
    while (timers.pending.length > 0) delays.push(await timers.fireNext())
    expect(delays).toEqual([1_000, 10_000, 60_000])
    expect(spawn.launched.length).toBe(4)
    await keepAwake.hold()
    await flush()
    expect(spawn.launched.length).toBe(5)
    await keepAwake.release()
    expect(timers.pending).toEqual([])
  })

  test("an inhibitor that ends after it held starts again by itself", async () => {
    let clock = 0
    const spawn = fakeSpawn()
    const timers = fakeTimers()
    const keepAwake = createKeepAwake({ platform: "darwin", spawnOwned: spawn.spawnOwned, now: () => clock, setTimer: timers.setTimer })
    await keepAwake.hold()
    // Two early ends, then a long hold: the long hold resets the failure count.
    spawn.end(0)
    await flush()
    await timers.fireNext()
    spawn.end(1)
    await flush()
    expect(await timers.fireNext()).toBe(10_000)
    clock += 10 * 60_000
    spawn.end(2)
    await flush()
    expect(await timers.fireNext()).toBe(1_000)
    expect(spawn.launched.length).toBe(4)
    await keepAwake.release()
    expect(spawn.terminated.length).toBe(1)
  })

  test("a release while a start again waits cancels it", async () => {
    const spawn = fakeSpawn()
    const timers = fakeTimers()
    const keepAwake = createKeepAwake({ platform: "darwin", spawnOwned: spawn.spawnOwned, now: () => 0, setTimer: timers.setTimer })
    await keepAwake.hold()
    spawn.end(0)
    await flush()
    expect(timers.pending.length).toBe(1)
    await keepAwake.release()
    expect(timers.pending).toEqual([])
    expect(spawn.launched.length).toBe(1)
  })

  test("a release during the start ends the inhibitor before it returns", async () => {
    const spawn = fakeSpawn()
    const keepAwake = createKeepAwake({ platform: "darwin", spawnOwned: spawn.spawnOwned })
    const holding = keepAwake.hold()
    await keepAwake.release()
    expect(spawn.terminated).toEqual([["caffeinate", "-i"]])
    await holding
    await flush()
    expect(spawn.launched.length).toBe(1)
  })
})
