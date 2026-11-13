import type { Keymap } from "../keymap/keymap.js"
import type { ShellServices } from "./shell-state.js"

/** The new-chat and clear commands: each opens a chat and tells the person
 *  what happened when the new chat came to the front. */
export function createNewChatActions(deps: {
  readonly startChat: () => Promise<{ readonly kind: string }>
  readonly showToast: ShellServices["showToast"]
  readonly chordFor: Keymap["chordFor"]
}) {
  async function startNewChat(): Promise<void> {
    const settlement = await deps.startChat()
    if (settlement.kind === "foregrounded") {
      deps.showToast({ message: "New chat started", variant: "success" })
    }
  }
  // /clear serves muscle memory from harnesses where it wipes the session in
  // place. Flywheel sessions are tabs, so it opens a fresh tab like /new and
  // teaches the model once, at the moment the user reached for a reset.
  async function startClearedChat(): Promise<void> {
    const settlement = await deps.startChat()
    if (settlement.kind === "foregrounded") {
      deps.showToast({
        message: `Sessions are tabs: this is a fresh one. Chats with content keep their tabs; unused empty tabs are replaced. ${deps.chordFor("new")} new, ${deps.chordFor("tab.close")} close tab.`,
        variant: "info",
        duration: 8000,
      })
    }
  }
  return { startNewChat, startClearedChat }
}
