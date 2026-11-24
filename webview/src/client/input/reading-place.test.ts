import assert from "node:assert/strict"
import { test } from "node:test"

import { createReadingPlace } from "./reading-place.js"

function memoryStorage() {
  const items = new Map<string, string>()
  return {
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
  }
}

test("a reload with no transcript on screen still opens the session the page showed or was opening", () => {
  // A tapped notification's address, before the first attach, or a workflow's
  // card, which shows no transcript: a reload for a newer client keeps it.
  const storage = memoryStorage()
  createReadingPlace(storage).save("run-1")
  assert.deepEqual(createReadingPlace(storage).restored, { sessionId: "run-1", following: true, open: [] })
})

test("the transcript's own place wins over the shown session", () => {
  const storage = memoryStorage()
  const place = createReadingPlace(storage)
  place.track(() => ({ sessionId: "chat-1", following: false, top: { index: 4, offset: -2 }, open: ["k"] }))
  place.save("run-1")
  assert.deepEqual(createReadingPlace(storage).restored, { sessionId: "chat-1", following: false, top: { index: 4, offset: -2 }, open: ["k"] })
  place.save("run-1")
  const transferred = { sessionId: "chat-2", following: false, top: { index: 7, offset: -3 }, open: ["other"], closed: ["closed"] }
  const adopted = createReadingPlace(storage, transferred)
  assert.deepEqual(adopted.restored, transferred)
  assert.deepEqual(adopted.capture("chat-2"), transferred, "another mismatch before the transcript mounts retains its transferred reading place")
  assert.equal(createReadingPlace(storage).restored, undefined, "a transferred place also consumes the old reading-only checkpoint")
})
