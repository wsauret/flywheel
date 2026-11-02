import { describe, expect, test } from "bun:test"

import {
  DeadlineExceeded,
  withDeadline,
} from "../../../src/infra/with-deadline.js"

// A manually-fired timer stands in for setTimeout so a test never sleeps: the
// helper takes the timer factory as a parameter and the test decides exactly
// when the deadline elapses.
function manualTimer() {
  let pending: (() => void) | null = null
  return {
    schedule: (fire: () => void) => { pending = fire; return () => { pending = null } },
    fire: () => { pending?.() },
  }
}

describe("withDeadline", () => {
  test("resolves with the inner value when it settles before the timer fires", async () => {
    const timer = manualTimer()
    const result = await withDeadline(Promise.resolve("ok"), 5, { setTimer: timer.schedule })
    expect(result).toBe("ok")
  })

  test("rejects with DeadlineExceeded when the timer fires first; the inner promise's later settlement does not double-settle", async () => {
    const timer = manualTimer()
    let resolveInner!: (value: string) => void
    const inner = new Promise<string>((resolve) => { resolveInner = resolve })

    const raced = withDeadline(inner, 5, { setTimer: timer.schedule })
    timer.fire()

    await expect(raced).rejects.toBeInstanceOf(DeadlineExceeded)

    // The loser settling afterward must not throw an unhandled rejection or
    // re-settle the already-rejected promise.
    let secondSettle = "untouched"
    raced.then(() => { secondSettle = "resolved" }, () => { secondSettle = "rejected-again" })
    resolveInner("late")
    await Bun.sleep(1)
    expect(secondSettle).toBe("rejected-again")
  })

  test("clears the timer when the inner promise wins so no stray callback fires", async () => {
    let cleared = false
    const setTimer = (_fire: () => void) => () => { cleared = true }
    await withDeadline(Promise.resolve("done"), 5, { setTimer })
    expect(cleared).toBe(true)
  })

})
