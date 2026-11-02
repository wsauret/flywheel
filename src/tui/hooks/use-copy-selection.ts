import { useRenderer } from "@opentui/solid"
import { useToast } from "@tui/context/toast"
import { errorMessage } from "../../infra/error-message.js"
import type { Clipboard } from "../utils/clipboard.js"
import { consumeSelectedText } from "../utils/selection.js"

export function useCopySelection(clipboard: Clipboard): () => boolean {
  const renderer = useRenderer()
  const toast = useToast()

  return () => {
    const text = consumeSelectedText(renderer)
    if (!text) return false

    void clipboard.copy(text)
      .then(() => toast.show({ message: "Copied to clipboard", variant: "info" }))
      .catch((err) => toast.show({ message: errorMessage(err), variant: "error" }))
    return true
  }
}
