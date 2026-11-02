import { basename } from "node:path"

import { ownedCommandRunner } from "../../infra/owned-command.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import { resizeImage } from "../../orchestration/agent-runtime/tools/image-resize.js"
import { ATTACHMENT_LIMITS, attachmentRefusalMessage } from "../../protocol/client/attachments.js"
import type { ShellServices } from "./shell-state.js"
import type { ComposerAttachSlot } from "./create-composer-attach-slot.js"
import { chooseFiles } from "../utils/file-chooser.js"
import { readFileAttachment, type PendingAttachment } from "../utils/file-attachments.js"

interface AttachFilesDeps {
  readonly launcher: LauncherScope
  readonly showToast: ShellServices["showToast"]
  readonly slot: ComposerAttachSlot
}

/** `/attach`: this computer's file chooser, then every picked file into the
 *  prompt as an attachment. A file that cannot attach is said in words, one
 *  toast each, and the rest still attach. */
export function createAttachFilesCommand(deps: AttachFilesDeps): () => Promise<void> {
  return async () => {
    const append = deps.slot.capture()
    if (!append) return
    const choice = await chooseFiles(ownedCommandRunner(deps.launcher), "Attach to Flywheel")
    if (choice.kind === "unavailable") {
      deps.showToast({ message: choice.reason, variant: "warning" })
      return
    }
    if (choice.kind === "cancelled") return
    const pending: PendingAttachment[] = []
    for (const path of choice.paths) {
      const read = await readFileAttachment(path, resizeImage)
      if ("refusal" in read) {
        deps.showToast({ message: attachmentRefusalMessage(basename(path), read.refusal), variant: "warning" })
        continue
      }
      pending.push(read.attachment)
    }
    const { attached, stopped } = append(pending)
    if (stopped === "message-size") {
      deps.showToast({ message: attachmentRefusalMessage(pending[attached]?.name ?? "The file", { reason: "message-size", limitBytes: ATTACHMENT_LIMITS.messageMaxBytes }), variant: "warning" })
    } else if (stopped === "prompt-gone") {
      const left = pending.length - attached
      deps.showToast({ message: `The prompt changed while the file chooser was open, so Flywheel did not attach ${left === 1 ? "1 file" : `${left} files`}. Use /attach again.`, variant: "warning" })
    }
  }
}
