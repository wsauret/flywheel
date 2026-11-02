import { describe, expect, test } from "bun:test"
import { createRuntimeBackgroundProjectMap, createRuntimeBackgroundProjectOperations } from "../../../../src/orchestration/app-service/runtime-background-worker.js"

describe("runtime background Worker lifecycle", () => {
  test("isolates sibling projects and can release and reopen one", async () => {
    const opens: string[] = []
    const closes: string[] = []
    const projects = createRuntimeBackgroundProjectMap((projectRoot) => {
      opens.push(projectRoot)
      return { projectRoot, close: async () => { closes.push(projectRoot) } }
    })

    const a = projects.get("/project/a")
    const b = projects.get("/project/b")
    expect(a.projectRoot).toBe("/project/a")
    expect(b.projectRoot).toBe("/project/b")
    expect(projects.get("/project/a")).toBe(a)

    await projects.release("/project/a")
    expect(closes).toEqual(["/project/a"])
    expect(projects.get("/project/b")).toBe(b)
    expect(projects.get("/project/a")).not.toBe(a)
    expect(opens).toEqual(["/project/a", "/project/b", "/project/a"])

    await projects.dispose()
    await projects.dispose()
    expect(closes).toEqual(["/project/a", "/project/b", "/project/a"])
    expect(() => projects.get("/project/c")).toThrow("shutting down")
  })

  test("project release waits for an accepted non-FTS read and rejects later reads", async () => {
    const operations = createRuntimeBackgroundProjectOperations()
    const read = Promise.withResolvers<string>()
    const accepted = operations.run(() => read.promise)
    let disposed = false
    let cancelled = false
    const closing = operations.close(() => { cancelled = true }, async () => { disposed = true })

    await Promise.resolve()
    expect(cancelled).toBe(true)
    expect(disposed).toBe(false)
    await expect(operations.run(async () => "late")).rejects.toThrow("closing")
    read.resolve("settled")
    await expect(accepted).resolves.toBe("settled")
    await closing
    expect(disposed).toBe(true)
  })

  test("Worker disposal joins a project release already in progress", async () => {
    const heldClose = Promise.withResolvers<void>()
    let closeCalls = 0
    const projects = createRuntimeBackgroundProjectMap(() => ({
      async close() {
        closeCalls += 1
        await heldClose.promise
      },
    }))
    projects.get("/project")

    const release = projects.release("/project")
    await Promise.resolve()
    expect(closeCalls).toBe(1)
    let disposed = false
    const disposal = projects.dispose().then(() => { disposed = true })
    await Bun.sleep(1)
    expect(disposed).toBe(false)

    heldClose.resolve()
    await Promise.all([release, disposal])
    expect(closeCalls).toBe(1)
    await projects.release("/project")
    await projects.dispose()
    expect(() => projects.get("/later")).toThrow("shutting down")
  })
})
