/**
 * Headless Workflow Store
 *
 * Minimal WorkflowStore implementation for headless (CLI) mode.
 * Tracks modelActivity in memory; returns outputBlocks: undefined since
 * traces capture everything in headless mode.
 */

import type { WorkflowStore } from "../workflow-session"
import type { ModelActivity } from "../../infra/events"

export function createHeadlessStore(): WorkflowStore {
  let modelActivity: ModelActivity = "idle"

  const subs = new Set<() => void>()
  const execSubs = new Set<() => void>()

  function notify(): void {
    for (const cb of subs) {
      try { cb() } catch { /* subscriber errors must not propagate */ }
    }
  }

  function notifyExecution(): void {
    for (const cb of execSubs) {
      try { cb() } catch { /* subscriber errors must not propagate */ }
    }
  }

  function startWorkflow(_description: string): void {
    modelActivity = "idle"
    notify()
    notifyExecution()
  }

  function getState() {
    return { modelActivity, outputBlocks: undefined }
  }

  function subscribe(cb: () => void): () => void {
    subs.add(cb)
    return () => { subs.delete(cb) }
  }

  function subscribeExecution(cb: () => void): () => void {
    execSubs.add(cb)
    return () => { execSubs.delete(cb) }
  }

  return { startWorkflow, getState, subscribe, subscribeExecution }
}
