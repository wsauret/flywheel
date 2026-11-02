import { describe, it, expect, spyOn } from "bun:test"
import { createEffect, createRoot, createSignal, on } from "solid-js"
import { Log } from "../../../../src/infra/log"
import type { ConnectionState, StreamPhase } from "../../../../src/infra/output-blocks"
import type { SessionNotice } from "../../../../src/infra/session-notice"
import type { ActiveBackgroundCommandView, StatusView } from "../../../../src/protocol/status-protocol-types"
import { createSpinnerStatus, type SpinnerStatusSource } from "../../../../src/tui/hooks/create-spinner-status"

function statusView(overrides: Partial<StatusView> = {}): StatusView {
  return {
    activity: "idle",
    activityStartedAt: null,
    settledOutputPosition: null,
    connectionState: "connected",
    activeSubagentCount: 0,
    waitingOnBackgroundWork: false,
    replyWaits: [],
    activeBackgroundCommands: [],
    activeForegroundBashToolCallIds: [],
    processorHeldToolCallIds: [],
    startedAt: 0,
    streamingStartedAt: null,
    accumulatedActiveMs: 0,
    compactionStartedAt: null,
    ...overrides,
  }
}

function createDeps(overrides: {
  activity?: StreamPhase | null
  streamingChars?: number
  agentState?: "idle" | "active"
  tick?: number
  compactionStartedAt?: number | null
  terminalWidth?: number
  connectionState?: ConnectionState
  waitingOnBackgroundWork?: boolean
  replyWaits?: readonly { sessionId: string; name: string }[]
  parentSessionId?: string
  activeBackgroundCommands?: readonly ActiveBackgroundCommandView[]
} = {}) {
  const [tick, setTick] = createSignal(overrides.tick ?? 0)
  const [terminalWidth] = createSignal(overrides.terminalWidth ?? 120)
  const [activeBackgroundCommands, setActiveBackgroundCommands] = createSignal(overrides.activeBackgroundCommands ?? [])
  const [waitingOnBackgroundWork, setWaitingOnBackgroundWork] = createSignal(overrides.waitingOnBackgroundWork ?? false)
  const [compactionStartedAt, setCompactionStartedAt] = createSignal<number | null>(overrides.compactionStartedAt ?? null)
  const [notice, setNotice] = createSignal<SessionNotice | null>(null)
  const [connectionState, setConnectionState] = createSignal<ConnectionState>(overrides.connectionState ?? "connected")

  const source: SpinnerStatusSource = {
    status: () => statusView({
      activity: overrides.activity == null ? "idle" : overrides.activity === "tool_executing" ? "executing_tools" : overrides.activity,
      connectionState: connectionState(),
      activeBackgroundCommands: activeBackgroundCommands(),
      replyWaits: overrides.replyWaits ?? [],
    }),
    streamingOutputChars: () => overrides.streamingChars ?? 0,
    sessionId: createSignal<string | undefined>("session-a")[0],
    agentState: createSignal<"idle" | "active">(overrides.agentState ?? "idle")[0],
    waitingOnBackgroundWork,
    parentSessionId: () => overrides.parentSessionId,
    compactionStartedAt,
    notice,
  }

  return { source, terminalWidth, tick, setTick, setActiveBackgroundCommands, setWaitingOnBackgroundWork, setCompactionStartedAt, setNotice, setConnectionState }
}

function segmentTexts(s: { segments: { text: string }[] }): string[] {
  return s.segments.map((seg) => seg.text)
}

// Solid flushes effects on a microtask, so tests that advance through the
// hook's advance/compaction effects await one tick before reading status().
const flush = () => Promise.resolve()

// Opens a root and returns whatever the body returns — Solid passes the
// dispose into the body, so callers thread it into their result shape and read
// status() after awaiting the effect flush, then tear the root down.
function withRoot<T>(body: (dispose: () => void) => T): T {
  return createRoot(body)
}

describe("spinner status", () => {
  it("returns null when idle and agent inactive", () => {
    createRoot((dispose) => {
      const deps = createDeps()
      const spinner = createSpinnerStatus(deps)
      expect(spinner.status()).toBeNull()
      dispose()
    })
  })

  it("keeps tool execution hidden while the agent is awaiting user input", async () => {
    const deps = createDeps({ activity: "tool_executing", agentState: "idle" })
    const { spinner, dispose } = withRoot((innerDispose) => ({ spinner: createSpinnerStatus(deps), dispose: innerDispose }))
    expect(spinner.status()).toBeNull()
    await flush().then(() => deps.setTick(1)).then(flush)
    expect(spinner.status()).toBeNull()
    dispose()
  })

  it("keeps the foreground runner's own phase while a background subagent runs", () => {
    createRoot((dispose) => {
      const deps = createDeps({ activity: "thinking", agentState: "active" })
      const spinner = createSpinnerStatus(deps)
      expect(spinner.status()?.verb.trim()).toBe("Thinking")
      dispose()
    })
  })

  it("shows Waiting while the runner is parked on a backgrounded command", () => {
    createRoot((dispose) => {
      const deps = createDeps({ activity: null, agentState: "idle", waitingOnBackgroundWork: true })
      const spinner = createSpinnerStatus(deps)
      expect(spinner.status()).toEqual({ verb: "Waiting", segments: [], colorMode: "normal", intensity: 0, indicator: "spinner" })
      dispose()
    })
  })

  it.each(["park", "compaction", "notice", "connecting", "retrying"] as const)(
    "starts Waiting neutral after a 60 s %s hold, then stalls only after 10 s without progress",
    async (hold) => {
      const clock = spyOn(Date, "now").mockReturnValue(0)
      const warn = spyOn(Log.create({ service: "spinner" }), "warn").mockImplementation(() => {})
      const deps = createDeps({ activity: "waiting", agentState: "active" })
      const { spinner, dispose } = withRoot((innerDispose) => ({ spinner: createSpinnerStatus(deps), dispose: innerDispose }))
      const setHeld = (held: boolean) => {
        if (hold === "park") deps.setWaitingOnBackgroundWork(held)
        else if (hold === "compaction") deps.setCompactionStartedAt(held ? 1_000 : null)
        else if (hold === "notice") deps.setNotice(held ? {
          id: "waiting-notice", scope: "provider", presentation: "provider.status_progress", severity: "info",
          title: "Provider busy", message: "Waiting for provider", startedAt: 1_000, updatedAt: 1_000,
        } : null)
        else deps.setConnectionState(held ? hold : "connected")
      }
      try {
        await flush()
        clock.mockReturnValue(1_000)
        setHeld(true)
        await flush()
        clock.mockReturnValue(61_000)
        deps.setTick(1)
        await flush()
        expect(warn.mock.calls.filter(([message]) => message === "spinner status stalled")).toHaveLength(0)

        clock.mockReturnValue(61_001)
        setHeld(false)
        await flush()
        expect(spinner.status()).toMatchObject({ verb: expect.stringContaining("Waiting"), colorMode: "normal", intensity: 0 })

        clock.mockReturnValue(71_000)
        deps.setTick(2)
        await flush()
        expect(spinner.status()).toMatchObject({ colorMode: "normal", intensity: 0 })
        clock.mockReturnValue(71_001)
        deps.setTick(3)
        await flush()
        expect(spinner.status()?.colorMode).toBe("stalled")
        clock.mockReturnValue(81_001)
        deps.setTick(4)
        await flush()
        expect(spinner.status()?.intensity).toBeGreaterThan(0)
      } finally {
        dispose()
        clock.mockRestore()
        warn.mockRestore()
      }
    },
  )

  it("labels a parked runner's reply wait without another session's title", () => {
    createRoot((dispose) => {
      const onParent = createSpinnerStatus(createDeps({ waitingOnBackgroundWork: true, parentSessionId: "parent", replyWaits: [{ sessionId: "parent", name: "Design chat" }] }))
      expect(onParent.status()?.verb).toBe("Waiting on parent")
      const onSibling = createSpinnerStatus(createDeps({ waitingOnBackgroundWork: true, parentSessionId: "parent", replyWaits: [{ sessionId: "sibling", name: "Spec review" }] }))
      expect(onSibling.status()?.verb).toBe("Waiting for message response")
      dispose()
    })
  })

  it("keeps background process status visible while streaming, idle, and parked, then removes it reactively", async () => {
    const command: ActiveBackgroundCommandView = { id: "bg-1", description: "dev server", toolUseId: "tool-1", startedAtMs: 0 }

    for (const state of [
      { activity: "generating" as const, agentState: "active" as const },
      { activity: null, agentState: "idle" as const },
      { activity: null, agentState: "idle" as const, waitingOnBackgroundWork: true },
    ]) {
      const deps = createDeps({ ...state, activeBackgroundCommands: [command] })
      const { spinner, dispose } = withRoot((innerDispose) => ({ spinner: createSpinnerStatus(deps), dispose: innerDispose }))
      expect(segmentTexts(spinner.status()!)).toContain("1 background process")

      deps.setActiveBackgroundCommands([])
      await flush()
      expect(spinner.status()?.segments.some((segment) => segment.text.includes("background process")) ?? false).toBe(false)
      dispose()
    }
  })

  it("pluralizes and width-budgets background process metadata", () => {
    createRoot((dispose) => {
      const commands: ActiveBackgroundCommandView[] = [
        { id: "bg-1", description: "one", toolUseId: "tool-1", startedAtMs: 0 },
        { id: "bg-2", description: "two", toolUseId: "tool-2", startedAtMs: 0 },
      ]
      expect(segmentTexts(createSpinnerStatus(createDeps({ agentState: "idle", activeBackgroundCommands: commands, terminalWidth: 40 })).status()!)).toEqual(["2 background processes"])
      expect(createSpinnerStatus(createDeps({ agentState: "idle", activeBackgroundCommands: commands, terminalWidth: 20 })).status()!.segments).toEqual([])
      dispose()
    })
  })

  it("shows activity verb without elapsed during generation", () => {
    createRoot((dispose) => {
      const deps = createDeps({ activity: "generating", agentState: "active" })
      const spinner = createSpinnerStatus(deps)
      const s = spinner.status()
      expect(s).not.toBeNull()
      expect(s!.verb).toContain("Generating")
      expect(segmentTexts(s!)).not.toContain("2s")
      expect(s!.colorMode).toBe("normal")
      dispose()
    })
  })

  it("shows token count segment when streaming chars are set", () => {
    createRoot((dispose) => {
      const deps = createDeps({
        activity: "generating",
        agentState: "active",
        streamingChars: 4_000,
      })
      const spinner = createSpinnerStatus(deps)
      const s = spinner.status()
      expect(s).not.toBeNull()
      const texts = segmentTexts(s!)
      expect(texts.some((t) => t.includes("↓") && t.includes("tokens"))).toBe(true)
      dispose()
    })
  })

  it("shows compaction status while activity is idle", () => {
    createRoot((dispose) => {
      const startedAt = Date.now() - 90_000
      const deps = createDeps({ activity: null, agentState: "idle", compactionStartedAt: startedAt })
      const spinner = createSpinnerStatus(deps)
      const s = spinner.status()
      expect(s).not.toBeNull()
      expect(s!.verb).toBe("Compacting")
      dispose()
    })
  })

  it("drops token metadata when width is tight", () => {
    createRoot((dispose) => {
      const deps = createDeps({
        activity: "generating",
        agentState: "active",
        streamingChars: 4_000,
        terminalWidth: 25,
      })
      const spinner = createSpinnerStatus(deps)
      const s = spinner.status()
      expect(s).not.toBeNull()
      expect(s!.verb).toContain("Generating")
      expect(s!.segments).toEqual([])
      dispose()
    })
  })

  it("shows a disconnected provider and never a reconnecting one", () => {
    createRoot((dispose) => {
      const deps = createDeps({ connectionState: "down" })
      const spinner = createSpinnerStatus(deps)
      const s = spinner.status()
      expect(s).not.toBeNull()
      expect(s!.verb).toBe("Disconnected")
      expect(s!.colorMode).toBe("stalled")
      expect(s!.intensity).toBe(1)
      dispose()
    })

    // Being re-seated between runners is nobody's status: no verb names it.
    createRoot((dispose) => {
      const deps = createDeps({ connectionState: "reconnecting" })
      const spinner = createSpinnerStatus(deps)
      expect(spinner.status()?.verb).not.toBe("Reconnecting")
      dispose()
    })
  })

  it("thinking activity does not trigger stall", async () => {
    // Two-phase clock: create at T0 with thinking active — the folded seed
    // stamps thinkingStartedAt=T0. Then move the clock to T0+15s and tick so
    // the next advance samples 15s of thinking, surfacing the reassurance
    // segment without any stall.
    const realNow = Date.now
    Date.now = () => 0
    const deps = createDeps({ activity: "thinking", agentState: "active", streamingChars: 0 })
    try {
      const { spinner, dispose } = withRoot((innerDispose) => ({ spinner: createSpinnerStatus(deps), dispose: innerDispose }))
      await flush()
      Date.now = () => 15_000
      deps.setTick(1)
      await flush()
      const s = spinner.status()
      expect(s).not.toBeNull()
      expect(s!.colorMode).not.toBe("stalled")
      expect(s!.verb).toContain("Thinking")
      // After 10s of thinking, should show reassurance segment
      const texts = segmentTexts(s!)
      expect(texts.some((t) => t === "working on it")).toBe(true)
      // Reassurance should be colored
      const reassurance = s!.segments.find((seg) => seg.text === "working on it")
      expect(reassurance?.colored).toBe(true)
      dispose()
    } finally {
      Date.now = realNow
    }
  })

  it("advancing the tick signal recomputes status from the new animation state", async () => {
    const realNow = Date.now
    Date.now = () => 0
    const deps = createDeps({ activity: "generating", agentState: "active", streamingChars: 0 })
    try {
      const { spinner, dispose } = withRoot((innerDispose) => ({ spinner: createSpinnerStatus(deps), dispose: innerDispose }))
      // Seed read at T0 is normal; advancing the clock and ticking stalls it.
      await flush()
      expect(spinner.status()!.colorMode).toBe("normal")
      Date.now = () => 11_000
      deps.setTick(1)
      await flush()
      expect(spinner.status()!.colorMode).toBe("stalled")
      dispose()
    } finally {
      Date.now = realNow
    }
  })

  it("tab switch into an actively-generating session shows its full count once the count arrives", async () => {
    const [foregroundId, setForegroundId] = createSignal("idle-session")
    const [agentState, setAgentState] = createSignal<"idle" | "active">("idle")
    const [activeChars, setActiveChars] = createSignal<number | undefined>(undefined)
    // Status cache reads track the id: switching surfaces a generating session.
    const status = () => statusView({ activity: foregroundId() === "idle-session" ? "idle" : "generating" })
    const { spinner, dispose } = withRoot((innerDispose) => {
      const source: SpinnerStatusSource = {
        status,
        // The switched-to transcript has not read its count yet.
        streamingOutputChars: () => foregroundId() === "idle-session" ? 0 : activeChars(),
        sessionId: foregroundId,
        agentState,
        waitingOnBackgroundWork: createSignal(false)[0],
        parentSessionId: () => undefined,
        compactionStartedAt: createSignal<number | null>(null)[0],
        notice: createSignal<SessionNotice | null>(null)[0],
      }
      return { spinner: createSpinnerStatus({ source, terminalWidth: createSignal(120)[0], tick: createSignal(0)[0] }), dispose: innerDispose }
    })
    expect(spinner.status()).toBeNull()

    // Switch tabs into the active session; the folded reset stamps
    // agentActive=true so the first status() read after the reset is non-null.
    setAgentState("active")
    setForegroundId("active-session")
    await flush()
    const s = spinner.status()
    expect(s).not.toBeNull()
    expect(s!.verb).toContain("Generating")
    // The count lands after the switch and shows whole, without a ramp.
    setActiveChars(4_000)
    await flush()
    expect(segmentTexts(spinner.status()!)).toContain("↓ 1.0k tokens")
    dispose()
  })

  it("resets the stall-log dedup state on a tab switch (no stale 'stall cleared' for the new session)", async () => {
    // The stall-log dedup state (firedThresholds/maxStallMs) must be
    // session-scoped: the switch reset clears it synchronously, so the new
    // session's first non-stalled sample does NOT trip the cleared branch with
    // session A's stale maxStallMs. Leaving it unreset emits a spurious
    // "spinner status stall cleared" attributed to the wrong session.
    const warn = spyOn(Log.create({ service: "spinner" }), "warn").mockImplementation(() => {})
    const clearedLogs = () => warn.mock.calls.filter(([msg]) => msg === "spinner status stall cleared").length

    const realNow = Date.now
    Date.now = () => 0
    const [foregroundId, setForegroundId] = createSignal("session-a")
    const [tick, setTick] = createSignal(0)
    const [chars, setChars] = createSignal(0)
    try {
      const dispose = withRoot((innerDispose) => {
        const source: SpinnerStatusSource = {
          status: () => statusView({ activity: "generating" }),
          streamingOutputChars: chars,
          sessionId: foregroundId,
          agentState: createSignal<"idle" | "active">("active")[0],
          waitingOnBackgroundWork: createSignal(false)[0],
          parentSessionId: () => undefined,
          compactionStartedAt: createSignal<number | null>(null)[0],
          notice: createSignal<SessionNotice | null>(null)[0],
        }
        createSpinnerStatus({ source, terminalWidth: createSignal(120)[0], tick })
        return innerDispose
      })
      await flush()

      // Session A stalls past the 10s threshold — fires "stalled", arms the
      // dedup set, and accumulates maxStallMs.
      Date.now = () => 11_000
      setTick(1)
      await flush()
      expect(warn.mock.calls).toEqual([["spinner status stalled", {
        sessionId: "session-a", thresholdMs: 10_000, timeSinceLastToken: 11_000,
      }]])
      expect(clearedLogs()).toBe(0)
      setChars(1)
      await flush()
      expect(warn.mock.calls[1]).toEqual(["spinner status stall cleared", {
        sessionId: "session-a", maxStallMs: 11_000, thresholds: [10_000],
      }])
      Date.now = () => 22_000
      setTick(2)
      await flush()
      expect(warn.mock.calls[2]).toEqual(["spinner status stalled", {
        sessionId: "session-a", thresholdMs: 10_000, timeSinceLastToken: 11_000,
      }])

      // Switch into session B: the reset re-seeds timeSinceLastToken to 0. If the
      // dedup set survived, the cleared branch would fire here for session B.
      setForegroundId("session-b")
      await flush()
      expect(clearedLogs()).toBe(1)
      dispose()
    } finally {
      Date.now = realNow
      warn.mockRestore()
    }
  })

  // De-risks the array on() form — no precedent in src/ — that the advance and
  // compaction effects rely on: it must fire on init and once per source change,
  // exposing the tracked values in order. Effects flush on a microtask.
  it("array on() fires on init and once per source change", async () => {
    const [a, setA] = createSignal(0)
    const [b, setB] = createSignal(0)
    let runs = 0
    let last: [number, number] | undefined
    const dispose = withRoot((innerDispose) => {
      createEffect(on([a, b], (values: number[]) => {
        runs++
        last = [values[0]!, values[1]!]
      }))
      return innerDispose
    })
    await flush()
    expect(runs).toBe(1)
    expect(last).toEqual([0, 0])
    setA(1)
    await flush()
    expect(runs).toBe(2)
    expect(last).toEqual([1, 0])
    setB(2)
    await flush()
    expect(runs).toBe(3)
    expect(last).toEqual([1, 2])
    dispose()
  })
})
