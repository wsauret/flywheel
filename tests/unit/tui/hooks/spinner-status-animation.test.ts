import { describe, expect, it } from "bun:test"
import {
  advanceAnimation,
  buildStatus,
  initialAnimationState,
  statusEquals,
  type AnimationState,
} from "../../../../src/tui/hooks/spinner-status-animation.js"

const baseLive = {
  terminalWidth: 120,
  compacting: false,
  activeBackgroundProcessCount: 0,
}

describe("initialAnimationState", () => {
  it("snaps displayedChars and lastStreamingChars to the seed (mid-stream tab switch)", () => {
    const s = initialAnimationState(4000)
    expect(s.displayedChars).toBe(4000)
    expect(s.lastStreamingChars).toBe(4000)
  })

  it("anchors all three clocks to nowMs; a first advance 30ms later applies zero easing (dt<50)", () => {
    const T = 1_000_000
    const s = initialAnimationState(0, T)
    expect(s.lastSampledAt).toBe(T)
    expect(s.lastEaseAt).toBe(T)
    expect(s.lastTokenTime).toBe(T)

    // The activation frame snaps the easing clock to now and takes the raw
    // intensity directly, which is still 0 this early in the turn.
    const next = advanceAnimation(s, { activity: "thinking", realChars: 0, agentActive: true, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null }, T + 30)
    expect(next.lastEaseAt).toBe(T + 30)
    expect(next.easedThinkingIntensity).toBe(0)
  })
})

describe("advanceAnimation — thinking lifecycle", () => {
  it("thinking enter: prev 'waiting' -> 'thinking' sets thinkingStartedAt, clears completed", () => {
    const T = 5_000
    const prev: AnimationState = { ...initialAnimationState(0, 0), activity: "waiting" }
    const next = advanceAnimation(prev, { activity: "thinking", realChars: 0, agentActive: true, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null }, T)
    expect(next.thinkingStartedAt).toBe(T)
    expect(next.completedThinkingMs).toBeNull()
  })

  it("thinking exit: prev thinking, now 'generating' records completedThinkingMs and thinkingEndedAt", () => {
    const T0 = 2_000
    const prev: AnimationState = {
      ...initialAnimationState(0, 0),
      activity: "thinking",
      thinkingStartedAt: T0,
    }
    const next = advanceAnimation(prev, { activity: "generating", realChars: 0, agentActive: true, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null }, T0 + 8_000)
    expect(next.completedThinkingMs).toBe(8_000)
    expect(next.thinkingStartedAt).toBeNull()
    expect(next.thinkingEndedAt).toBe(T0 + 8_000)
  })

  it("ordering: thinking-exit runs before agent-inactive reset, so completedThinkingMs ends null", () => {
    const T0 = 2_000
    const prev: AnimationState = {
      ...initialAnimationState(0, 0),
      activity: "thinking",
      thinkingStartedAt: T0,
    }
    const next = advanceAnimation(prev, { activity: "generating", realChars: 0, agentActive: false, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null }, T0 + 8_000)
    expect(next.completedThinkingMs).toBeNull()
    expect(next.thinkingStartedAt).toBeNull()
    expect(next.thinkingEndedAt).toBeNull()
  })

  it("fade-window clears completedThinkingMs AND thinkingEndedAt together past 5000ms", () => {
    const ended = 10_000
    const prev: AnimationState = {
      ...initialAnimationState(0, 0),
      activity: "generating",
      completedThinkingMs: 8_000,
      thinkingEndedAt: ended,
    }
    const cleared = advanceAnimation(prev, { activity: "generating", realChars: 0, agentActive: true, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null }, ended + 5_001)
    expect(cleared.completedThinkingMs).toBeNull()
    expect(cleared.thinkingEndedAt).toBeNull()

    const retained = advanceAnimation(prev, { activity: "generating", realChars: 0, agentActive: true, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null }, ended + 4_999)
    expect(retained.completedThinkingMs).toBe(8_000)
    expect(retained.thinkingEndedAt).toBe(ended)
  })

})

describe("advanceAnimation — char smoothing", () => {
  const active = (displayed: number, realChars: number): AnimationState => {
    const next = advanceAnimation(
      { ...initialAnimationState(displayed, 0), activity: "generating", agentActive: true },
      { activity: "generating", realChars, agentActive: true, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null },
      100,
    )
    return next
  }

  it("gap 50 -> +3", () => {
    expect(active(0, 50).displayedChars).toBe(3)
  })

  it("gap 150 -> +23 (max(8, ceil(150*0.15)))", () => {
    expect(active(0, 150).displayedChars).toBe(23)
  })

  it("gap 500 -> +50", () => {
    expect(active(0, 500).displayedChars).toBe(50)
  })

  it("never exceeds realChars", () => {
    expect(active(0, 2).displayedChars).toBe(2)
  })

  it("realChars below displayed snaps down", () => {
    expect(active(100, 40).displayedChars).toBe(40)
  })
})

describe("advanceAnimation — stall tracking", () => {
  const stall = (
    activity: AnimationState["activity"],
    realChars: number,
    lastStreamingChars: number,
    nowMs: number,
    lastTokenTime = 0,
  ): AnimationState =>
    advanceAnimation(
      {
        ...initialAnimationState(realChars, 0),
        activity,
        agentActive: true,
        lastStreamingChars,
        lastTokenTime,
      },
      { activity, realChars, agentActive: true, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null },
      nowMs,
    )

  it("generating + unchanged chars 11s past lastTokenTime -> timeSinceLastToken 11000", () => {
    expect(stall("generating", 100, 100, 11_000).timeSinceLastToken).toBe(11_000)
  })

  it("thinking under same conditions resets to 0", () => {
    expect(stall("thinking", 100, 100, 11_000).timeSinceLastToken).toBe(0)
  })

  it("a char change resets timeSinceLastToken to 0", () => {
    const next = stall("generating", 200, 100, 11_000)
    expect(next.timeSinceLastToken).toBe(0)
    expect(next.lastStreamingChars).toBe(200)
  })

  it("starts a new raw activity neutral after generating has stalled", () => {
    const generating = { activity: "generating" as const, realChars: 0, agentActive: true, backgroundWaitActive: false, connectionState: "connected" as const, compacting: false, notice: null }
    let state = advanceAnimation(initialAnimationState(0, 0), generating, 0)
    for (let now = 50; now <= 30_000; now += 50) state = advanceAnimation(state, generating, now)
    expect(buildStatus(state, baseLive)).toMatchObject({ colorMode: "stalled", intensity: 1 })

    const waiting = { ...generating, activity: "waiting" as const }
    state = advanceAnimation(state, waiting, 30_001)
    expect(state.timeSinceLastToken).toBe(0)
    expect(state.lastTokenTime).toBe(30_001)
    expect(state.easedStallIntensity).toBe(0)
    expect(buildStatus(state, baseLive)).toMatchObject({ colorMode: "normal", intensity: 0 })
    state = advanceAnimation(state, waiting, 30_501)
    expect(buildStatus(state, baseLive)).toMatchObject({ verb: expect.stringContaining("Waiting"), colorMode: "normal", intensity: 0 })
    state = advanceAnimation(state, waiting, 40_001)
    expect(buildStatus(state, baseLive)?.colorMode).toBe("stalled")
  })
})

describe("advanceAnimation — idle-to-active transition", () => {
  it("resets the stall clock when the agent becomes active after a long idle gap", () => {
    // The animation tick is gated off while the agent is idle, so lastTokenTime
    // goes stale. Sending a message must not read that stale clock as a stall.
    const idle = advanceAnimation(
      initialAnimationState(0, 0),
      { activity: null, realChars: 0, agentActive: false, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null },
      1_000,
    )
    const sent = advanceAnimation(
      idle,
      { activity: "waiting", realChars: 0, agentActive: true, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null },
      301_000,
    )
    expect(sent.timeSinceLastToken).toBe(0)
    expect(sent.lastTokenTime).toBe(301_000)
    expect(sent.easedStallIntensity).toBe(0)
  })

  it("drops leftover easing intensities from the previous turn on activation", () => {
    const idle: AnimationState = {
      ...initialAnimationState(0, 0),
      easedStallIntensity: 1,
      easedThinkingIntensity: 1,
    }
    const sent = advanceAnimation(
      idle,
      { activity: "waiting", realChars: 0, agentActive: true, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null },
      301_000,
    )
    expect(sent.easedStallIntensity).toBe(0)
    expect(sent.easedThinkingIntensity).toBe(0)
  })
})

describe("advanceAnimation — agent-inactive reset is terminal for char smoothing", () => {
  it("inactive with realChars 4000 leaves displayedChars 0 and stamps streaming/token state", () => {
    const prev: AnimationState = {
      ...initialAnimationState(0, 0),
      activity: "generating",
      displayedChars: 0,
    }
    const next = advanceAnimation(prev, { activity: "generating", realChars: 4000, agentActive: false, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null }, 9_000)
    expect(next.displayedChars).toBe(0)
    expect(next.lastStreamingChars).toBe(4000)
    expect(next.lastTokenTime).toBe(9_000)
    expect(next.timeSinceLastToken).toBe(0)
  })
})

describe("advanceAnimation — easing clock (the approved behavior fix)", () => {
  const stalledInput = { activity: "generating" as const, realChars: 0, agentActive: true, backgroundWaitActive: false, connectionState: "connected" as const, compacting: false, notice: null }
  const stalled = (lastEaseAt: number): AnimationState => ({
    ...initialAnimationState(0, 0),
    activity: "generating",
    agentActive: true,
    lastTokenTime: -1_000_000,
    lastEaseAt,
  })

  it("rapid sub-50ms advances do not advance lastEaseAt; cumulative 50ms applies one step", () => {
    const a = advanceAnimation(stalled(0), stalledInput, 20)
    expect(a.lastEaseAt).toBe(0)
    expect(a.easedStallIntensity).toBe(0)
    const b = advanceAnimation(a, stalledInput, 40)
    expect(b.lastEaseAt).toBe(0)
    const c = advanceAnimation(b, stalledInput, 50)
    expect(c.lastEaseAt).toBe(50)
    expect(c.easedStallIntensity).toBeGreaterThan(0)
  })

  it("dt is capped at 200; a >200ms gap snaps lastEaseAt to nowMs to avoid catch-up bursts", () => {
    expect(advanceAnimation(stalled(0), stalledInput, 5_000).lastEaseAt).toBe(5_000)
  })
})

describe("buildStatus — connection precedence", () => {
  it("down -> Disconnected stalled intensity 1", () => {
    const s = { ...initialAnimationState(0, 0), connectionState: "down" as const }
    const status = buildStatus(s, baseLive)
    expect(status).toEqual({ verb: "Disconnected", segments: [], colorMode: "stalled", intensity: 1, indicator: "spinner" })
  })

  it("reconnecting between runners names no verb", () => {
    const s = { ...initialAnimationState(0, 0), connectionState: "reconnecting" as const }
    const status = buildStatus(s, baseLive)
    expect(status?.verb).not.toBe("Reconnecting")
  })

  it("retrying and connecting show distinct statuses", () => {
    const retrying = buildStatus({ ...initialAnimationState(0, 0), connectionState: "retrying" as const }, baseLive)
    const connecting = buildStatus({ ...initialAnimationState(0, 0), connectionState: "connecting" as const }, baseLive)
    expect(retrying).toMatchObject({ verb: "Retrying", colorMode: "stalled", segments: [] })
    expect(connecting).toMatchObject({ verb: "Connecting", colorMode: "normal", segments: [] })
  })
})

describe("buildStatus — no session controls", () => {
  // Resume is the prompt's ctrl+r hint and Interrupt is Escape; the status
  // line describes the session and presses nothing but the background list.
  const states = [
    { ...initialAnimationState(0, 0), agentActive: true, activity: "generating" as const },
    { ...initialAnimationState(400, 0), agentActive: true, activity: "generating" as const, timeSinceLastToken: 60_000 },
    { ...initialAnimationState(0, 0), agentActive: true, activity: "thinking" as const, thinkingStartedAt: 0, lastSampledAt: 40_000 },
    { ...initialAnimationState(0, 0), agentActive: false },
    { ...initialAnimationState(0, 0), agentActive: false, backgroundWaitActive: true },
  ]

  it("an interrupted, idle, or running session's status carries no pause or resume segment", () => {
    for (const state of states) {
      for (const activeBackgroundProcessCount of [0, 2]) {
        const segments = buildStatus(state, { ...baseLive, activeBackgroundProcessCount })?.segments ?? []
        expect(segments.every((segment) => segment.action === undefined || segment.action === "background")).toBe(true)
        expect(segments.map((segment) => segment.text)).not.toContain("pause")
        expect(segments.map((segment) => segment.text)).not.toContain("resume")
      }
    }
  })

  it("an interrupted session with no background work shows no status at all", () => {
    expect(buildStatus({ ...initialAnimationState(0, 0), agentActive: false }, baseLive)).toBeNull()
  })

  it("keeps the background process count as its one pressable segment", () => {
    const status = buildStatus({ ...initialAnimationState(0, 0), agentActive: false }, { ...baseLive, activeBackgroundProcessCount: 1 })
    expect(status?.segments).toEqual([{ text: "1 background process", colored: false, action: "background" }])
  })
})

describe("buildStatus — compaction and idle", () => {
  it("compacting with inactive agent -> Compacting verb, no segments", () => {
    const s = { ...initialAnimationState(0, 0), agentActive: false }
    const status = buildStatus(s, { ...baseLive, compacting: true })
    expect(status!.verb).toBe("Compacting")
    expect(status!.segments).toEqual([])
  })

  it("tool execution with inactive agent returns null", () => {
    const now = 9_000
    const realChars = 4_000
    const state = advanceAnimation(
      initialAnimationState(realChars, 0),
      { activity: "tool_executing", realChars, agentActive: false, backgroundWaitActive: false, connectionState: "connected", compacting: false, notice: null },
      now,
    )

    expect(buildStatus(state, baseLive)).toBeNull()
  })
})

describe("buildStatus — background processes", () => {
  it("retains the background-modal action on the visible process segment", () => {
    const status = buildStatus({ ...initialAnimationState(0, 0), agentActive: false }, {
      ...baseLive,
      activeBackgroundProcessCount: 2,
      terminalWidth: 80,
    })
    expect(status?.segments[0]).toEqual({ text: "2 background processes", colored: false, action: "background" })
  })
  it("adds persistent process metadata to active, idle, and parked status without changing Waiting precedence", () => {
    const active = { ...initialAnimationState(0, 0), agentActive: true, activity: "generating" as const }
    const idle = { ...initialAnimationState(0, 0), agentActive: false }
    const parked = { ...idle, backgroundWaitActive: true }
    const live = { ...baseLive, activeBackgroundProcessCount: 2 }

    expect(buildStatus(active, live)!.segments.map((segment) => segment.text)).toContain("2 background processes")
    expect(buildStatus(idle, live)).toMatchObject({ verb: expect.stringContaining("Idle"), indicator: "circle" })
    expect(buildStatus(parked, live)).toMatchObject({ verb: "Waiting", indicator: "spinner" })
    expect(buildStatus(parked, live)!.segments.map((segment) => segment.text)).toEqual(["2 background processes"])
  })

  it("shows active Waiting even before the process count arrives", () => {
    const parked = { ...initialAnimationState(0, 0), backgroundWaitActive: true }
    expect(buildStatus(parked, baseLive)).toEqual({ verb: "Waiting", segments: [], colorMode: "normal", intensity: 0, indicator: "spinner" })
  })

  it("names the session a parked wait is for in place of Waiting, and keeps its processes", () => {
    const parked = { ...initialAnimationState(0, 0), backgroundWaitActive: true }
    expect(buildStatus(parked, { ...baseLive, waitingOn: "Waiting on parent" })).toEqual({ verb: "Waiting on parent", segments: [], colorMode: "normal", intensity: 0, indicator: "spinner" })
    expect(buildStatus(parked, { ...baseLive, waitingOn: "Waiting on Spec review", activeBackgroundProcessCount: 1 })!.segments.map((segment) => segment.text)).toEqual(["1 background process"])
    // A turn that runs again shows its own activity, not the wait.
    expect(buildStatus({ ...initialAnimationState(0, 0), agentActive: true, activity: "generating" }, { ...baseLive, waitingOn: "Waiting on parent" })!.verb).toBe("Generating")
  })
})

describe("buildStatus — normal and thinking", () => {
  it("idle token metadata appears only after output has accumulated; waiting is visible", () => {
    const idle = buildStatus({ ...initialAnimationState(0, 0), agentActive: true, activity: null }, baseLive)
    const midTurn = buildStatus({ ...initialAnimationState(0, 0), agentActive: true, activity: null, displayedChars: 4000 }, baseLive)
    const waiting = buildStatus({ ...initialAnimationState(0, 0), agentActive: true, activity: "waiting", displayedChars: 4000 }, baseLive)
    expect(idle).toMatchObject({ verb: expect.stringContaining("Idle"), indicator: "circle", segments: [] })
    expect(midTurn).toMatchObject({ verb: expect.stringContaining("Idle"), indicator: "circle" })
    expect(midTurn!.segments.map((seg) => seg.text)).toEqual(["↓ 1.0k tokens"])
    expect(waiting).toMatchObject({ verb: expect.stringContaining("Waiting"), indicator: "spinner" })
    expect(waiting!.segments.map((seg) => seg.text)).toEqual(["↑ 1.0k tokens"])
  })

  it("generating with 4000 displayed chars -> Generating + 1000 tokens, normal", () => {
    const s = { ...initialAnimationState(0, 0), agentActive: true, activity: "generating" as const, displayedChars: 4000 }
    const status = buildStatus(s, baseLive)
    expect(status!.verb).toContain("Generating")
    expect(status!.segments.map((seg) => seg.text)).toEqual(["↓ 1.0k tokens"])
    expect(status!.colorMode).toBe("normal")
    const segmentFor = (estimatedTokens: number) => buildStatus({
      ...initialAnimationState(estimatedTokens * 4, 0),
      agentActive: true,
      activity: "generating" as const,
    }, { terminalWidth: 120, compacting: false, activeBackgroundProcessCount: 0 })?.segments[0]?.text
    expect(segmentFor(3_900)).toBe("↓ 3.9k tokens")
    expect(segmentFor(4_000)).toBe("↓ 4.0k tokens")
    expect(segmentFor(4_100)).toBe("↓ 4.1k tokens")
    expect(buildStatus({
      ...initialAnimationState(0, 0),
      agentActive: false,
      activity: "generating" as const,
      displayActivity: "generating" as const,
    }, { terminalWidth: 120, compacting: false, activeBackgroundProcessCount: 0 })).toBeNull()
  })

  it("thinking for over a minute with no streamed progress shows elapsed time before colored reassurance", () => {
    const s = {
      ...initialAnimationState(0, 0),
      agentActive: true,
      activity: "thinking" as const,
      thinkingStartedAt: 0,
      lastSampledAt: 61_000,
    }
    const status = buildStatus(s, baseLive)
    expect(status!.segments.map((seg) => seg.text)).toEqual(["for 1m 1s", "almost there"])
    expect(status!.segments[0]?.colored).toBe(false)
    expect(status!.segments[1]?.colored).toBe(true)
  })

  it("thinking with streamed progress keeps token metadata", () => {
    const thinking = {
      ...initialAnimationState(0, 0),
      agentActive: true,
      activity: "thinking" as const,
      thinkingStartedAt: 0,
      displayedChars: 4,
    }

    expect(buildStatus({ ...thinking, lastSampledAt: 9_999 }, baseLive)!.segments.map((seg) => seg.text)).toEqual(["↓ 1 tokens"])
    expect(buildStatus({ ...thinking, lastSampledAt: 10_000 }, baseLive)!.segments.map((seg) => seg.text)).toEqual(["for 10s", "↓ 1 tokens", "working on it"])
  })

  it("narrow thinking status keeps elapsed time before token metadata", () => {
    const status = buildStatus({
      ...initialAnimationState(0, 0),
      agentActive: true,
      activity: "thinking",
      thinkingStartedAt: 0,
      lastSampledAt: 61_000,
      displayedChars: 4000,
    }, { ...baseLive, terminalWidth: 25 })

    expect(status!.segments.map((seg) => seg.text)).toEqual(["for 1m 1s"])
  })

  it("completedThinkingMs shows 'thought for' only from 2 seconds onward", () => {
    const base = {
      ...initialAnimationState(0, 0),
      agentActive: true,
      activity: "generating" as const,
    }

    const exactThreshold = buildStatus({ ...base, completedThinkingMs: 2_000 }, baseLive)
    expect(exactThreshold!.segments.some((seg) => seg.text === "thought for 2s")).toBe(true)

    const justUnderThreshold = buildStatus({ ...base, completedThinkingMs: 1_999 }, baseLive)
    expect(justUnderThreshold!.segments.some((seg) => seg.text.startsWith("thought for"))).toBe(false)

    const subsecond = buildStatus({ ...base, completedThinkingMs: 800 }, baseLive)
    expect(subsecond!.segments.some((seg) => seg.text.startsWith("thought for"))).toBe(false)
  })

  it("stalled branch: timeSinceLastToken 11000 -> stalled, intensity from state, token segment", () => {
    const s = {
      ...initialAnimationState(0, 0),
      agentActive: true,
      activity: "generating" as const,
      displayedChars: 4000,
      timeSinceLastToken: 11_000,
      easedStallIntensity: 0.42,
    }
    const status = buildStatus(s, baseLive)
    expect(status!.colorMode).toBe("stalled")
    expect(status!.intensity).toBe(0.42)
    expect(status!.segments.map((seg) => seg.text)).toEqual(["↓ 1.0k tokens"])
  })
})

describe("buildStatus — width budget", () => {
  const generating = {
    ...initialAnimationState(0, 0),
    agentActive: true,
    activity: "generating" as const,
    displayedChars: 4000,
  }

  it("keeps the token segment when it fits without elapsed", () => {
    const status = buildStatus(generating, { ...baseLive, terminalWidth: 29 })
    expect(status!.segments.map((seg) => seg.text)).toEqual(["↓ 1.0k tokens"])
  })

  it("drops all segments when the token segment does not fit", () => {
    const status = buildStatus(generating, { ...baseLive, terminalWidth: 25 })
    expect(status!.segments).toEqual([])
  })
})

describe("statusEquals", () => {
  const a = { verb: "Generating", segments: [{ text: "2s", colored: false }], colorMode: "normal" as const, intensity: 0, indicator: "spinner" as const }

  it("null vs non-null is not equal", () => {
    expect(statusEquals(null, a)).toBe(false)
  })

  it("equal when verb/colorMode/intensity/segments match", () => {
    expect(statusEquals(a, { ...a, segments: [{ text: "2s", colored: false }] })).toBe(true)
  })

  it("strict intensity comparison (no epsilon)", () => {
    expect(statusEquals(a, { ...a, intensity: 0.0001 })).toBe(false)
  })

  it("differing segment text is not equal", () => {
    expect(statusEquals(a, { ...a, segments: [{ text: "3s", colored: false }] })).toBe(false)
  })

  it("differing segment colored flag is not equal", () => {
    expect(statusEquals(a, { ...a, segments: [{ text: "2s", colored: true }] })).toBe(false)
  })

  it("differing indicator is not equal", () => {
    expect(statusEquals(a, { ...a, indicator: "circle" })).toBe(false)
  })
})