import { afterEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Database } from "bun:sqlite"

import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store"
import type { EventStore } from "../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../src/infra/paths"
import { withEventStore } from "../../../src/infra/with-event-store"

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-with-event-store-"))
  tmpDirs.push(dir)
  return dir
}

function appendFact(store: EventStore, type: string): void {
  store.append({
    aggregateId: "session:with-store",
    type,
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: "with-store",
    payload: {},
  })
}

describe("withEventStore", () => {
  test("closes the store after a successful synchronous callback", () => {
    const baseDir = makeTmpDir()
    const originalClose = Database.prototype.close
    let closeCount = 0
    Database.prototype.close = function close(this: Database): void {
      closeCount++
      originalClose.call(this)
    }

    let result = ""
    try {
      result = withEventStore(baseDir, (store) => {
        appendFact(store, "fact.recorded")
        return "ok"
      })
    } finally {
      Database.prototype.close = originalClose
    }

    expect(result).toBe("ok")
    expect(closeCount).toBe(1)

    const reopened = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    try {
      expect(reopened.read({ aggregateId: "session:with-store" }).map((event) => event.type)).toEqual(["fact.recorded"])
    } finally {
      reopened.close()
    }
  })

  test("rethrows callback errors and still closes the store", () => {
    const baseDir = makeTmpDir()
    const original = new Error("boom")
    const originalClose = Database.prototype.close
    let closeCount = 0
    Database.prototype.close = function close(this: Database): void {
      closeCount++
      originalClose.call(this)
    }

    let caught: unknown
    try {
      withEventStore(baseDir, (store) => {
        appendFact(store, "fact.before-error")
        throw original
      })
    } catch (err) {
      caught = err
    } finally {
      Database.prototype.close = originalClose
    }

    expect(caught).toBe(original)
    expect(closeCount).toBe(1)

    const reopened = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
    try {
      expect(reopened.read({ aggregateId: "session:with-store" }).map((event) => event.type)).toEqual(["fact.before-error"])
    } finally {
      reopened.close()
    }
  })
})
