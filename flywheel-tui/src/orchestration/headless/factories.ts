/**
 * Headless Factory Wiring
 *
 * Creates headless implementations (timer, adapter) as a
 * WorkflowSessionFactories object. Callers pass this to
 * createSessionRegistry() or createWorkflowRunner().
 */

import type { WorkflowSessionFactories } from "../workflow-session"
import { createHeadlessAdapter } from "./headless-adapter"
import type { HeadlessAdapterOptions } from "./headless-adapter"

/**
 * Create headless factories for workflow sessions.
 *
 * Returns a WorkflowSessionFactories object — pass it to
 * createSessionRegistry() or createWorkflowRunner().
 */
export function createHeadlessFactories(opts?: HeadlessAdapterOptions): WorkflowSessionFactories {
  return {
    createAdapter: (_adapterOpts) => createHeadlessAdapter(opts),
    // TUI's TimerService drives display refresh ticks. Headless has no display,
    // so this is intentionally a no-op.
    createTimer: () => ({ stop() {} }),
  }
}
