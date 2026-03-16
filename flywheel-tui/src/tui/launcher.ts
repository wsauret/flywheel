/**
 * TUI Runtime Launcher
 *
 * This module loads the OpenTUI SolidJS transform ONLY for TUI components,
 * preventing the global Babel transform from affecting React/Ink UI files.
 *
 * The preload registers a Bun plugin that transforms JSX in files imported
 * AFTER this module. Since React/Ink workflow UI is loaded in a separate
 * import chain (via lazy import in routes/home.tsx), it remains unaffected.
 *
 * Architecture:
 * - Dev mode: Preload registers transform plugin for runtime compilation
 * - Compiled binaries: JSX already transformed at build time, preload not needed
 *
 * IMPORTANT: We must import preload first, THEN dynamically import app.js
 * to ensure the plugin is registered before any JSX files are parsed.
 */

// TODO: Replace with flywheel logger when available
const debug = (...args: unknown[]) => {
  if (process.env.DEBUG) console.debug('[tui:launcher]', ...args);
};

// Only load preload in dev mode (when running from source)
// In production binaries, JSX is pre-transformed during build
const isDev = import.meta.url.includes('/src/')
debug('[Launcher] isDev=%s', isDev);
if (isDev) {
  debug('[Launcher] Loading OpenTUI preload');
  await import("@opentui/solid/preload")
  debug('[Launcher] OpenTUI preload loaded');
}

// Re-export type for callers
export type { TUIOptions } from "./app"

// Dynamic import ensures app.js is loaded AFTER preload is registered (in dev)
export async function startTUI(options: import("./app").TUIOptions = {}) {
  debug('[Launcher] startTUI() called');
  debug('[Launcher] Importing TUI app module');
  try {
    const app = await import("./app.js");
    debug('[Launcher] app.js imported successfully');
    debug('[Launcher] Calling app.startTUI()');
    const result = await app.startTUI(options);
    debug('[Launcher] app.startTUI() returned');
    return result;
  } catch (err) {
    debug('[Launcher] Error: %s', err);
    throw err;
  }
}

export async function exitTUI() {
  debug('[Launcher] exitTUI() called');
  try {
    const app = await import("./app.js");
    app.exitTUI();
    debug('[Launcher] TUI exited');
  } catch (err) {
    debug('[Launcher] Error exiting TUI: %s', err);
  }
}

/** @deprecated Use exitTUI() instead */
export const destroyTUI = exitTUI;
