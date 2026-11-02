import { describe, expect, it, spyOn } from "bun:test"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createRoot, createSignal, type Accessor } from "solid-js"
import { createComposerFocus } from "../../../../src/tui/hooks/create-composer-focus.js"

async function flushFocusSync(): Promise<void> {
  await Bun.sleep(0)
}

/** Mounts a real prompt textarea under createComposerFocus, with spies that count
 *  the hook's focus and blur calls, and disposes everything after `run`. */
async function withPrompt(
  shouldHold: Accessor<boolean>,
  refocusKey: Accessor<unknown>,
  run: (prompt: TextareaRenderable, calls: { focus: () => number; blur: () => number }) => Promise<void>,
): Promise<void> {
  const render = await createTestRenderer({ width: 40, height: 5 })
  const prompt = new TextareaRenderable(render.renderer, { width: 40, height: 3 })
  render.renderer.root.add(prompt)
  const focus = spyOn(prompt, "focus")
  const blur = spyOn(prompt, "blur")
  let dispose = () => {}
  createRoot((rootDispose) => {
    dispose = rootDispose
    createComposerFocus(shouldHold, refocusKey)(prompt)
  })
  try {
    await run(prompt, { focus: () => focus.mock.calls.length, blur: () => blur.mock.calls.length })
  } finally {
    dispose()
    await render.dispose()
  }
}

/** Takes the cursor away the way a mouse action can: no `blurred` event reaches the hook. */
function loseFocusSilently(prompt: TextareaRenderable): void {
  prompt.removeAllListeners("blurred")
  prompt.blur()
}

describe("createComposerFocus", () => {
  it("reclaims the prompt cursor when the foreground session changes", async () => {
    const [shouldHold] = createSignal(true)
    const [foregroundId, setForegroundId] = createSignal("chat-1")

    await withPrompt(shouldHold, foregroundId, async (prompt, calls) => {
      await flushFocusSync()
      expect(prompt.focused).toBe(true)
      expect(calls.focus()).toBe(1)

      loseFocusSilently(prompt)
      await flushFocusSync()
      expect(prompt.focused).toBe(false)

      setForegroundId("chat-2")
      await flushFocusSync()

      expect(prompt.focused).toBe(true)
      expect(calls.focus()).toBe(2)
    })
  })

  it("reclaims the cursor after an external blur while it still owns focus", async () => {
    // A transcript click routed through the renderer's autoFocus walk blurs the
    // textarea without touching either ownership signal; the blurred hook must
    // win it back or typing silently goes nowhere.
    const [shouldHold] = createSignal(true)
    const [foregroundId] = createSignal("chat-1")

    await withPrompt(shouldHold, foregroundId, async (prompt, calls) => {
      await flushFocusSync()
      expect(prompt.focused).toBe(true)

      prompt.blur()
      await flushFocusSync()

      expect(prompt.focused).toBe(true)
      expect(calls.focus()).toBe(2)
    })
  })

  it("does not refocus on foreground changes while the prompt should not hold focus", async () => {
    const [shouldHold, setShouldHold] = createSignal(true)
    const [foregroundId, setForegroundId] = createSignal("chat-1")

    await withPrompt(shouldHold, foregroundId, async (prompt, calls) => {
      await flushFocusSync()
      setShouldHold(false)
      await flushFocusSync()

      expect(prompt.focused).toBe(false)
      expect(calls.blur()).toBe(1)

      setForegroundId("chat-2")
      await flushFocusSync()

      expect(prompt.focused).toBe(false)
      expect(calls.focus()).toBe(1)
    })
  })
})
