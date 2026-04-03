/**
 * Shared workflow dependency preparation.
 *
 * Extracts the common config → engine → spawner setup used by
 * the shell's queue launch functions. Callers
 * wrap in try/catch for UI error handling.
 *
 * Errors propagate (throw) — callers decide how to surface them.
 */

import * as fs from "node:fs"
import { loadConfig } from "../config/loader"
import { CONFIG_FILES } from "../config/paths"
import { getEngine } from "./core/registry"
import { BunProcessSpawner } from "../worker/bun-spawner"
import { SdkSpawner } from "../worker/sdk-spawner"
import { HarnessSpawner } from "../worker/harness-spawner"
import type { FlywheelConfig } from "../config/loader"
import type { Engine } from "./core/types"
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
  // Harness runs in-process via the agent loop
  if (engine.metadata.id === "harness") {
    return new HarnessSpawner()
  }
  // All other engines use subprocess spawning
  return new BunProcessSpawner({ timeoutMinutes: timeout })
}

export function prepareWorkflowDeps(overrides?: WorkflowDepsOverrides): WorkflowDeps {
  const load = overrides?.loadConfig ?? (() => {
    const configPath = CONFIG_FILES.find((p) => fs.existsSync(p))
    return loadConfig(configPath)
  })
  const resolve = overrides?.getEngine ?? getEngine

  const { config } = load()

  const engine = resolve(config.engine)

  const spawner = overrides?.createSpawner
    ? overrides.createSpawner(config.timeout_minutes)
    : defaultCreateSpawner(config.timeout_minutes, engine)

  return { config, engine, spawner }
}
