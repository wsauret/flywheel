import { loadConfig } from "../config/loader.js"
import { findConfigFile } from "../../infra/paths.js"
import { resolveAuthContext } from "../../infra/auth/auth-context.js"
import { getEngine } from "./core/registry.js"
import type { AuthContext } from "../../infra/auth/auth-context.js"
import type { FlywheelConfig } from "../config/schema.js"
import type { Engine } from "./core/types.js"

export interface WorkflowDeps {
  config: FlywheelConfig
  engine: Engine
  auth: AuthContext
}

/** Dependency injection hooks for testing. Lives here (not in tests/) because
 *  prepareWorkflowDeps uses it as a parameter type. */
export interface WorkflowDepsOverrides {
  loadConfig?: () => { config: FlywheelConfig; warnings: string[] }
  getEngine?: (id: string) => Engine
  auth?: AuthContext
}

export function prepareWorkflowDeps(overrides?: WorkflowDepsOverrides): WorkflowDeps {
  const load = overrides?.loadConfig ?? (() => {
    const configPath = findConfigFile()
    return loadConfig(configPath)
  })
  const resolve = overrides?.getEngine ?? getEngine

  const { config } = load()
  const engine = resolve(config.engine)
  const auth = overrides?.auth ?? resolveAuthContext({ openaiAuth: config.openai_auth })

  return { config, engine, auth }
}
