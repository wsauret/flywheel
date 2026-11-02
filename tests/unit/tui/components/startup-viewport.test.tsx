/** @jsxImportSource @opentui/solid */

import { expect, it } from "bun:test"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import { createComponent } from "solid-js/web"
import type { RuntimeStartupStatus } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeFaultCopy } from "../../../../src/protocol/client/runtime-fault-copy.js"
import { StartupViewport } from "../../../../src/tui/components/startup-viewport.js"
import { ThemeProvider } from "../../../../src/tui/context/theme.js"
import flywheelTheme from "../../../../src/tui/context/theme/flywheel.json" with { type: "json" }
import { resolveTheme } from "../../../../src/tui/context/theme/resolve.js"
import { BOLD } from "../../../../src/tui/utils/text-attributes.js"
import { startupPhase } from "../../../../src/protocol/startup-steps.js"

it("shows each startup step on one bar and keeps it visible until a pending chat can open", async () => {
  const [status, setStatus] = createSignal<RuntimeStartupStatus | null>({
    kind: "phase", ...startupPhase({ step: "stored-facts", pass: { label: "memory facts", step: 2, total: 24 } }),
  })
  const [foregroundKind, setForegroundKind] = createSignal<"pending" | "session" | undefined>("pending")
  const [fault, setFault] = createSignal<RuntimeFaultCopy | null>(null)
  const result = await testRender(() => createComponent(ThemeProvider, {
    mode: "dark",
    get children() {
      return createComponent(StartupViewport, {
        get foregroundKind() { return foregroundKind() },
        get status() { return status() },
        get fault() { return fault() },
      })
    },
  }), { width: 80, height: 12 })
  try {
    await result.renderOnce()
    const startup = result.captureCharFrame()
    expect(startup).toContain("Starting Flywheel")
    // A pass of the upgrade names itself in the label; the bar counts steps
    // of the whole start and stays at the upgrade step.
    expect(startup).toContain("Upgrading stored facts, pass 2 of 24: memory facts...")
    expect(startup).toContain("█████████████░░░░░░░░░░░ 7/13")
    expect(startup).not.toContain("Opening chat")
    const theme = resolveTheme(flywheelTheme, "dark")
    const spans = () => result.captureSpans().lines.flatMap((line) => line.spans)
    const title = spans().find((span) => span.text === "Starting Flywheel")
    expect(title?.fg.equals(theme.primary)).toBe(true)
    expect((title?.attributes ?? 0) & BOLD).toBe(BOLD)
    expect(spans().find((span) => span.text === "Upgrading stored facts, pass 2 of 24: memory facts...")?.fg.equals(theme.textMuted)).toBe(true)

    // The state Worker's claim of interrupted sessions is an ordinary step
    // further along the same bar.
    setStatus({ kind: "phase", ...startupPhase({ step: "interrupted-sessions" }) })
    await result.renderOnce()
    expect(result.captureCharFrame()).toContain("Checking interrupted sessions...")
    expect(result.captureCharFrame()).toContain("██████████████████░░░░░░ 10/13")
    expect(spans().find((span) => span.text === "Checking interrupted sessions...")?.fg.equals(theme.textMuted)).toBe(true)
    expect(spans().find((span) => span.text === "██████████████████░░░░░░")?.fg.equals(theme.primary)).toBe(true)
    expect(spans().find((span) => span.text === "10/13")?.fg.equals(theme.textMuted)).toBe(true)

    setFault({ tone: "fault", title: "Startup failed", remedy: "Restart Flywheel", detail: "Runtime stopped" })
    await result.renderOnce()
    expect(result.captureCharFrame()).toContain("Startup failed")
    expect(result.captureCharFrame()).not.toContain("Checking interrupted sessions")
    expect(result.captureCharFrame()).not.toContain("Opening chat")

    setFault(null)
    setStatus(null)
    await result.renderOnce()
    expect(result.captureCharFrame()).toContain("Opening chat...")
    expect(result.captureCharFrame()).not.toContain("Starting Flywheel")

    setForegroundKind("session")
    setStatus({ kind: "phase", ...startupPhase({ step: "account-service" }) })
    await result.renderOnce()
    expect(result.captureCharFrame().trim()).toBe("")

  } finally {
    result.renderer.destroy()
  }
})
