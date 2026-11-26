import type { TextareaRenderable } from "@opentui/core"
import { type Accessor, createEffect, on } from "solid-js"

/**
 * Owns the prompt textarea's cursor.
 *
 * The prompt is the app's default focus holder; the only thing that takes the
 * cursor away is a modal with its own input opening on top. Focus ownership is
 * therefore a pure function of the modal stack: the prompt is focused ⟺ no
 * modal is open. Driving focus from that single signal replaces the previous
 * scatter: a mount-time focus(), a snapshot-and-restore in ModalProvider that
 * lost the cursor whenever the saved renderable had since been destroyed, and a
 * per-modal self-focus that left input-less modals leaking keys to the prompt.
 *
 * `shouldHold` is true when the modal stack is empty. `refocusKey` does not
 * change ownership; it only retries that ownership after mouse-driven actions
 * such as opening a new tab can move the terminal cursor away from the textarea.
 */
export function createComposerFocus(shouldHold: Accessor<boolean>, refocusKey: Accessor<unknown>): (prompt: TextareaRenderable) => void {
  let prompt: TextareaRenderable | null = null

  // Blurring matters as much as focusing: a focused textarea independently
  // consumes keypresses, so it must yield the cursor while a modal is open
  // (modal keys route through modal.input, not through focus).
  const sync = (): void => {
    if (!prompt || prompt.isDestroyed) return
    if (shouldHold()) { if (!prompt.focused) prompt.focus() }
    else if (prompt.focused) prompt.blur()
  }

  // State drives focus: when the stack opens or empties, the cursor follows.
  // Foreground changes also resync because tab/new-chat mouse clicks can steal
  // focus without changing the ownership rule. Deferred so it lands after the
  // modal's renderables mount or tear down.
  createEffect(on([shouldHold, refocusKey], () => queueMicrotask(sync)))

  // A remount doesn't change shouldHold, so the fresh textarea syncs on attach
  // to reclaim (or correctly decline) the cursor. The blurred hook enforces the
  // ownership rule against blurs the two signals cannot see (e.g. a transcript
  // click routed through the renderer's autoFocus walk silently detaches the
  // textarea's key handler); when we blur it ourselves for a modal, the resync
  // is a no-op because shouldHold is already false.
  return (r: TextareaRenderable) => {
    prompt = r
    r.on("blurred", () => queueMicrotask(sync))
    queueMicrotask(sync)
  }
}
