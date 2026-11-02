import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, spyOn } from "bun:test"
import { Database } from "bun:sqlite"
import { createRuntimeEventStore } from "../../../src/infra/sqlite-event-store.js"

const tempDirs: string[] = []

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "fw-runtime-cell-"))
  tempDirs.push(dir)
  return join(dir, "flywheel.sqlite")
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("runtime in-flight cell writer", () => {
  it("queues standalone in-flight puts and drops until the shared lane commits", async () => {
    const store = createRuntimeEventStore(tempDbPath())
    try {
      const put = store.putInFlight!("s1", "queued-input", "one", { text: "hello" })
      expect(store.readInFlight("s1", "queued-input")).toEqual([])
      expect(store.writerLane.snapshot().queuedEvents).toBe(1)
      await put
      expect(store.readInFlight("s1", "queued-input")).toMatchObject([{ key: "one", payload: { text: "hello" } }])
      const drop = store.dropInFlight!("s1", "queued-input", "one")
      expect(store.readInFlight("s1", "queued-input")).toHaveLength(1)
      expect(store.writerLane.snapshot().queuedEvents).toBe(1)
      await drop
      expect(store.readInFlight("s1", "queued-input")).toEqual([])
      expect(store.currentPosition()).toBe(0)
    } finally { await store.close() }
  })

  it("rejects a standalone cell acknowledgement when its transaction cannot commit", async () => {
    const exec = spyOn(Database.prototype, "exec")
    const store = createRuntimeEventStore(tempDbPath())
    const db = exec.mock.contexts[0]
    exec.mockRestore()
    if (!(db instanceof Database)) throw new Error("expected the runtime connection")
    const commit = spyOn(db.query("commit"), "run").mockImplementationOnce(() => { throw new Error("commit refused") })
    try {
      await expect(store.putInFlight!("s1", "queued-input", "one", { text: "hello" })).rejects.toThrow("commit refused")
      expect(store.readInFlight("s1", "queued-input")).toEqual([])
      expect(db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 })
    } finally {
      commit.mockRestore()
      await store.close()
    }
  })
})
