import { describe, expect, it } from "bun:test"
import {
  advanceAnimation,
  buildStatus,
  initialAnimationState,
} from "../../../../src/tui/hooks/spinner-status-animation.js"

const baseLive = {
  terminalWidth: 120,
  compacting: false,
  activeBackgroundProcessCount: 0,
}

const connected = "connected" as const

describe("spinner display activity smoothing", () => {
  it("holds a brief phase switch until it is confirmed and the current label has dwelled", () => {
    const first = advanceAnimation(initialAnimationState(0, 0), { activity: "waiting", realChars: 0, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 0)
    expect(first.displayActivity).toBe("waiting")

    const candidate = advanceAnimation(first, { activity: "thinking", realChars: 0, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 100)
    expect(candidate.displayActivity).toBe("waiting")
    expect(candidate.candidateActivity).toBe("thinking")
    expect(buildStatus(candidate, baseLive)?.verb).toContain("Waiting")

    const promoted = advanceAnimation(candidate, { activity: "thinking", realChars: 0, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 400)
    expect(promoted.displayActivity).toBe("thinking")
    expect(promoted.candidateActivity).toBeNull()
    expect(buildStatus(promoted, baseLive)?.verb).toContain("Thinking")
  })

  it("promotes generating immediately when new stream bytes arrive", () => {
    const thinking = advanceAnimation(initialAnimationState(0, 0), { activity: "thinking", realChars: 0, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 0)
    const generating = advanceAnimation(thinking, { activity: "generating", realChars: 12, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 100)

    expect(generating.displayActivity).toBe("generating")
    expect(buildStatus(generating, baseLive)?.verb).toContain("Generating")
  })

  it("keeps generating while smoothed tokens are still increasing after the raw phase clears", () => {
    const generating = advanceAnimation(initialAnimationState(0, 0), { activity: "generating", realChars: 500, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 0)
    const catchingUp = advanceAnimation(generating, { activity: null, realChars: 500, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 250)

    expect(catchingUp.displayedChars).toBeGreaterThan(generating.displayedChars)
    expect(catchingUp.displayActivity).toBe("generating")
    expect(buildStatus(catchingUp, baseLive)?.verb).toContain("Generating")

    let idle = catchingUp
    while (idle.displayedChars < 500) {
      idle = advanceAnimation(idle, { activity: null, realChars: 500, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, idle.lastSampledAt + 50)
    }
    idle = advanceAnimation(idle, { activity: null, realChars: 500, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, idle.lastSampledAt + 50)

    expect(idle.displayActivity).toBeNull()
    expect(buildStatus(idle, baseLive)?.verb).toContain("Idle")
  })

  it("clears the active label immediately when the runner goes inactive", () => {
    const generating = advanceAnimation(initialAnimationState(0, 0), { activity: "generating", realChars: 0, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 0)
    const cleared = advanceAnimation(generating, { activity: "generating", realChars: 0, agentActive: false, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 150)

    expect(cleared.displayActivity).toBeNull()
    expect(buildStatus(cleared, baseLive)).toBeNull()
  })

  it("anchors noisy switches with a hard max lag from the first mismatch", () => {
    let s = advanceAnimation(initialAnimationState(0, 0), { activity: "waiting", realChars: 0, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 0)
    s = advanceAnimation(s, { activity: "thinking", realChars: 0, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 100)
    s = advanceAnimation(s, { activity: "tool_executing", realChars: 0, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 200)
    s = advanceAnimation(s, { activity: "thinking", realChars: 0, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 300)
    s = advanceAnimation(s, { activity: "tool_executing", realChars: 0, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 400)
    expect(s.displayActivity).toBe("waiting")

    s = advanceAnimation(s, { activity: "thinking", realChars: 0, agentActive: true, backgroundWaitActive: false, compacting: false, notice: null, connectionState: connected }, 600)
    expect(s.displayActivity).toBe("thinking")
    expect(s.mismatchSince).toBeNull()
  })
})
