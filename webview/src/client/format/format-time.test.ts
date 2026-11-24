import assert from "node:assert/strict"
import { test } from "bun:test"
import { formatClock, formatClockParts } from "./format-time.js"

test("clock times use the reader's locale and prefix dates outside today", () => {
  const today = new Date(2026, 9, 11, 18).getTime()
  const started = new Date(2026, 9, 11, 16, 32).getTime()
  assert.equal(formatClock(started, "en-US", today), "4:32 PM")
  assert.equal(formatClock(started, "en-GB", today), "16:32")
  assert.equal(formatClock(new Date(2026, 9, 10, 16, 32).getTime(), "en-US", today), "Oct 10, 2026 · 4:32 PM")
  assert.equal(formatClock(new Date(2025, 9, 11, 16, 32).getTime(), "en-US", today), "Oct 11, 2025 · 4:32 PM")
  assert.deepEqual(formatClockParts(started, "en-US", today), { date: undefined, time: "4:32 PM" })
  assert.deepEqual(formatClockParts(new Date(2025, 8, 28, 12, 59).getTime(), "en-US", today), { date: "Sep 28, 2025", time: "12:59 PM" })
})
