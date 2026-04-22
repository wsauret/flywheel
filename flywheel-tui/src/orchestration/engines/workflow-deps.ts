import { loadConfig } from "../config/loader.js"
import { findConfigFile } from "../../infra/paths.js"
import { getEngine } from "./core/registry.js"
import type { FlywheelConfig } from "../config/schema.js"
import type { Engine } from "./core/types.js"

export interface WorkflowDeps {
  config: FlywheelConfig
  engine: Engine
}

/** Dependency injection hooks for testing. Lives here (not in tests/) because
 *  prepareWorkflowDeps uses it as a parameter type. */
interface WorkflowDepsOverrides {
  loadConfig?: () => { config: FlywheelConfig; warnings: string[] }
  getEngine?: (id: string) => Engine
}

export function prepareWorkflowDeps(overrides?: WorkflowDepsOverrides): WorkflowDeps {
  const load = overrides?.loadConfig ?? (() => {
    const configPath = findConfigFile()
    return loadConfig(configPath)
  })
  const resolve = overrides?.getEngine ?? getEngine

  const { config } = load()
  if (config.openai_auth && !process.env["FLYWHEEL_OPENAI_AUTH"]) {
    process.env["FLYWHEEL_OPENAI_AUTH"] = config.openai_auth
  }

  const engine = resolve(config.engine)

  return { config, engine }
}
