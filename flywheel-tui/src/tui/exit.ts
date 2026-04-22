let globalExit: (() => void) | null = null
let preExitCleanup: (() => Promise<void>) | null = null

export function exitTUI(): void {
  if (!globalExit) {
    process.exit(0)
    return
  }
  const exit = globalExit
  globalExit = null

  const cleanup = preExitCleanup
  preExitCleanup = null

  if (cleanup) {
    // 3s hard timeout — user must never be trapped in a dead TUI.
    const forceExitTimer = setTimeout(() => { exit() }, 3_000)
    cleanup().catch(() => {}).finally(() => { clearTimeout(forceExitTimer); exit() })
  } else {
    exit()
  }
}

export function setExitHandler(handler: () => void): void {
  globalExit = handler
}

export function registerPreExitCleanup(fn: () => Promise<void>): void {
  preExitCleanup = fn
}
