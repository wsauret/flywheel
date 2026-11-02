import type { AttachmentAppender } from "./composer-attachments.js"

/** The one way something outside the prompt puts attachments into it. The
 *  composer registers a capture function when its textarea mounts; `/attach`
 *  captures one destination before it starts asynchronous work. */
export interface ComposerAttachSlot {
  register(capture: () => AttachmentAppender | undefined): void
  capture(): AttachmentAppender | undefined
}

export function createComposerAttachSlot(): ComposerAttachSlot {
  let active: (() => AttachmentAppender | undefined) | undefined
  return {
    register(capture) { active = capture },
    capture() { return active?.() },
  }
}
