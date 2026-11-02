import { ConfigStaleWriteError, type ConfigWriteResult } from "../config/writer.js"
import type { FrontendMutation, MutationResult } from "../../protocol/app-service-types.js"
import type { FlywheelAppServiceDeps } from "./app-service.js"

/** The settings mutations: configuration values, module selection, workflow
 *  mode, persistent processes, and automatic updates. Every one is a
 *  compare-and-set against a projection its owner holds, and every one
 *  reports through the same result shape. The account service owns automatic
 *  updates and answers that one itself, so an executor never receives it. */
export type SettingsMutation = Extract<FrontendMutation, { type: `config.${string}` | `settings.${string}` }>

export function isSettingsMutation(mutation: FrontendMutation): mutation is SettingsMutation {
  return mutation.type.startsWith("config.") || mutation.type.startsWith("settings.")
}

/** Why an executor refuses an update read or write: it reached a placement
 *  that does not own updates (ARCH-RUNTIME-043). */
export const ACCOUNT_UPDATES_ONLY = "Updates are served by the account service, never by a project executor"

export async function dispatchSettingsMutation(deps: Pick<FlywheelAppServiceDeps, "config" | "capabilities">, mutation: SettingsMutation): Promise<MutationResult<FrontendMutation>> {
  if (mutation.type === "config.mutate" || mutation.type === "config.reset") {
    return deps.config.mutate(mutation)
  }
  if (mutation.type === "settings.set_module") {
    return settingsWriteResult(await deps.capabilities.setModule(mutation.moduleId, mutation.expected, mutation.enabled))
  }
  if (mutation.type === "settings.set_modules") {
    return settingsWriteResult(await deps.capabilities.setModules(mutation.preset, mutation.expected))
  }
  if (mutation.type === "settings.set_workflow_mode") {
    return settingsWriteResult(await deps.capabilities.setWorkflowMode(mutation.expected, mutation.mode))
  }
  if (mutation.type === "settings.set_persistent_processes") {
    return settingsWriteResult(await deps.capabilities.setPersistentProcesses(mutation.expected, mutation.enabled))
  }
  if (mutation.type === "settings.set_update_auto_install") throw new Error(ACCOUNT_UPDATES_ONLY)
  const unhandled: never = mutation
  throw new Error(`Settings mutation has no handler: ${JSON.stringify(unhandled)}`)
}

export function settingsWriteResult(result: ConfigWriteResult): MutationResult {
  if (!result.ok) return result.error instanceof ConfigStaleWriteError
    ? { ok: false, kind: "stale", error: result.error.message }
    : { ok: false, error: result.error.message }
  if (result.durabilityError) return { ok: false, error: `Capability change applied, but it may not survive a crash: ${result.durabilityError.message}` }
  return { ok: true }
}
