/**
 * Headless Factory Wiring
 *
 * Registers headless implementations (store, timer, adapter) via the
 * existing provideSessionFactories() injection point. This is the
 * single entry point for headless mode setup — no second singleton.
 */

import { provideSessionFactories } from "../workflow-session"
import { createHeadlessStore } from "./headless-store"
import { createHeadlessTimer } from "./headless-timer"
import { createHeadlessAdapter } from "./headless-adapter"
import type { HeadlessAdapterOptions } from "./headless-adapter"

/**
 * Wire headless factories into the session DI boundary.
 *
 * Call once at startup before any createWorkflowSession() calls.
 * Options are forwarded to HeadlessAdapter for logging configuration.
 */
export function provideHeadlessFactories(opts?: HeadlessAdapterOptions): void {
  provideSessionFactories({
    createStore: (_key: string) => createHeadlessStore(),
    createAdapter: (_adapterOpts) => createHeadlessAdapter(opts),
    createTimer: () => createHeadlessTimer(),
  })
}
