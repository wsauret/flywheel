import { describe, expect, test } from "bun:test"

import { restoredScrollTop, saveReadingState, takeReadingState, type ReadingState } from "../../../../src/protocol/client/reading-state.js"

/** The reader's place across the one reload a new client build costs: kept in
 *  session storage under a version, read back once, and ignored when it does
 *  not read as this version. */

function memory(initial?: string) {
  const values = new Map<string, string>(initial === undefined ? [] : [["flywheel.client.reading-state", initial]])
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
    removeItem: (key: string) => { values.delete(key) },
    values,
  }
}

const place: ReadingState = { sessionId: "chat-1", following: false, top: { index: 28, offset: -12 }, open: ["tool-30", "tool-31#diff:path:src/a.ts"], closed: ["turnFold:text:answer"] }

describe("the reading state across a reload", () => {
  test("is read back once, under its version", () => {
    const storage = memory()
    saveReadingState(storage, place)
    expect(JSON.parse(storage.values.get("flywheel.client.reading-state")!)).toEqual({ v: 1, ...place })
    expect(takeReadingState(storage)).toEqual(place)
    expect(takeReadingState(storage)).toBeUndefined()
  })

  test("keeps a reader who was following the tail without a row", () => {
    const storage = memory()
    saveReadingState(storage, { sessionId: "chat-1", following: true, open: [] })
    expect(takeReadingState(storage)).toEqual({ sessionId: "chat-1", following: true, open: [] })
  })

  test("ignores a state of another version or one that does not read, and starts plain", () => {
    for (const stored of [JSON.stringify({ v: 2, ...place }), JSON.stringify({ v: 1, ...place, closed: "fold" }), JSON.stringify({ v: 1, ...place, closed: [3] }), JSON.stringify({ v: 1, ...place, open: "tool-30" }), JSON.stringify({ v: 1, ...place, top: { rowId: "row-28", offset: 0 } }), JSON.stringify({ v: 1, ...place, top: { index: -1, offset: 0 } }), JSON.stringify({ v: 1, following: false, open: [] }), "{", "null"]) {
      const storage = memory(stored)
      expect(takeReadingState(storage)).toBeUndefined()
      expect(storage.values.size).toBe(0)
    }
  })

  test("a storage that refuses is the same as an empty one", () => {
    const refusing = { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("blocked") }, removeItem: () => { throw new Error("blocked") } }
    expect(takeReadingState(refusing)).toBeUndefined()
    expect(() => saveReadingState(refusing, place)).not.toThrow()
    expect(takeReadingState(undefined)).toBeUndefined()
  })
})

describe("the restore scroll", () => {
  test("puts the saved row's top back at its saved offset from the transcript's top", () => {
    // The row is 400 px below the transcript's top edge now; it sat 12 px
    // above it when the page was left.
    expect(restoredScrollTop({ scrollTop: 1000, rowTop: 520, viewportTop: 120, offset: -12 })).toBe(1412)
    expect(restoredScrollTop({ scrollTop: 0, rowTop: 120, viewportTop: 120, offset: 0 })).toBe(0)
  })
})
