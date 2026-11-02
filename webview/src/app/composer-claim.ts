/** Where a keystroke belongs when it lands outside the composer.
 *
 *  The TUI's prompt takes typing no matter where the cursor is, and a browser
 *  has no such default: a key that lands on the page body is dropped. So the
 *  composer claims a bare printable key from anywhere, which is how `/` opens
 *  the command menu and a letter starts a message without a click first.
 *
 *  A modified key is a shortcut the browser or the host owns. Space scrolls
 *  the transcript, and a draft never usefully starts with one. A key being
 *  composed by an input method is not yet a character. */
export function isBareTypingKey(event: {
  readonly key: string
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly altKey: boolean
  readonly isComposing: boolean
}): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false
  return event.key.length === 1 && event.key !== " "
}

/** Controls that own the keys landing in them: editable fields, and anything
 *  inside an open dialog or sheet, whose focus trap holds the keyboard. */
export const CLAIMED_ELSEWHERE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="dialog"], [role="alertdialog"]'
