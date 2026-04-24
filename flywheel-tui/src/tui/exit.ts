// Module-scoped because the exit handler is process-global by nature — the terminal
// state, SIGINT handler, and renderer instance all have one-per-process identity.
// Converting to a factory + DI would thread props through shell.tsx and app.tsx for
// no new capability (there is no second exit controller to inject). Consistent with
// ADR-006's supreme principle: when a rule produces indirection without depth, don't.

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
