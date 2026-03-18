/**
 * Shared workflow dependency preparation.
 *
 * Extracts the common config → engine → spawner setup used by both
 * startWorkWorkflow and startGenericWorkflow in the shell. Callers
 * wrap in try/catch for UI error handling.
 *
 * Errors propagate (throw) — callers decide how to surface them.
 */

import { loadConfig } from "../config/loader"
import { getEngine } from "../engines/core/registry"
import { BunProcessSpawner } from "../worker/bun-spawner"
import type { FlywheelConfig } from "../config/loader"
import type { Engine } from "../engines/core/types"
import type { ProcessSpawner } from "../worker/spawner"

export interface WorkflowDeps {
  config: FlywheelConfig
  engine: Engine
  spawner: ProcessSpawner
}

/** Dependency injection hooks for testing. */
export interface WorkflowDepsOverrides {
  loadConfig?: () => { config: FlywheelConfig; warnings: string[] }
  getEngine?: (id: string) => Engine
  createSpawner?: (timeoutMinutes: number) => ProcessSpawner
}

/**
 * Load config, resolve engine, and create a process spawner.
 *
 * @param overrides  Optional DI hooks (used in tests)
 * @throws if config is invalid or the engine ID is unknown
 */
export function prepareWorkflowDeps(overrides?: WorkflowDepsOverrides): WorkflowDeps {
  const load = overrides?.loadConfig ?? loadConfig
  const resolve = overrides?.getEngine ?? getEngine
  const spawn = overrides?.createSpawner ?? ((timeout: number) =>
    new BunProcessSpawner({ timeoutMinutes: timeout }))

  const { config } = load()

  const engine = resolve(config.engine)

  const spawner = spawn(config.timeout_minutes)

  return { config, engine, spawner }
}
