/** Copying from the transcript. The clipboard is the browser's, so every
 *  caller reports the outcome the same way: the button says "Copied" for a
 *  moment, or nothing changes when the browser refused. */

const COPIED_MS = 1_500

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return copyBySelection(text)
  }
}

/** The older route, for a host that withholds the clipboard API from a page
 *  but still honours a copy of a selection made inside a user gesture. */
function copyBySelection(text: string): boolean {
  const field = document.createElement("textarea")
  field.value = text
  field.setAttribute("readonly", "")
  field.style.position = "fixed"
  field.style.opacity = "0"
  document.body.append(field)
  field.select()
  try {
    // Deprecated in the platform, yet the only copy some embedders allow.
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    field.remove()
  }
}

/** Runs the copy and shows its outcome on the button that asked for it. */
export async function copyFrom(button: HTMLElement, text: string): Promise<void> {
  if (!await copyText(text)) return
  const label = button.textContent
  button.textContent = "Copied"
  button.dataset.copied = ""
  setTimeout(() => {
    button.textContent = label
    delete button.dataset.copied
  }, COPIED_MS)
}

