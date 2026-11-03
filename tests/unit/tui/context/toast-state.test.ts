import { describe, expect, it, jest, spyOn } from "bun:test"

import { createToastState } from "../../../../src/tui/context/toast.js"

describe("createToastState", () => {
  it("replaces a different toast immediately", () => {
    const toast = createToastState()
    toast.show({ message: "first", variant: "info", duration: 0 })
    toast.show({ message: "second", variant: "error", duration: 0 })

    expect(toast.current).toEqual({ message: "second", variant: "error" })
  })

  it("extends the remaining time instead of restarting an identical toast", () => {
    // The clock is faked, so a stall of a slow runner between the two shows
    // cannot use up the extended deadline before the check runs.
    jest.useFakeTimers()
    try {
      const toast = createToastState()
      toast.show({ message: "saved", variant: "info", duration: 24 })
      toast.show({ message: "saved", variant: "info", duration: 24 })

      jest.advanceTimersByTime(30)
      // Both the old clobber behavior and a plain restart would have expired by
      // now (24ms from the second show); the dedupe extension holds it to 48ms.
      expect(toast.current).toEqual({ message: "saved", variant: "info" })
      jest.advanceTimersByTime(18)
      expect(toast.current).toBeNull()
    } finally {
      jest.useRealTimers()
    }
  })

  it("keeps an error without a stated duration longer than a success", () => {
    const delays: number[] = []
    // A real handle, already cleared, stands in for each recorded timer.
    const inert = setTimeout(() => {}, 0)
    clearTimeout(inert)
    const setTimeoutSpy = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(globalThis.setTimeout, {
      apply(_target, _receiver, [, delay]: Parameters<typeof setTimeout>) {
        delays.push(delay ?? 0)
        return inert
      },
    }))
    try {
      const toast = createToastState()
      toast.show({ message: "saved", variant: "success" })
      toast.show({ message: "Show thinking update failed: the file is invalid", variant: "error" })
    } finally {
      setTimeoutSpy.mockRestore()
    }
    expect(delays).toEqual([3000, 8000])
  })

  it("treats a same-message different-variant toast as new", () => {
    const toast = createToastState()
    toast.show({ message: "saved", variant: "info", duration: 20 })
    toast.show({ message: "saved", variant: "error", duration: 0 })

    expect(toast.current).toEqual({ message: "saved", variant: "error" })
  })
})
