import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { DebugLog, type DebugLogRecordInput } from "../../../../src/infra/debug-log.js"
import { watchDefinitionRoots } from "../../../../src/orchestration/app-service/definition-root-watcher.js"
import { temporaryDirectories } from "../../../helpers/directories.js"

/** The part of node's watcher the watch uses, with no filesystem behind it. */
class FakeWatcher {
  on(): void {}
  unref(): void {}
  close(): void {}
}

/** A directory observer the test drives: one listener per root. */
function fakeDirectories() {
  const listeners = new Map<string, () => void>()
  return {
    watchDirectory(dir: string, listener: () => void) {
      listeners.set(dir, listener)
      return new FakeWatcher()
    },
    change(dir: string) { listeners.get(dir)?.() },
  }
}

const published = (revision: number) => ({ published: true, revision, skills: 3 })
const kept = { published: false, revision: 1, skills: 3 }

const temporaryDirectory = temporaryDirectories()
const root = () => temporaryDirectory("flywheel-skill-root-")

let records: DebugLogRecordInput[] = []
let recordSpy: ReturnType<typeof spyOn<typeof DebugLog, "record">> | undefined
beforeEach(() => {
  records = []
  recordSpy = spyOn(DebugLog, "record").mockImplementation((entry) => { records.push(entry) })
})
afterEach(() => { recordSpy?.mockRestore() })

describe("definition root watch", () => {
  test("loads nothing on its own: a bound target runs only after a change, and a published revision is recorded once", async () => {
    const directories = fakeDirectories()
    const dir = root()
    const watch = watchDefinitionRoots({ roots: [{ dir, owned: true }], debounceMs: 5, watchDirectory: directories.watchDirectory })
    let reloads = 0
    watch.bind({ reload: () => { reloads += 1; return reloads === 1 ? published(2) : kept } })
    await Bun.sleep(15)
    expect(reloads).toBe(0)
    directories.change(dir)
    directories.change(dir)
    directories.change(dir)
    await Bun.sleep(15)
    expect(reloads).toBe(1)
    // A kept revision is the registry's warning, not a published record.
    directories.change(dir)
    await Bun.sleep(15)
    expect(reloads).toBe(2)
    expect(records).toEqual([{ type: "definitions.revision.published", payload: { revision: 2, skills: 3, cause: "watch" } }])
    await watch.dispose()
  })

  test("a change observed before the target is bound runs it once, right after binding", async () => {
    const directories = fakeDirectories()
    const dir = root()
    const watch = watchDefinitionRoots({ roots: [{ dir, owned: true }], debounceMs: 5, watchDirectory: directories.watchDirectory })
    directories.change(dir)
    await Bun.sleep(15)
    const order: string[] = []
    watch.bind({
      beforeReload: () => { order.push("before") },
      reload: () => { order.push("reload"); return published(2) },
      onReloaded: () => { order.push("after") },
    })
    await Bun.sleep(15)
    expect(order).toEqual(["before", "reload", "after"])
    await watch.dispose()
  })

  test("reloadNow runs the target in order at once, folds a pending change into it, and records the write", async () => {
    const directories = fakeDirectories()
    const dir = root()
    const watch = watchDefinitionRoots({ roots: [{ dir, owned: true }], debounceMs: 10, watchDirectory: directories.watchDirectory })
    const order: string[] = []
    watch.bind({
      beforeReload: async () => { await Bun.sleep(1); order.push("before") },
      reload: () => { order.push("reload"); return published(4) },
      onReloaded: async () => { await Bun.sleep(1); order.push("after") },
    })
    directories.change(dir)
    expect(await watch.reloadNow()).toEqual(published(4))
    expect(order).toEqual(["before", "reload", "after"])
    await Bun.sleep(20)
    expect(order).toEqual(["before", "reload", "after"])
    expect(records).toEqual([{ type: "definitions.revision.published", payload: { revision: 4, skills: 3, cause: "write" } }])
    await watch.dispose()
  })

  test("disposal settles a reload in flight and runs no later one", async () => {
    const directories = fakeDirectories()
    const dir = root()
    const watch = watchDefinitionRoots({ roots: [{ dir, owned: true }], debounceMs: 5, watchDirectory: directories.watchDirectory })
    let reloads = 0
    watch.bind({ reload: () => { reloads += 1; return published(2) } })
    directories.change(dir)
    await watch.dispose()
    await Bun.sleep(15)
    expect(await watch.reloadNow()).toBeUndefined()
    expect(reloads).toBe(0)
    expect(() => watch.bind({ reload: () => kept })).toThrow("already bound")
  })
})
