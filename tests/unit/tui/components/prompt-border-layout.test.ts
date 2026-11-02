import { describe, expect, it } from "bun:test"
import { RGBA } from "@opentui/core"
import type { ModuleComposerStatus } from "../../../../src/protocol/protocol-module.js"
import { protocolModuleComposerStatus, defineProtocolModule } from "../../../../src/protocol/protocol-module.js"
import { computeComposerBorderLayout } from "../../../../src/tui/components/composer-border-layout.js"
import { statusLineParts, type SpinnerStatus } from "../../../../src/tui/hooks/spinner-status-animation.js"
import { noticeSpinnerStatus } from "../../../../src/tui/hooks/spinner-status-notice.js"
import { capacityWaitNotice } from "../../../../src/orchestration/session/capacity-wait.js"
import type { SessionNotice } from "../../../../src/infra/session-notice.js"
import type { KeyHintSpec } from "../../../../src/tui/components/key-hint-row-state.js"
import { offeredSessionControls } from "../../../../src/protocol/client/session-controls.js"
import { contrastRatio } from "../../../../src/tui/context/theme/color-contrast.js"
import { baseInput, primary, resolvedTheme, renderPromptLabelsFrame, renderStatusFrame, sameColor, spanColor } from "./prompt-border-fixtures.js"

describe("computeComposerBorderLayout", () => {
  it("renders a synthetic registered composer contribution with styled suffix and no phantom click target", async () => {
    const module = defineProtocolModule({ id: "development", domains: [], composer: { status: () => [
      { id: "synthetic", text: "Peer ready", suffix: { text: "verified", tone: "success" as const } },
    ] } })
    const labels = protocolModuleComposerStatus([module], () => undefined)
    let actions = 0
    const result = await renderPromptLabelsFrame({ theme: resolvedTheme, modelLabel: "model-x", hints: [], composerStatus: labels, onModuleAction: () => { actions++ } })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Peer ready verified · model-x")
      expect(sameColor(spanColor(result.captureSpans(), "Peer ready")!, resolvedTheme.textMuted)).toBe(true)
      expect(sameColor(spanColor(result.captureSpans(), "verified")!, resolvedTheme.success)).toBe(true)
      const line = result.captureCharFrame().split("\n")[0]!
      await result.mockMouse.click(line.indexOf("Peer ready"), 0)
      expect(actions).toBe(0)
      expect(protocolModuleComposerStatus([module], () => undefined, [])).toEqual([])
    } finally { result.renderer.destroy() }
  })

  it("opens Changes from one prompt-border target beside remote without dismissing updates", async () => {
    let opens = 0
    let dismissals = 0
    const result = await renderPromptLabelsFrame({
      theme: resolvedTheme, width: 100, modelLabel: "model-x", hints: [],
      update: { label: "✓ Update installed · Restart to update ×", tone: "success" }, composerStatus: [{ id: "synthetic", text: "remote control", suffix: { text: "✓", tone: "success" }, action: { kind: "surface", id: "synthetic-details" } }],
      changesLabel: "Changes (2+)",
      onOpenChanges: () => { opens++ },
      onDismissUpdate: () => { dismissals++ },
    })
    try {
      await result.renderOnce()
      const line = result.captureCharFrame().split("\n")[0]!
      expect(line).toContain("✓ Update installed · Restart to update × · remote control ✓ · Changes (2+) · model-x")
      expect(result.captureCharFrame().match(/Changes/g)).toHaveLength(1)
      expect(sameColor(spanColor(result.captureSpans(), "Changes (2+)")!, resolvedTheme.textMuted)).toBe(true)
      await result.mockMouse.click(line.indexOf("Changes"), 0)
      expect(opens).toBe(1)
      expect(dismissals).toBe(0)
      await result.mockMouse.click(line.indexOf("Update installed"), 0)
      expect(dismissals).toBe(1)
      expect(opens).toBe(1)
    } finally { result.renderer.destroy() }
  })

  it("drops Changes before the existing remote, model and update labels under width pressure", () => {
    const input: Parameters<typeof computeComposerBorderLayout>[0] = { ...baseInput, terminalWidth: 100, composerStatus: [{ id: "synthetic", text: "remote control", suffix: { text: "✓", tone: "success" }, action: { kind: "surface", id: "synthetic-details" } }], changesLabel: "Changes (2)" }
    expect(computeComposerBorderLayout({ ...input, terminalWidth: 51 }).changesLabel).toBe("Changes (2)")
    const narrow = computeComposerBorderLayout({ ...input, terminalWidth: 50 })
    expect(narrow.changesLabel).toBeUndefined()
    expect(narrow.composerStatus).toEqual(input.composerStatus)
    expect(narrow.modelLabel).toBe(input.modelLabel)
    const alert = computeComposerBorderLayout({ ...input, terminalWidth: 45, update: { label: "✓ Update installed · Restart to update ×", tone: "success" } })
    expect(alert.update?.label).toBe("✓ Update installed · Restart to update ×")
    expect(alert.changesLabel).toBeUndefined()
  })

  it("keeps model and shortcut labels readable when decorative borders have low contrast", async () => {
    const theme = {
      ...resolvedTheme,
      border: resolvedTheme.background,
    }

    const result = await renderPromptLabelsFrame({
      theme,
      width: 80,
      modelLabel: "claude-opus-4",
      update: { label: "✓ Update installed · Restart to update ×", tone: "success" },
      hints: [
        { key: "esc", label: "cancel" },
        { key: "ctrl+s", label: "sessions", separatorStyle: "border" },
      ],
    })

    try {
      await result.renderOnce()
      const spans = result.captureSpans()
      expect(sameColor(spanColor(spans, "✓ Update installed · Restart to update ×")!, theme.success)).toBe(true)
      for (const label of ["claude-opus-4", "esc", "cancel", "ctrl+s", "sessions"]) {
        const foreground = spanColor(spans, label)
        if (!foreground) throw new Error(`Missing prompt label: ${label}`)
        expect(contrastRatio(foreground, theme.background)).toBeGreaterThanOrEqual(4.5)
        expect(sameColor(foreground, theme.textMuted)).toBe(true)
      }
    } finally {
      result.renderer.destroy()
    }
  })
  it("puts the remote chip before the model and paints its check mark in the success color", async () => {
    const theme = {
      ...resolvedTheme,
      textMuted: RGBA.fromInts(80, 80, 80),
      success: RGBA.fromInts(40, 170, 40),
      border: RGBA.fromInts(230, 230, 230),
    }

    const result = await renderPromptLabelsFrame({
      theme,
      modelLabel: "claude-opus-4",
      composerStatus: [{ id: "synthetic", text: "remote control", suffix: { text: "✓", tone: "success" }, action: { kind: "surface", id: "synthetic-details" } }],
      hints: [],
    })

    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain(" remote control ✓ · claude-opus-4 ")
      const spans = result.captureSpans()
      expect(sameColor(spanColor(spans, "remote control")!, theme.textMuted)).toBe(true)
      expect(sameColor(spanColor(spans, "✓")!, theme.success)).toBe(true)
      expect(sameColor(spanColor(spans, "claude-opus-4")!, theme.textMuted)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("opens the remote and active-model controls once and shows subtle hover chrome", async () => {
    let remoteOpens = 0
    let modelOpens = 0
    let parentFocuses = 0
    const result = await renderPromptLabelsFrame({
      theme: resolvedTheme,
      modelLabel: "claude-opus-4",
      composerStatus: [{ id: "synthetic", text: "remote control", suffix: { text: "✓", tone: "success" }, action: { kind: "surface", id: "synthetic-details" } }],
      hints: [],
      onModuleAction: (action) => { expect(action).toEqual({ kind: "surface", id: "synthetic-details" }); remoteOpens++ },
      onOpenModel: () => { modelOpens++ },
      onMouseDown: () => { parentFocuses++ },
    })
    try {
      await result.renderOnce()
      const line = result.captureCharFrame().split("\n")[0]!
      const remoteColumn = line.indexOf("remote control")
      const modelColumn = line.indexOf("claude-opus-4")
      const originalSpans = result.captureSpans()
      await result.mockMouse.moveTo(remoteColumn, 0)
      await result.renderOnce()
      const hoveredSpans = result.captureSpans()
      expect(result.captureCharFrame().split("\n")[0]).toBe(line)
      expect(sameColor(spanColor(hoveredSpans, "remote control")!, spanColor(originalSpans, "remote control")!)).toBe(true)
      expect(sameColor(spanColor(hoveredSpans, "✓")!, spanColor(originalSpans, "✓")!)).toBe(true)
      expect(hoveredSpans.lines[0]?.spans.some((span) =>
        span.text.includes("remote control") && sameColor(span.bg, resolvedTheme.backgroundRaised)
      )).toBe(true)
      for (const column of [remoteColumn - 1, remoteColumn, remoteColumn + "remote control ✓".length - 1, remoteColumn + "remote control ✓".length]) {
        await result.mockMouse.click(column, 0)
      }
      for (const column of [modelColumn - 1, modelColumn, modelColumn + "claude-opus-4".length - 1, modelColumn + "claude-opus-4".length]) {
        await result.mockMouse.click(column, 0)
      }
      expect(remoteOpens).toBe(4)
      expect(modelOpens).toBe(4)
      expect(parentFocuses).toBe(0)

      await result.mockMouse.click(remoteColumn + "remote control ✓".length + 1, 0)
      expect(remoteOpens).toBe(4)
    } finally {
      result.renderer.destroy()
    }
  })

  it("retains bottom hint and background labels through hover and routes each control once", async () => {
    const counts = { sessions: 0, resume: 0, new: 0, close: 0, switch: 0, background: 0, parent: 0 }
    const status: SpinnerStatus = {
      verb: "Executing ",
      segments: [{ text: "2 background processes", colored: false, action: "background" }],
      colorMode: "normal",
      indicator: "spinner",
      intensity: 0,
    }
    const hints: KeyHintSpec[] = [
      { key: "ctrl+r", label: "resume" },
      { key: "ctrl+n", label: "new" },
      { key: "ctrl+w", label: "close tab" },
      { key: "tab", label: "switch" },
      { key: "ctrl+s", label: "5 sessions", separatorStyle: "border" },
    ]
    const result = await renderPromptLabelsFrame({
      theme: resolvedTheme,
      width: 140,
      modelLabel: "model-x",
      hints,
      status,
      onOpenSessions: () => { counts.sessions++ },
      onNew: () => { counts.new++ },
      onClose: () => { counts.close++ },
      onNextTab: () => { counts.switch++ },
      onOpenBackground: () => { counts.background++ },
      onResume: () => { counts.resume++ },
      onMouseDown: () => { counts.parent++ },
    })
    try {
      await result.renderOnce()
      const original = result.captureCharFrame().split("\n")[2]!
      const originalSpans = result.captureSpans()
      const backgroundColumn = original.indexOf("2 background processes")
      await result.mockMouse.moveTo(backgroundColumn, 2)
      await result.renderOnce()
      expect(result.captureCharFrame().split("\n")[2]).toBe(original)
      expect(sameColor(
        spanColor(result.captureSpans(), "2 background processes")!,
        spanColor(originalSpans, "2 background processes")!,
      )).toBe(true)

      const targets = [
        ["ctrl+r resume", "resume"],
        ["ctrl+n new", "new"],
        ["ctrl+w close tab", "close"],
        ["tab switch", "switch"],
        ["ctrl+s 5 sessions", "sessions"],
        ["2 background processes", "background"],
      ] as const
      for (const [text, action] of targets) {
        const column = original.indexOf(text)
        expect(column).toBeGreaterThan(-1)
        await result.mockMouse.click(column, 2)
        expect(counts[action]).toBe(1)
      }
      expect(counts.parent).toBe(0)

      const newColumn = original.indexOf("ctrl+n new")
      await result.mockMouse.click(newColumn - 2, 2)
      expect(counts.new).toBe(1)
    } finally {
      result.renderer.destroy()
    }
  })

  it("measures the remote chip with its check mark when deciding whether it fits", () => {
    const chip: ModuleComposerStatus = { id: "synthetic", text: "remote control", suffix: { text: "✓", tone: "success" } }
    // 5 margin + 13 model + 3 separator + 16 chip = 37 columns exactly.
    expect(computeComposerBorderLayout({ ...baseInput, terminalWidth: 37, composerStatus: [chip] }).composerStatus).toEqual([chip])
    expect(computeComposerBorderLayout({ ...baseInput, terminalWidth: 36, composerStatus: [chip] }).composerStatus).toEqual([])
  })

  it("renders prompt-border status without footer parentheses or ellipses", async () => {

    const text = RGBA.fromInts(240, 240, 240)
    const textSubtle = RGBA.fromInts(160, 160, 160)
    const color = RGBA.fromInts(200, 200, 200)
    const theme = {
      ...resolvedTheme,
      background: RGBA.fromInts(0, 0, 0),
      text,
      textSubtle,
      textMuted: color,
      warning: color,
      error: color,
      border: color,
    }
    const status: SpinnerStatus = {
      verb: "Thinking  ",
      segments: [{ text: "↓ 26 tokens", colored: false }],
      colorMode: "normal",
      indicator: "spinner",
      intensity: 0,
    }

    const result = await renderStatusFrame({ theme, status, idle: false, maxWidth: 34 })

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Thinking ──── ↓ 26 tokens /)
      expect(frame).not.toContain("Thinking…")
      expect(frame).not.toContain("(")
      expect(frame).not.toContain(")")
      const spans = result.captureSpans()
      expect(sameColor(spanColor(spans, "Thinking")!, text)).toBe(true)
      expect(sameColor(spanColor(spans, "↓ 26 tokens")!, textSubtle)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders a capacity wait as a wait with its agent and continue time, and a fault retry as a counted retry", async () => {
    const warning = RGBA.fromInts(230, 180, 40)
    const textSubtle = RGBA.fromInts(160, 160, 160)
    const theme = { ...resolvedTheme, background: RGBA.fromInts(0, 0, 0), text: RGBA.fromInts(240, 240, 240), textSubtle, textMuted: textSubtle, warning, error: warning, border: textSubtle }
    const now = new Date(2026, 9, 28, 23, 0).getTime()
    const wait = capacityWaitNotice({ sessionId: "chat-1", agentName: "Chat", atMs: new Date(2026, 9, 29, 2, 0).getTime(), now })
    const fault: SessionNotice = { id: "fault", scope: "fault", presentation: "provider.reconnect_progress", severity: "warning", title: "Recovering from a provider fault", message: "", startedAt: now, updatedAt: now, retry: { count: 2, nextAttemptAt: now + 4_000 } }

    const waiting = await renderStatusFrame({ theme, status: noticeSpinnerStatus(wait, 120, now), idle: false, maxWidth: 120 })
    try {
      await waiting.renderOnce()
      const frame = waiting.captureCharFrame()
      expect(frame).toMatch(/ Waiting ─+ Waiting for model capacity ── Chat continues at Oct 29, 02:00 /)
      expect(frame).not.toContain("Retrying")
      expect(frame).not.toContain("retry")
      const spans = waiting.captureSpans()
      expect(sameColor(spanColor(spans, "Waiting for model capacity")!, spanColor(spans, "Waiting ")!)).toBe(true)
      expect(sameColor(spanColor(spans, "Waiting for model capacity")!, textSubtle)).toBe(false)
      expect(sameColor(spanColor(spans, "Chat continues at Oct 29, 02:00")!, textSubtle)).toBe(true)
    } finally {
      waiting.renderer.destroy()
    }

    const retrying = await renderStatusFrame({ theme, status: noticeSpinnerStatus(fault, 120, now), idle: false, maxWidth: 120 })
    try {
      await retrying.renderOnce()
      expect(retrying.captureCharFrame()).toMatch(/ Retrying ─+ Recovering from a provider fault ── retry 2 ── 4s /)
    } finally {
      retrying.renderer.destroy()
    }
  })

  it("uses border separators between token metadata and thinking hints", () => {
    const parts = statusLineParts({
      verb: "Thinking",
      segments: [
        { text: "↓ 1.0k tokens", colored: false },
        { text: "working on it", colored: true },
      ],
      colorMode: "normal",
      indicator: "spinner",
      intensity: 0,
    })
    const tokenIndex = parts.findIndex((part) => part.text.includes("tokens"))

    expect(tokenIndex).toBeGreaterThan(-1)
    expect(parts[tokenIndex + 1]).toEqual({ text: "──", tone: "border" })
    expect(parts[tokenIndex + 2]).toEqual({ text: " working on it ", tone: "status" })
  })

  it("renders static circle for Waiting status", async () => {

    const color = RGBA.fromInts(200, 200, 200)
    const theme = {
      ...resolvedTheme,
      background: RGBA.fromInts(0, 0, 0),
      text: color,
      textSubtle: color,
      textMuted: color,
      warning: color,
      error: color,
      border: color,
    }
    const status: SpinnerStatus = {
      verb: "Waiting",
      segments: [],
      colorMode: "normal",
      indicator: "circle",
      intensity: 0,
    }

    const result = await renderStatusFrame({ theme, status, idle: false, maxWidth: 20 })

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("◌ Waiting")
      expect(frame).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)
      expect(frame).toContain(" Waiting ───")
    } finally {
      result.renderer.destroy()
    }
  })

  it("renders fallback Idle with status styling and border padding", async () => {

    const text = RGBA.fromInts(240, 240, 240)
    const textMuted = RGBA.fromInts(120, 120, 120)
    const border = RGBA.fromInts(80, 80, 80)
    const theme = {
      ...resolvedTheme,
      background: RGBA.fromInts(0, 0, 0),
      text,
      textSubtle: textMuted,
      textMuted,
      warning: textMuted,
      error: textMuted,
      border,
    }

    const result = await renderStatusFrame({ theme, status: null, idle: true, maxWidth: 20 })

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toContain("◌ Idle ──────")
      const spans = result.captureSpans()
      expect(sameColor(spanColor(spans, "Idle")!, text)).toBe(true)
      expect(sameColor(spanColor(spans, "──────")!, border)).toBe(true)
    } finally {
      result.renderer.destroy()
    }
  })

  it("pads short status verbs with border before token metadata", async () => {

    const color = RGBA.fromInts(200, 200, 200)
    const theme = {
      ...resolvedTheme,
      background: RGBA.fromInts(0, 0, 0),
      text: color,
      textSubtle: color,
      textMuted: color,
      warning: color,
      error: color,
      border: color,
    }
    const status: SpinnerStatus = {
      verb: "Executing ",
      segments: [{ text: "↓ 26 tokens", colored: false }],
      colorMode: "normal",
      indicator: "spinner",
      intensity: 0,
    }

    const result = await renderStatusFrame({ theme, status, idle: false, maxWidth: 40 })

    try {
      await result.renderOnce()
      const frame = result.captureCharFrame()
      expect(frame).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Executing ─── ↓ 26 tokens /)
      expect(frame).not.toContain("Executing  ")
    } finally {
      result.renderer.destroy()
    }
  })

  it("includes all bottom-right hints when the terminal is wide", () => {
    const result = computeComposerBorderLayout({ ...baseInput, terminalWidth: 200 })
    expect(result.modelLabel).toBe("claude-opus-4")
    expect(result.hints.map((h) => h.label)).toEqual(["cancel", "new", "close tab", "switch", "5 sessions"])
    expect(result.sessionsClickHint).toEqual({ key: "ctrl+s", label: "5 sessions" })
  })


  it("drops the new/close tab verbs after Tab switch and before sessions", () => {
    const tighter = computeComposerBorderLayout({ ...baseInput, terminalWidth: 43 })
    expect(tighter.hints.map((h) => h.label)).toEqual(["cancel", "5 sessions"])
  })

  it("degrades instead of selecting a level the border renderer would suppress", () => {
    // Full hint text is 77 cells; the renderer needs terminalWidth >= 82 to
    // splice it into the bottom border (padding + corners + one rule cell).
    const fits = computeComposerBorderLayout({ ...baseInput, terminalWidth: 82 })
    expect(fits.hints.map((h) => h.label)).toEqual(["cancel", "new", "close tab", "switch", "5 sessions"])
    const boundary = computeComposerBorderLayout({ ...baseInput, terminalWidth: 81 })
    expect(boundary.hints.map((h) => h.label)).toEqual(["cancel", "new", "close tab", "5 sessions"])
  })

  it("drops ctrl+s sessions before primary hints", () => {
    const result = computeComposerBorderLayout({ ...baseInput, terminalWidth: 32 })
    expect(result.hints.some((h) => h.label === "5 sessions")).toBe(false)
    expect(result.hints.some((h) => h.label === "switch")).toBe(false)
    expect(result.hints).toEqual(primary)
    expect(result.sessionsClickHint).toBeNull()
  })


  it("keeps the top-right model independent from bottom-right hint pressure", () => {
    const result = computeComposerBorderLayout({ ...baseInput, terminalWidth: 24 })
    expect(result.modelLabel).toBe("claude-opus-4")
    expect(result.hints).toEqual(primary)
  })

  it("keeps an update alert and drops the model first when top-border width is tight", () => {
    const wide = computeComposerBorderLayout({ ...baseInput, terminalWidth: 61, update: { label: "✓ Update installed · Restart to update ×", tone: "success" } })
    expect(wide.update?.label).toBe("✓ Update installed · Restart to update ×")
    expect(wide.modelLabel).toBe("claude-opus-4")

    const tight = computeComposerBorderLayout({ ...baseInput, terminalWidth: 45, update: { label: "✓ Update installed · Restart to update ×", tone: "success" } })
    expect(tight.update?.label).toBe("✓ Update installed · Restart to update ×")
    expect(tight.modelLabel).toBeUndefined()
  })

  it("suppresses the whole top label when the update alert cannot fit", () => {
    const result = computeComposerBorderLayout({ ...baseInput, terminalWidth: 44, update: { label: "✓ Update installed · Restart to update ×", tone: "success" } })
    expect(result.update).toBeUndefined()
    expect(result.modelLabel).toBeUndefined()
  })

  it("drops the model only when it cannot fit in the top-right border", () => {
    const result = computeComposerBorderLayout({ ...baseInput, terminalWidth: 10 })
    expect(result.modelLabel).toBeUndefined()
  })

  describe("ctrl+r resume hint", () => {
    const resumeHint: KeyHintSpec = { key: "ctrl+r", label: "resume" }
    const interrupted = { id: "chat-1", kind: "chat" as const, admittedActions: ["chat.interrupt" as const, "chat.resume" as const] }
    // The shell's rule: the hint exists only while the foreground session offers Resume.
    const hintFor = (row: typeof interrupted | null, running: boolean) => offeredSessionControls(row, running).primary === "resume" ? resumeHint : undefined

    it("appears only while the foreground row admits Resume and no turn runs", () => {
      const shown = computeComposerBorderLayout({ ...baseInput, terminalWidth: 200, resumeHint: hintFor(interrupted, false) })
      expect(shown.hints.map((h) => h.label)).toEqual(["cancel", "resume", "new", "close tab", "switch", "5 sessions"])

      for (const resumeHintInput of [
        hintFor(interrupted, true),
        hintFor({ ...interrupted, admittedActions: ["chat.interrupt"] }, false),
        hintFor(null, false),
      ]) {
        const hidden = computeComposerBorderLayout({ ...baseInput, terminalWidth: 200, resumeHint: resumeHintInput })
        expect(hidden.hints.some((h) => h.label === "resume")).toBe(false)
      }
    })

    it("hides with the other global hints while a question or work command owns the prompt", () => {
      const result = computeComposerBorderLayout({ ...baseInput, terminalWidth: 200, showGlobalHints: false, resumeHint })
      expect(result.hints.some((h) => h.label === "resume")).toBe(false)
    })

    it("outlives Tab switch, the tab verbs, and sessions under width pressure, and yields before primary hints", () => {
      const labels = (terminalWidth: number) => computeComposerBorderLayout({ ...baseInput, terminalWidth, resumeHint }).hints.map((h) => h.label)
      expect(labels(84)).toEqual(["cancel", "resume", "new", "close tab", "5 sessions"])
      expect(labels(60)).toEqual(["cancel", "resume", "5 sessions"])
      expect(labels(35)).toEqual(["cancel", "resume"])
      expect(labels(20)).toEqual(["cancel"])
    })
  })

  it("omits Tab switch when fewer than 2 active sessions", () => {
    const result = computeComposerBorderLayout({ ...baseInput, terminalWidth: 200, activeSessionCount: 1 })
    expect(result.hints.map((h) => h.label)).toEqual(["cancel", "new", "close tab", "5 sessions"])
  })

  it("keeps sessions visible when contextual global hints are blocked", () => {
    const result = computeComposerBorderLayout({ ...baseInput, terminalWidth: 200, showGlobalHints: false })
    expect(result.hints.map((h) => h.label)).toEqual(["cancel", "5 sessions"])
    expect(result.sessionsClickHint).toEqual({ key: "ctrl+s", label: "5 sessions" })
  })
})
