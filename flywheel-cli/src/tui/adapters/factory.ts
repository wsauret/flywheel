/**
 * Adapter Factory
 *
 * Creates the appropriate UI adapter based on environment.
 * - TTY → OpenTUIAdapter (full rich terminal UI)
 * - No TTY → HeadlessAdapter (logging only, for CI/automation)
 */

import { OpenTUIAdapter, type OpenTUIAdapterOptions } from "./opentui"
import { HeadlessAdapter, type HeadlessAdapterOptions } from "./headless"
import type { IWorkflowUI } from "./types"

/**
 * Create an auto-detected adapter based on whether stdout is a TTY.
 *
 * @param ttyOptions - Options for the OpenTUI adapter (used when TTY detected)
 * @param headlessOptions - Options for the headless adapter (used when no TTY)
 */
export function createAutoAdapter(
  ttyOptions: OpenTUIAdapterOptions,
  headlessOptions?: HeadlessAdapterOptions,
): IWorkflowUI {
  if (process.stdout.isTTY) {
    return new OpenTUIAdapter(ttyOptions)
  }
  return new HeadlessAdapter(headlessOptions)
}
