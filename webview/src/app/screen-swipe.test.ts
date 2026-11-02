import { describe, expect, it } from "bun:test"

import { scrollerKeepsTouch, swipeAbandoned, swipeCommits, swipeDirectionOf, swipeProgress, swipeRecognized } from "./screen-swipe.js"

describe("swipeDirectionOf", () => {
  it("reads rightward as back and leftward as forward", () => {
    expect(swipeDirectionOf(12)).toBe("back")
    expect(swipeDirectionOf(-12)).toBe("forward")
  })
})

describe("swipeRecognized", () => {
  it("takes the touch once it moves clearly sideways, from anywhere", () => {
    expect(swipeRecognized(12, 3)).toBe(true)
    expect(swipeRecognized(-12, 3)).toBe(true)
    expect(swipeRecognized(6, 0)).toBe(false)
  })
  it("leaves a diagonal drag to the scroller", () => {
    expect(swipeRecognized(12, 8)).toBe(false)
    expect(swipeRecognized(30, 14)).toBe(true)
  })
})

describe("swipeAbandoned", () => {
  it("yields to a scroll and keeps waiting while the finger has not shown its hand", () => {
    expect(swipeAbandoned(2, 14)).toBe(true)
    expect(swipeAbandoned(14, 14)).toBe(true)
    expect(swipeAbandoned(4, 4)).toBe(false)
    expect(swipeAbandoned(8, 2)).toBe(false)
  })
})

describe("scrollerKeepsTouch", () => {
  const wide = { clientWidth: 300, scrollWidth: 900 }
  it("lets a code block pan while it still has room the way the swipe goes", () => {
    expect(scrollerKeepsTouch({ ...wide, scrollLeft: 0 }, "forward")).toBe(true)
    expect(scrollerKeepsTouch({ ...wide, scrollLeft: 600 }, "forward")).toBe(false)
    expect(scrollerKeepsTouch({ ...wide, scrollLeft: 0 }, "back")).toBe(false)
    expect(scrollerKeepsTouch({ ...wide, scrollLeft: 50 }, "back")).toBe(true)
  })
  it("never keeps the touch for content that does not scroll", () => {
    expect(scrollerKeepsTouch(undefined, "back")).toBe(false)
    expect(scrollerKeepsTouch({ scrollLeft: 0, clientWidth: 300, scrollWidth: 300 }, "forward")).toBe(false)
  })
})

describe("swipeProgress", () => {
  it("is travel along the swipe over the width, clamped to the screen", () => {
    expect(swipeProgress("back", 130, 390)).toBeCloseTo(1 / 3)
    expect(swipeProgress("forward", -195, 390)).toBeCloseTo(0.5)
    expect(swipeProgress("back", -50, 390)).toBe(0)
    expect(swipeProgress("back", 900, 390)).toBe(1)
    expect(swipeProgress("back", 50, 0)).toBe(0)
  })
})

describe("swipeCommits", () => {
  it("commits past a third of the width or on a quick flick along the swipe", () => {
    expect(swipeCommits(0.4, 0)).toBe(true)
    expect(swipeCommits(0.1, 0.6)).toBe(true)
    expect(swipeCommits(0.2, 0.1)).toBe(false)
  })
  it("does not commit a long drag that is flicking back", () => {
    expect(swipeCommits(0.6, -0.8)).toBe(false)
  })
})
