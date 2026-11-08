import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"

/** What the composer's box holds. `live` is the person's draft. `browsing`
 *  shows the sent message at `index` (0 the newest) exactly as the transcript
 *  has it, with the draft that it replaced in `held`. Only `browseHistory`
 *  produces `browsing`; every other write of the text is an edit, which is
 *  `live`, so leaving history can only give the held draft back over an
 *  unedited sent message, which the transcript still has. */
export type ComposerText =
  | { readonly kind: "live"; readonly text: string }
  | { readonly kind: "browsing"; readonly index: number; readonly held: string; readonly text: string }

/** One step through `entries`, newest first: 1 goes older, -1 newer. A step
 *  newer than the newest entry gives the held draft back. Undefined past
 *  either end, which leaves the key to the textarea. */
export function browseHistory(current: ComposerText, entries: readonly string[], delta: 1 | -1): ComposerText | undefined {
  const index = (current.kind === "browsing" ? current.index : -1) + delta
  if (index < -1 || index >= entries.length) return undefined
  const held = current.kind === "browsing" ? current.held : current.text
  return index === -1 ? { kind: "live", text: held } : { kind: "browsing", index, held, text: entries[index] ?? "" }
}

/** The person's draft: while a sent message is recalled, the words it holds aside. */
export function draftOf(current: ComposerText): string {
  return current.kind === "browsing" ? current.held : current.text
}

/** Messages the person has sent, newest first. Read from the transcript
 *  rather than kept as a private list, so it is the same history after a
 *  reload, after switching chats, and after a message sent from elsewhere. */
export function sentMessages(blocks: readonly FrontendOutputBlock[]): string[] {
  const sent: string[] = []
  for (const block of blocks) {
    if (block.kind !== "userMessage") continue
    const text = block.content.trim()
    // Consecutive duplicates are noise to arrow through, the same as a shell
    // collapsing them.
    if (text.length > 0 && text !== sent[0]) sent.unshift(text)
  }
  return sent
}
