/**
 * Headless Factory Wiring
 *
 * Creates a headless adapter as a WorkflowSessionFactories object.
 * Callers pass this to createSessionStore() or createWorkflowRunner().
 */

import type { WorkflowSessionFactories } from "../workflow-session"
import { createHeadlessAdapter } from "./headless-adapter"
import type { HeadlessAdapterOptions } from "./headless-adapter"

/**
 * Create headless factories for workflow sessions.
 *
 * Returns a WorkflowSessionFactories object — pass it to
 * createSessionStore() or createWorkflowRunner().
 */
export function createHeadlessFactories(opts?: HeadlessAdapterOptions): WorkflowSessionFactories {
  return {
    createAdapter: (_adapterOpts) => createHeadlessAdapter(opts),
  }
}
