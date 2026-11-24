type ComposerPopupKeyEvent = { name: string; ctrl?: boolean; meta?: boolean; shift?: boolean; preventDefault?: () => void }

/** Classifies a popup key without acting on it. Tab requires popup permission.
 *  Shift leaves Enter and Tab unclaimed; Ctrl and Meta leave all keys unclaimed. */
export function classifyComposerPopupKey(
  key: ComposerPopupKeyEvent,
  options: { acceptsTab: boolean },
): "up" | "down" | "escape" | "tab" | "return" | undefined {
  if (key.ctrl || key.meta) return undefined
  switch (key.name) {
    case "up":
    case "down":
    case "escape": return key.name
    case "tab": return !key.shift && options.acceptsTab ? "tab" : undefined
    case "return": return !key.shift ? "return" : undefined
    default: return undefined
  }
}

/** Registration slot the shell keyboard handler consults before global key
 *  semantics: while a prompt popup (slash suggestions or history) is open,
 *  escape must not interrupt the agent, plain tab must not cycle sessions,
 *  and return must not reach any global binding. Mirrors question-input's
 *  single-authority shape; the prompt area registers, the shell handler
 *  calls input().
 *
 *  The registered handler is a pure claim predicate: it reports whether the
 *  popup owns the key and performs no action (the acting branches live in
 *  the prompt textarea's own key handler). The shell relies on that purity
 *  to probe ESC ownership when deriving the notice dismiss hint. */
export interface ComposerPopupKeySlot {
  register(onKey: (evt: ComposerPopupKeyEvent) => boolean): void
  input(evt: ComposerPopupKeyEvent): boolean
}

export function createComposerPopupKeySlot(): ComposerPopupKeySlot {
  let active: ((evt: ComposerPopupKeyEvent) => boolean) | undefined
  return {
    register(onKey) { active = onKey },
    input(evt) { return active?.(evt) ?? false },
  }
}
