/**
 * Global TUI exit function — extracted to a non-JSX module
 * so that hooks can import it without triggering JSX resolution.
 */

let globalExit: (() => void) | null = null

export function exitTUI(): void {
  if (globalExit) {
    globalExit()
    globalExit = null
  }
}

export function setExitHandler(handler: () => void): void {
  globalExit = handler
}
