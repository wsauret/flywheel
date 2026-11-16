import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { UpdateStatusView } from "../../../../src/protocol/update-protocol-types.js"
import {
  createComposerBorderLayout,
  createDismissibleUpdateStatus,
  updateBorderStatus,
} from "../../../../src/tui/hooks/create-composer-border-layout.js"
import { createKeymap } from "../../../../src/tui/keymap/keymap.js"

const AUTO_INSTALL_ON = { persisted: true, forcedOff: false, effective: true } as const

function update(status: UpdateStatusView["status"], revision = 1): UpdateStatusView {
  return { revision, autoInstall: AUTO_INSTALL_ON, status }
}

describe("update border status", () => {
  it("maps each actionable runtime state to compact remedy copy", () => {
    expect(updateBorderStatus(update({ kind: "available", version: "1.4.0", blocking: "nothing" }))).toMatchObject({ label: "run flywheel update ×", tone: "error" })
    expect(updateBorderStatus(update({ kind: "available", version: "1.4.0", blocking: "auto-install-off" }))).toMatchObject({ label: "updates disabled ×", tone: "error" })
    expect(updateBorderStatus(update({ kind: "available", version: "1.4.0", blocking: "platform" }))).toMatchObject({ label: "reinstall to update ×", tone: "error" })
    expect(updateBorderStatus(update({ kind: "installed", version: "1.4.0" }))).toMatchObject({ label: "✓ Update installed · Restart to update ×", tone: "success" })
    expect(updateBorderStatus(update({ kind: "idle" }))).toBeUndefined()
    expect(updateBorderStatus(update({ kind: "installing", version: "1.4.0" }))).toBeUndefined()
    // A release that could not start on this machine asks nothing of the
    // person, so only the Status row names it (PI-UPDATES-008).
    expect(updateBorderStatus(update({ kind: "refused", version: "1.4.0" }))).toBeUndefined()
    expect(updateBorderStatus(undefined)).toBeUndefined()
  })

  it("keeps dismissal local to the current actionable state", () => {
    createRoot((dispose) => {
      const [view, setView] = createSignal<UpdateStatusView | undefined>(
        update({ kind: "installed", version: "1.4.0" }),
      )
      const status = createDismissibleUpdateStatus(view)

      expect(status.current()?.label).toBe("✓ Update installed · Restart to update ×")
      status.dismiss()
      expect(status.current()).toBeUndefined()

      setView(update({ kind: "installed", version: "1.5.0" }, 2))
      expect(status.current()?.label).toBe("✓ Update installed · Restart to update ×")
      dispose()
    })
  })
})

/** A border of an idle composer on a wide terminal, with every field overridable. */
function border(over: Partial<Parameters<typeof createComposerBorderLayout>[0]> = {}) {
  return createComposerBorderLayout({
    terminalWidth: () => 200,
    modelLabel: () => undefined,
    update: createDismissibleUpdateStatus(() => undefined),
    pendingQuestion: () => false,
    agentState: () => "idle",
    sessionState: () => "active",
    chordFor: createKeymap().keymap.chordFor,
    resumeOffered: () => false,
    activeSessionCount: () => 1,
    sessionCount: () => 2,
    tabHints: () => true,
    escapeHints: () => true,
    ...over,
  })
}

describe("composer border hints", () => {
  it("names no Escape action where Escape does none of them, and dismiss for an inactive chat elsewhere", () => {
    createRoot((dispose) => {
      const [escapeHints, setEscapeHints] = createSignal(false)
      const layout = border({ sessionState: () => "inactive", escapeHints })
      const escapes = () => layout().hints.filter((hint) => hint.key === "esc").map((hint) => `${hint.key} ${hint.label}`)

      expect(escapes()).toEqual([])
      setEscapeHints(true)
      expect(escapes()).toEqual(["esc dismiss"])
      dispose()
    })
  })

  it("names the chord a later [keybindings] publication sets", () => {
    createRoot((dispose) => {
      const [overrides, setOverrides] = createSignal<{ readonly [command: string]: string }>({})
      const keymap = (): ReturnType<typeof createKeymap>["keymap"] => createKeymap(overrides()).keymap
      const layout = border({ chordFor: (commandId) => keymap().chordFor(commandId) })
      const keys = (): readonly string[] => [...layout().hints, ...(layout().sessionsClickHint ? [layout().sessionsClickHint] : [])].map((hint) => hint?.key ?? "")

      expect(keys()).toEqual(expect.arrayContaining(["ctrl+n", "ctrl+s"]))
      setOverrides({ new: "ctrl+t", sessions: "ctrl+o" })
      expect(keys()).toEqual(expect.arrayContaining(["ctrl+t", "ctrl+o"]))
      expect(keys()).not.toContain("ctrl+n")
      expect(keys()).not.toContain("ctrl+s")
      dispose()
    })
  })

  it("names no new, close, or switch key where the tab keys do not act, keeps esc, resume, and sessions with its target, and names every key elsewhere", () => {
    createRoot((dispose) => {
      const [tabHints, setTabHints] = createSignal(false)
      const layout = border({ sessionState: () => "inactive", resumeOffered: () => true, activeSessionCount: () => 2, tabHints })
      const hints = (): readonly string[] => layout().hints.map((hint) => `${hint.key} ${hint.label}`)

      expect(hints()).toEqual(["esc dismiss", "ctrl+r resume", "ctrl+s 2 sessions"])
      expect(layout().sessionsClickHint?.key).toBe("ctrl+s")
      setTabHints(true)
      expect(hints()).toEqual(["esc dismiss", "ctrl+r resume", "ctrl+n new", "ctrl+w close tab", "tab switch", "ctrl+s 2 sessions"])
      dispose()
    })
  })
})
