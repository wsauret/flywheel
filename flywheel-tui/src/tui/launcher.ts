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

import { Log } from "../infra/log.js"

const log = Log.create({ service: "launcher" })

// Only load preload in dev mode (when running from source)
// In production binaries, JSX is pre-transformed during build
const isDev = import.meta.url.includes('/src/')
log.debug("init", { isDev })
if (isDev) {
  log.debug("loading OpenTUI preload")
  await import("@opentui/solid/preload")
  log.debug("OpenTUI preload loaded")
}

// Apply framework patches (must run before any TUI components are created)
await import("./text-wrap-resize-patch")
log.debug("framework patches applied")

// Re-export type for callers
export type { TUIOptions } from "./app"

// These look like forwarding functions but the dynamic import is load-order
// architecture: this module's top-level await registers the OpenTUI plugin and
// framework patches BEFORE any JSX in app.tsx is parsed. A static import would
// break dev mode because the plugin wouldn't be registered in time.
export async function startTUI(options: import("./app").TUIOptions = {}) {
  log.debug("startTUI called")
  try {
    const app = await import("./app.js");
    log.debug("app module imported")
    const result = await app.startTUI(options);
    log.debug("app.startTUI returned")
    return result;
  } catch (err) {
    log.error("startTUI failed", { error: err instanceof Error ? err : String(err) })
    throw err;
  }
}

export async function exitTUI() {
  log.debug("exitTUI called")
  try {
    const app = await import("./app.js");
    app.exitTUI();
    log.debug("TUI exited")
  } catch (err) {
    log.error("exitTUI failed", { error: err instanceof Error ? err : String(err) })
  }
}


