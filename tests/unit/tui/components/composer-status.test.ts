import { describe, expect, it } from "bun:test"
import { createSignal } from "solid-js"
import { createDraftCache } from "../../../../src/tui/hooks/create-draft-cache.js"
import { idleSpinnerSource, mountPrompt } from "./prompt-area-fixture.js"

describe("Composer status line", () => {
  it("follows a parked session to idle while an overlay covers the composer, with no tick and no overlay close", async () => {
    const [waitingOnBackgroundWork, setWaitingOnBackgroundWork] = createSignal(true)
    const result = await mountPrompt({
      draftCache: createDraftCache(),
      foregroundId: () => "session-a",
      spinnerSource: idleSpinnerSource({ waitingOnBackgroundWork }),
      // The shell's showPrompt: false while a child viewer or another overlay is open.
      captureFocus: () => false,
    })
    try {
      await result.renderOnce()
      expect(result.captureCharFrame()).toContain("Waiting")

      setWaitingOnBackgroundWork(false)
      await result.renderOnce()
      expect(result.captureCharFrame()).not.toContain("Waiting")
    } finally {
      result.renderer.destroy()
    }
  })
})
