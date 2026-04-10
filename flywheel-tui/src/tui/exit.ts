/**
 * Global TUI exit function — extracted to a non-JSX module
 * so that hooks can import it without triggering JSX resolution.
 *
 * Supports an async pre-exit cleanup hook so disposal (flush traces,
 * close file handles) can be awaited before the renderer is destroyed.
 */

let globalExit: (() => void) | null = null
let preExitCleanup: (() => Promise<void>) | null = null

export function exitTUI(): void {
  if (!globalExit) {
    // globalExit already consumed — a prior exitTUI() call is stuck on cleanup.
    // Force-exit as a last resort so the user is never trapped.
    process.exit(0)
    return
  }
  const exit = globalExit
  globalExit = null

  const cleanup = preExitCleanup
  preExitCleanup = null

  if (cleanup) {
    // Await disposal, then destroy renderer and resolve the startTUI promise.
    // Hard timeout: if cleanup doesn't finish in 3s, force-exit anyway.
    // The user must never be trapped in a dead TUI.
    const forceExitTimer = setTimeout(() => { exit() }, 3_000)
    cleanup().catch(() => {}).finally(() => { clearTimeout(forceExitTimer); exit() })
  } else {
    exit()
  }
}

export function setExitHandler(handler: () => void): void {
  globalExit = handler
}

/**
 * Register an async cleanup function that runs before the renderer is destroyed.
 * Used by FlywheelShell to ensure registry.disposeAll() is awaited on exit.
 */
export function registerPreExitCleanup(fn: () => Promise<void>): void {
  preExitCleanup = fn
}
