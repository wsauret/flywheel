import type { MouseEvent } from "@opentui/core"

let clickActionPending = false

export function preventSelectionMouseDown(action: () => void): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    event.preventDefault()
    clickActionPending = true
    action()
  }
}

export function consumeClickAction(): boolean {
  if (!clickActionPending) return false
  clickActionPending = false
  return true
}
