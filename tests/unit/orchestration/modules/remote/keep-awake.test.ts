import { describe, expect, test } from "bun:test"

import { createKeepAwake, type KeepAwakeInput } from "../../../../../src/orchestration/modules/remote/keep-awake.js"

/** The idle-sleep inhibitor on each platform: one owned process on macOS and
 *  Linux that ends with the release, the execution-state flag on Windows, and
 *  a hold that cannot be taken costing nothing but a log line. */

function fakeSpawn(behavior: { readonly fail?: boolean } = {}) {
  const launched: string[][] = []
  const terminated: string[][] = []
  const spawnOwned: KeepAwakeInput["spawnOwned"] = async (command) => {
    if (behavior.fail) throw new Error("caffeinate: not found")
    launched.push([...command])
    return {
      terminate: async () => {
        terminated.push([...command])
        return { code: 0, signal: null, statusOf: "payload" as const, ownership: "surrendered" as const }
      },
    }
  }
  return { spawnOwned, launched, terminated }
}

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

  test("a hold that cannot be taken is not an error", async () => {
    const spawn = fakeSpawn({ fail: true })
    const keepAwake = createKeepAwake({ platform: "darwin", spawnOwned: spawn.spawnOwned })
    await keepAwake.hold()
    await keepAwake.release()
    expect(spawn.terminated).toEqual([])
  })
})
