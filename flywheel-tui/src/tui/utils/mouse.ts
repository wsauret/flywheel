import type { MouseEvent } from "@opentui/core"

export function preventSelectionMouseDown(action: () => void): (event: MouseEvent) => void {
  return (event: MouseEvent): void => {
    event.preventDefault()
    action()
  }
}
