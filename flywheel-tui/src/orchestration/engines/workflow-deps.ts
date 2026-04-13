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
import { loadConfig } from "../config/loader"
import { CONFIG_FILES } from "../../infra/paths"
import { getEngine } from "./core/registry"
import { BunProcessSpawner } from "./subprocess/bun-spawner"
import type { FlywheelConfig } from "../config/schema"
import type { Engine } from "./core/types"
import type { ProcessSpawner } from "./subprocess/spawner"

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
