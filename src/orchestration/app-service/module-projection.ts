/** The runtime's one publication and mutation owner for the optional-capability
 *  selection (ARCH-PROTOCOL-036, ARCH-STRUCTURE-024).
 *
 *  The config file is the authority and the process policy is its live
 *  projection; this module is the protocol face of both. It publishes the
 *  complete view whenever the selection or the derived Workflows mode changes,
 *  and it performs the three capability mutations a client may ask for. A
 *  mutation publishes only after the write commits, so a refused or failed
 *  write leaves the runtime and every client exactly as they were. */

import type { ConfigFileLocation } from "../config/config-file.js"
import type { ModulePolicy } from "../config/module-policy.js"
import { createRuntimeConfigOwner, type RuntimeConfigOwner } from "../config/runtime-config-owner.js"
import { ConfigStaleWriteError, type ConfigWriteResult } from "../config/writer.js"
import { applyModulePreset, updateModuleMember, updatePersistentProcessPermission, updateWorkflowsMode } from "../config/module-selection-writer.js"
import { persistentProcessPolicy, type PersistentProcessPolicy } from "../config/persistent-process-policy.js"
import { composeRealmModuleSnapshot, moduleProtocolRows } from "../modules.js"
import {
  capabilitiesCursor,
  type BinaryModule,
  type ModulePreset,
  type RuntimeModulesView,
  type WorkflowsMode,
} from "../../protocol/module-protocol-types.js"
import type { RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js"

const MODULE_WARNING_SOURCE = "runtime:module-warning"
const MODULE_WARNING = { sourceId: MODULE_WARNING_SOURCE, title: "Module configuration needs attention", message: "Some modules could not be configured. Open Settings for details.", severity: "warning", action: { kind: "open-settings" } } as const

export interface ModuleProjection {
  /** The published view: the selected set, the derived Workflows mode, and the
   *  reason an invalid selection uses defaults or the last valid selection. */
  view(): RuntimeModulesView
  /** The one derivation every reader in this process shares. */
  workflowsMode(): WorkflowsMode
  setModule(moduleId: BinaryModule, expected: boolean, enabled: boolean): Promise<ConfigWriteResult>
  setModules(preset: ModulePreset, expected: { readonly moduleIds: readonly BinaryModule[]; readonly requireWorkflowConfirmation: boolean; readonly descriptorIdentity: string }): Promise<ConfigWriteResult>
  /** Workflows and its durable confirmation preference, changed together. */
  setWorkflowMode(expected: WorkflowsMode, mode: WorkflowsMode): Promise<ConfigWriteResult>
  /** Change persisted intent. The immutable CLI override remains effective. */
  setPersistentProcesses(expected: boolean, enabled: boolean): Promise<ConfigWriteResult>
  /** Re-read the file after an external replacement and settle every projection
   *  derived from the committed descriptor bytes. */
  refresh(): Promise<void>
  dispose(): Promise<void>
}

export async function createModuleProjection(options: {
  readonly location: ConfigFileLocation
  readonly capabilities: ModulePolicy
  readonly persistentProcesses: PersistentProcessPolicy
  readonly runtimeConfig?: RuntimeConfigOwner
  readonly publish: (input: RuntimeUiPatchInput) => void
  /** Activate selected process services before their surface is published. */
  readonly preparePublication?: () => void
  /** Settle every projection derived from the committed descriptor before a mutation resolves. */
  readonly settlePublication: () => Promise<void>
  readonly notify?: (episode: NotificationEpisodeInput) => void
}): Promise<ModuleProjection> {
  const runtimeConfig = options.runtimeConfig ?? await createRuntimeConfigOwner({ ...options.location, watch: false })
  const ownsRuntimeConfig = options.runtimeConfig === undefined
  let persistentProcesses = options.persistentProcesses
  const build = (): RuntimeModulesView => {
    // One descriptor, decoded once by the policy: the published selection and
    // the published Workflows mode always belong to the same configuration.
    const state = options.capabilities.state()
    const composition = composeRealmModuleSnapshot(state)
    return {
      capabilities: state.capabilities,
      moduleIds: state.moduleIds,
      descriptorIdentity: state.identity,
      modules: moduleProtocolRows(state.moduleIds),
      warnings: [...composition.warnings, ...(state.error === undefined ? [] : [state.error])],
      requireWorkflowConfirmation: state.requireWorkflowConfirmation,
      workflowsMode: state.workflowsMode,
      persistentProcesses,
      ...(state.error === undefined ? {} : { error: state.error }),
    }
  }

  let view = build()
  let warningActive: boolean | undefined
  const publishWarningCondition = (next: RuntimeModulesView): void => {
    const hasWarnings = next.warnings.length > 0
    if (warningActive === undefined && !hasWarnings) {
      warningActive = false
      return
    }
    if (hasWarnings === warningActive) return
    options.notify?.(hasWarnings ? { type: "raise", occurrence: MODULE_WARNING } : { type: "resolve", sourceId: MODULE_WARNING_SOURCE })
    warningActive = hasWarnings
  }
  publishWarningCondition(view)

  const republish = (): void => {
    const next = build()
    if (sameView(view, next)) return
    options.preparePublication?.()
    view = next
    publishWarningCondition(next)
    options.publish({ cursor: capabilitiesCursor(), payload: { kind: "modules.changed", capabilities: next } })
  }

  const unsubscribe = options.capabilities.onChange(() => { republish() })

  /** A committed write is the only thing that changes what clients hold. The
   *  policy re-reads the descriptor, then this owner waits until every derived
   *  projection has published from those bytes before mutation settlement. */
  const commit = async (write: () => Promise<ConfigWriteResult>, refreshPersistentProcesses = false): Promise<ConfigWriteResult> => {
    const result = await write()
    if (!result.ok) {
      // A stale refusal means the file can differ from this publication, for
      // example after a hand edit inside the watcher's window. Republish the
      // file now, so every client shows it and the next change succeeds.
      if (result.error instanceof ConfigStaleWriteError) await refresh()
      return result
    }
    await options.capabilities.refresh()
    if (refreshPersistentProcesses) {
      persistentProcesses = await persistentProcessPolicy({ ...options.location, forcedByCli: persistentProcesses.forcedByCli, owner: runtimeConfig })
    }
    republish()
    await options.settlePublication()
    return result
  }

  const refresh = async (): Promise<void> => {
    await options.capabilities.refresh()
    try {
      persistentProcesses = await persistentProcessPolicy({ ...options.location, forcedByCli: persistentProcesses.forcedByCli, owner: runtimeConfig })
    } catch {
      // An invalid unrelated setting must not erase the last valid process policy.
    }
    republish()
    await options.settlePublication()
  }
  // A repair can change only the selection error, not its effective module IDs.
  const unsubscribeConfig = runtimeConfig.subscribeAll(refresh)

  return {
    view: () => view,
    workflowsMode: () => view.workflowsMode,
    setModule: (moduleId, expected, enabled) => commit(() => updateModuleMember(moduleId, expected, enabled, options.location)),
    setModules: (preset, expected) => {
      const current = view;
      if (current.descriptorIdentity !== expected.descriptorIdentity) return Promise.resolve({ ok: false, error: new ConfigStaleWriteError() });
      return commit(() => applyModulePreset(preset, expected, options.location));
    },
    setWorkflowMode: (expected, mode) => commit(() => updateWorkflowsMode(expected, mode, options.location)),
    setPersistentProcesses: (expected, enabled) => commit(() => updatePersistentProcessPermission(expected, enabled, options.location), true),
    refresh,
    dispose: async () => {
      try {
        unsubscribe()
        await unsubscribeConfig()
      } finally {
        if (ownsRuntimeConfig) await runtimeConfig.dispose()
      }
    },
  }
}

function sameView(current: RuntimeModulesView, next: RuntimeModulesView): boolean {
  return JSON.stringify(current) === JSON.stringify(next)
}
