/**
 * TUI Exit Handler
 *
 * Provides a clean exit mechanism that ensures tracing is flushed
 * before the process terminates.
 */

import { Log } from "../utils/log"

const log = Log.create({ service: "exit" })

let exitResolver: (() => void) | null = null;

/**
 * Register the exit resolver from app.tsx
 * This allows exitTUI() to resolve the render promise instead of calling process.exit()
 */
export function registerExitResolver(resolver: () => void): void {
  exitResolver = resolver;
}

/**
 * Exit the TUI cleanly
 * If an exit resolver is registered, it will be called to allow proper cleanup.
 * Otherwise, falls back to process.exit() (which may not flush tracing).
 */
export function exitTUI(code: number = 0): void {
  log.debug("exitTUI called", { code })

  if (exitResolver) {
    log.debug("using registered exit resolver")
    exitResolver();
  } else {
    log.debug("no exit resolver, falling back to process.exit()")
    process.exit(code);
  }
}
