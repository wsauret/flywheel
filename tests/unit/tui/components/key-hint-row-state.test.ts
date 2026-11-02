import { describe, expect, it } from "bun:test"

import { keyHintPlainText, keyHintSeparatorBefore, primaryKeyHints, sessionCountLabel, shouldShowGlobalHints } from "../../../../src/tui/components/key-hint-row-state.js"

describe("key hint row state", () => {
  it("shows only question cancellation while a question dock is pending", () => {
    expect(primaryKeyHints({
      hasPendingQuestion: true,
      agentState: "active",
      sessionState: "active",
    })).toEqual([{ key: "esc", label: "cancel" }])
    expect(shouldShowGlobalHints({ hasPendingQuestion: true })).toBe(false)
  })

  it("keeps active-agent interrupt guidance out of the footer", () => {
    expect(primaryKeyHints({
      hasPendingQuestion: false,
      agentState: "active",
      sessionState: "active",
    })).toEqual([])
    expect(shouldShowGlobalHints({ hasPendingQuestion: false })).toBe(true)
  })

  it("shows dismiss for inactive sessions", () => {
    expect(primaryKeyHints({
      hasPendingQuestion: false,
      agentState: "idle",
      sessionState: "inactive",
    })).toEqual([{ key: "esc", label: "dismiss" }])
  })

  it("uses wide separators around hints marked with border separator style", () => {
    const hints = [
      { key: "esc", label: "cancel" },
      { key: "tab", label: "switch", separatorStyle: "border" },
      { key: "ctrl+s", label: "5 sessions" },
      { key: "?", label: "help" },
    ] as const

    expect(keyHintSeparatorBefore(hints, 1)).toBe(" ── ")
    expect(keyHintSeparatorBefore(hints, 2)).toBe(" ── ")
    expect(keyHintSeparatorBefore(hints, 3)).toBe(" · ")
    expect(keyHintPlainText(hints)).toBe("esc cancel ── tab switch ── ctrl+s 5 sessions · ? help")
  })


  it("formats the session count hint", () => {
    expect(sessionCountLabel(0)).toBe("sessions")
    expect(sessionCountLabel(1)).toBe("1 session")
    expect(sessionCountLabel(2)).toBe("2 sessions")
  })
})
