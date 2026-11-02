import { describe, expect, test } from "bun:test"
import { createProfileRuntimeStateOwner } from "../../../../src/orchestration/app-service/profile-runtime-state.js"

describe("profile runtime state owner", () => {
  test("coalesces preparation per profile and rejects stale publication", async () => {
    let prepareCalls = 0
    let releaseOld: (() => void) | undefined
    const oldReady = new Promise<void>((resolve) => { releaseOld = resolve })
    const published: string[] = []
    const owner = createProfileRuntimeStateOwner<string>({ publish: (state) => { published.push(`${state.profileId}:${state.snapshot}`) } })

    const old = owner.prepare("work", async () => {
      prepareCalls += 1
      await oldReady
      return "old"
    })
    const duplicate = owner.prepare("work", async () => {
      prepareCalls += 1
      return "duplicate"
    })
    expect(duplicate).toBe(old)

    const newer = owner.create("work", () => "new")
    expect(owner.publish(newer)).toBe(true)
    releaseOld?.()
    expect((await old).snapshot).toBe("old")
    expect(prepareCalls).toBe(1)
    expect(owner.current("work")?.snapshot).toBe("new")
    expect(published).toEqual(["work:new"])
  })

  test("publishes independent profiles regardless of cross-profile completion order", () => {
    const published: string[] = []
    const owner = createProfileRuntimeStateOwner<string>({ publish: (state) => { published.push(`${state.profileId}:${state.snapshot}`) } })
    const work = owner.create("work", () => "work-state")
    const personal = owner.create("personal", () => "personal-state")

    expect(owner.publish(personal)).toBe(true)
    expect(owner.publish(work)).toBe(true)
    expect(owner.current("work")?.snapshot).toBe("work-state")
    expect(owner.current("personal")?.snapshot).toBe("personal-state")
    expect(owner.current()?.snapshot).toBe("personal-state")
    expect(published).toEqual(["personal:personal-state", "work:work-state"])
  })

  test("disposal clears snapshots and rejects later preparation", async () => {
    const owner = createProfileRuntimeStateOwner<string>()
    const snapshot = owner.create("work", () => "value")
    expect(owner.publish(snapshot)).toBe(true)
    await owner.dispose()

    expect(owner.current("work")).toBeUndefined()
    await expect(owner.prepare("work", async () => "after-dispose")).rejects.toThrow("disposed")
  })
})
