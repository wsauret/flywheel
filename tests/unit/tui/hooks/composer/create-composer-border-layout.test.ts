import { describe, expect, it } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { UpdateStatusView } from "../../../../../src/protocol/runtime/update-protocol-types.js"
import {
  createComposerBorderLayout,
  createDismissibleUpdateStatus,
  updateBorderStatus,
} from "../../../../../src/tui/hooks/composer/create-composer-border-layout.js"
import { createKeymap } from "../../../../../src/tui/terminal/keymap/keymap.js"
import { createSignals, session } from "../_session-modal-fixtures.js"
import { selectNeedsYou } from "../../../../../src/protocol/client/session/needs-you.js"

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

describe("composer border hints", () => {
  it("names the chord a later [keybindings] publication sets", () => {
    createRoot((dispose) => {
      const [overrides, setOverrides] = createSignal<{ readonly [command: string]: string }>({})
      const keymap = (): ReturnType<typeof createKeymap>["keymap"] => createKeymap(overrides()).keymap
      const signals = createSignals()
      const { layout } = createComposerBorderLayout({
        signals,
        terminalWidth: () => 200,
        chordFor: (commandId) => keymap().chordFor(commandId),
        resumeOffered: () => false,
        activeSessionCount: () => 1,
      })
      const keys = (): readonly string[] => [...layout().hints, ...(layout().sessionsClickHint ? [layout().sessionsClickHint] : [])].map((hint) => hint?.key ?? "")

      expect(keys()).toEqual(expect.arrayContaining(["ctrl+n", "ctrl+s"]))
      setOverrides({ new: "ctrl+t", sessions: "ctrl+o" })
      expect(keys()).toEqual(expect.arrayContaining(["ctrl+t", "ctrl+o"]))
      expect(keys()).not.toContain("ctrl+n")
      expect(keys()).not.toContain("ctrl+s")
      dispose()
    })
  })

  it("counts the chats other than the one in front that need the person, by a question or by a stop, for as long as they do", () => {
    createRoot((dispose) => {
      const [waiting, setWaiting] = createSignal<readonly string[]>([])
      const [stopped, setStopped] = createSignal<readonly string[]>([])
      const signals = createSignals({}, "front")
      // A deleted session or a subagent in the set is not listed, so it never counts.
      const listed = ["front", "closed-a", "closed-b", "done"].map((id) => session({ id }))
      signals.needsYou = () => selectNeedsYou({
        waiting: { sessions: waiting().map((sessionId, index) => ({ sessionId, openedAt: index })) },
        unread: { stopped: stopped().map((sessionId, index) => ({ sessionId, ending: { kind: "completed" }, firstLine: "Done", stoppedAt: index, stopKey: `entry-${sessionId}` })), unread: ["working"], turns: {} },
        listed,
      })
      const { layout } = createComposerBorderLayout({
        signals,
        terminalWidth: () => 200,
        chordFor: (commandId) => createKeymap({}).keymap.chordFor(commandId),
        resumeOffered: () => false,
        activeSessionCount: () => 1,
      })

      setWaiting(["front"])
      expect(layout().needsYouLabel).toBeUndefined()
      setWaiting(["front", "closed-a", "closed-b", "deleted", "subagent"])
      expect(layout().needsYouLabel).toBe("2 need you")
      // A stopped unread chat counts beside the questions; a working chat
      // with unread messages does not need the person.
      setStopped(["done", "deleted"])
      expect(layout().needsYouLabel).toBe("3 need you")
      // Leaving a chat that needs the person makes it one of the others; the
      // label follows the foreground without any change to the set.
      signals.setForegroundId("closed-a")
      expect(layout().needsYouLabel).toBe("3 need you")
      signals.setForegroundId("closed-b")
      setWaiting(["closed-b"])
      setStopped([])
      expect(layout().needsYouLabel).toBeUndefined()
      signals.setForegroundId("front")
      expect(layout().needsYouLabel).toBe("1 needs you")
      dispose()
    })
  })
})
