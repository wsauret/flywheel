/**
 * TUI Exit Handler
 *
 * Provides a clean exit mechanism that ensures tracing is flushed
 * before the process terminates.
 */

// TODO: Replace with flywheel logger when available
const debug = (...args: unknown[]) => {
  if (process.env.DEBUG) console.debug('[tui:exit]', ...args);
};

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
  debug('[TUI Exit] exitTUI called with code=%d', code);

  if (exitResolver) {
    debug('[TUI Exit] Using registered exit resolver');
    exitResolver();
  } else {
    debug('[TUI Exit] No exit resolver, falling back to process.exit()');
    process.exit(code);
  }
}
