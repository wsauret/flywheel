/**
 * Shared workflow dependency preparation.
 *
 * Extracts the common config -> engine -> spawner setup used by
 * the shell's queue launch functions. Callers
 * wrap in try/catch for UI error handling.
 *
 * Errors propagate (throw) — callers decide how to surface them.
 */

import * as fs from "node:fs"
import { loadConfig } from "../config/loader.js"
import { CONFIG_FILES } from "../../infra/paths.js"
import { getEngine } from "./core/registry.js"
import { BunProcessSpawner } from "./subprocess/bun-spawner.js"
import type { FlywheelConfig } from "../config/schema.js"
import type { Engine } from "./core/types.js"
import type { ProcessSpawner } from "./subprocess/spawner.js"

export interface WorkflowDeps {
  config: FlywheelConfig
  engine: Engine
  spawner: ProcessSpawner
}

/** Dependency injection hooks for testing. Lives here (not in tests/) because
 *  prepareWorkflowDeps uses it as a parameter type. */
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
  const load = overrides?.loadConfig ?? (() => {
    const configPath = CONFIG_FILES.find((p) => fs.existsSync(p))
    return loadConfig(configPath)
  })
  const resolve = overrides?.getEngine ?? getEngine

  const { config } = load()

  const engine = resolve(config.engine)

  const spawner = overrides?.createSpawner
    ? overrides.createSpawner(config.timeout_minutes)
    : new BunProcessSpawner({ timeoutMinutes: config.timeout_minutes })

  return { config, engine, spawner }
}
