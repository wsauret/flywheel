import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { LocalSqliteEventStore } from "../../../src/infra/event-store-types.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"

let tmpDir: string
let store: LocalSqliteEventStore

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "flywheel-txn-"))
  store = createSqliteEventStore(path.join(tmpDir, "flywheel.sqlite"))
})

afterEach(() => {
  store.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function appendFact(type: string, payload: { [key: string]: unknown } = {}) {
  return store.append({
    aggregateId: "session:txn",
    type,
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: "txn",
    payload,
  })
}

describe("EventStore.transaction", () => {
  test("rolls back all appends when callback throws", () => {
    expect(() =>
      store.transaction(() => {
        appendFact("a.one")
        appendFact("a.two")
        throw new Error("boom")
      }),
    ).toThrow("boom")

    expect(store.read({ aggregateId: "session:txn" })).toEqual([])
  })

  test("rolls back batch appends with the surrounding transaction", () => {
    expect(() =>
      store.transaction(() => {
        store.appendBatch([
          {
            aggregateId: "session:txn",
            type: "a.one",
            version: 1,
            timestamp: Date.now(),
            actor: "flywheel",
            sessionId: "txn",
            payload: {},
          },
          {
            aggregateId: "session:txn",
            type: "a.two",
            version: 1,
            timestamp: Date.now(),
            actor: "flywheel",
            sessionId: "txn",
            payload: {},
          },
        ])
        throw new Error("boom")
      }),
    ).toThrow("boom")

    expect(store.read({ aggregateId: "session:txn" })).toEqual([])
  })

  test("nested transaction calls throw (bun:sqlite does not nest BEGIN IMMEDIATE)", () => {
    expect(() =>
      store.transaction(() => {
        appendFact("a.one")
        store.transaction(() => {
          appendFact("a.two")
        })
      }),
    ).toThrow()

    expect(store.read({ aggregateId: "session:txn" })).toEqual([])
  })

})
