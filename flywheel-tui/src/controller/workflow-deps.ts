/**
 * Shared workflow dependency preparation.
 *
 * Extracts the common config → engine → spawner setup used by
 * the shell's pipeline launch functions. Callers
 * wrap in try/catch for UI error handling.
 *
 * Errors propagate (throw) — callers decide how to surface them.
 */

import { loadConfig } from "../config/loader"
import { getEngine } from "../engines/core/registry"
import { BunProcessSpawner } from "../worker/bun-spawner"
import { SdkSpawner } from "../worker/sdk-spawner"
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
/**
 * Default spawner factory: selects BunProcessSpawner for subprocess-based
 * engines and SdkSpawner for SDK-based engines (OpenCode).
 */
function defaultCreateSpawner(timeout: number, engine: Engine): ProcessSpawner {
  // OpenCode uses the SDK spawner (HTTP API, not subprocess)
  if (engine.metadata.id === "opencode") {
    return new SdkSpawner()
  }
  // All other engines use subprocess spawning
  return new BunProcessSpawner({ timeoutMinutes: timeout })
}

export function prepareWorkflowDeps(overrides?: WorkflowDepsOverrides): WorkflowDeps {
  const load = overrides?.loadConfig ?? loadConfig
  const resolve = overrides?.getEngine ?? getEngine

  const { config } = load()

  const engine = resolve(config.engine)

  const spawner = overrides?.createSpawner
    ? overrides.createSpawner(config.timeout_minutes)
    : defaultCreateSpawner(config.timeout_minutes, engine)

  return { config, engine, spawner }
}
