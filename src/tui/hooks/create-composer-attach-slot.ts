import type { AttachmentAppender } from "./composer-attachments.js"

/** The one way something outside the prompt puts attachments into it. Each
 *  composer registers a capture function once for its whole life, and the
 *  newest one that is still mounted takes the files: a chat view over the tab
 *  in front while it shows, and the tab's composer again after it closes.
 *  `/attach` captures one destination before it starts asynchronous work. */
export interface ComposerAttachSlot {
  /** Returns the end of this registration. */
  register(capture: () => AttachmentAppender | undefined): () => void
  capture(): AttachmentAppender | undefined
}

export function createComposerAttachSlot(): ComposerAttachSlot {
  const registered: (() => AttachmentAppender | undefined)[] = []
  return {
    register(capture) {
      registered.push(capture)
      return () => {
        const at = registered.lastIndexOf(capture)
        if (at >= 0) registered.splice(at, 1)
      }
    },
    capture() { return registered.at(-1)?.() },
  }
}
