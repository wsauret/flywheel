import { mock } from "bun:test"
import type { ModuleRow, ModuleRowAction } from "../../../../src/protocol/protocol-module.js"
import { createSignal } from "solid-js"
import { createModalStack } from "../../../../src/tui/components/modal-stack.js"
import { testDirectories } from "../../../helpers/directories.js"
import type { UpdateStatusView } from "../../../../src/protocol/update-protocol-types.js"
import { createSettingsStore, type SettingsOperations } from "../../../../src/tui/hooks/create-settings-store.js"
import { useSettingsModal, type SettingsModalHook } from "../../../../src/tui/hooks/use-settings-modal.js"
import { createAuthProfileSelection } from "../../../../src/tui/hooks/auth-profile-selection.js"
import type { RuntimeModulesView, WorkflowsMode } from "../../../../src/protocol/module-protocol-types.js"
import type { RuntimeAuthView } from "../../../../src/protocol/auth-status-protocol-types.js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeAuthProfileMutation, RuntimeAuthProfileMutationResult } from "../../../../src/protocol/auth-profile-selection-protocol-types.js"
import { runtimeDispatch, runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import { MODULE_PRESETS, effectiveModuleIds as effectiveSelection, normalizeModuleSelection, moduleProtocolRows, workflowsModeOf, type ModuleId } from "../../../../src/orchestration/modules.js"
import { decodeModuleState } from "../../../../src/orchestration/config/module-descriptor.js"
import type { SettingsRow } from "../../../../src/tui/hooks/settings-modal-types.js"
import type { SettingsDestination } from "../../../../src/tui/settings-destination.js"
import type { RuntimeConfigMutation, RuntimeConfigMutationResult, RuntimeConfigValues, RuntimeConfigView } from "../../../../src/protocol/runtime-config-protocol-types.js"

import { canonicalModuleIds, MODULE_IDS, persistedDisabledModuleIds } from "../../../../src/protocol/module-ids.js"
export const DIRECTORIES = testDirectories(process.cwd())
const launcher: import("../../../../src/infra/process-supervisor.js").LauncherScope = {
  spawnOwned: () => { throw new Error("no process launch in this test") },
  adoptOwned: () => { throw new Error("no command adoption in this test") },
  open: () => launcher,
  close: async () => ({ settled: true, terminated: 0, remaining: 0 }),
}
export const okWrite = { ok: true } as const
export type WriteResult = { ok: true } | { ok: false; error: Error }
export type PolicyResult = { ok: true } | { ok: false; error: { message: string } }
export const updateShowThinking = mock((_value: boolean, _options?: unknown): WriteResult => okWrite)
export const updateDiffColors = mock((_value: "theme" | "standard", _options?: unknown) => okWrite)
export const updateCompatibleRendering = mock((_value: "auto" | "on" | "off", _options?: unknown) => okWrite)
export const updateProactiveCompactionThreshold = mock((_value: number, _options?: unknown) => okWrite)
export const updateWebSearchProvider = mock((_value: "chatgpt" | "exa", _options?: unknown) => okWrite)
export const refreshRuntime = mock(async () => {})
export const installBundledFont = mock(async () => ({ status: fontStatus, installedFiles: [], targetDir: "/scratch/fonts", warnings: [] }))
export const fontStatus = { installed: false, installedFiles: [], missingFiles: ["font.otf"], sourceDir: "/src", targetDir: "/scratch/fonts", installable: true }

export const settingsOperations = {
  getFontStatus: () => fontStatus,
  installBundledFont,
  fontInstallSummary: () => "Installed font",
} satisfies SettingsOperations

/** The Copilot cap as the module declares it, for the rows the fixtures exercise. */
export const COPILOT_CAP = { control: "number", key: "monthly_credit_cap", label: "Copilot monthly credit cap", description: "Monthly AI Credits cap for pooled Copilot seats. 0 means no cap.", min: 0, max: 1_000_000, off: 0, defaultValue: 3_900, group: "Model providers", providerId: "github_copilot" } as const
export const COPILOT_CAP_ROW_ID = `provider-setting:${COPILOT_CAP.providerId}:${COPILOT_CAP.key}`
export const profileConfig = (monthlyCreditCap = 3_900, gitAiAttribution = false, allowTrainingRoutes = false) => ({ gitAiAttribution, allowTrainingRoutes, roles: {}, providers: { github_copilot: { monthly_credit_cap: monthlyCreditCap } } })



/** Settings row ids, which the modal keys as plain strings. */
export const CAPABILITY_ROW_IDS: readonly string[] = moduleProtocolRows(MODULE_IDS).flatMap((module) => module.setting === undefined ? [] : [module.setting.control === "workflow-mode" ? "workflow-mode" : module.id])
export const PRESET_ROW_ID = "capability-preset"
export const UNKNOWN_ID_ERROR = 'features contains unknown capability id(s): "mind_reading"'

export function clearMocks(): void {
  updateShowThinking.mockClear()
  updateDiffColors.mockClear()
  updateCompatibleRendering.mockClear()
  updateProactiveCompactionThreshold.mockClear()
  updateWebSearchProvider.mockClear()
  installBundledFont.mockClear()
  refreshRuntime.mockClear()
}

export function moduleDescriptorIdentity(moduleIds: readonly string[], requireWorkflowConfirmation: boolean): string {
  const disabled = persistedDisabledModuleIds(moduleIds)
  const source = `${disabled.length === 0 ? "" : `disabled_modules = ${JSON.stringify(disabled)}\n`}require_workflow_confirmation = ${requireWorkflowConfirmation}\n`
  return decodeModuleState(source).identity
}

/** Stands in for the runtime capability projection and the three mutations a
 *  client may ask for. It derives the published view and refuses an invalid
 *  dependency the way the runtime does, so the modal is exercised against real
 *  capability semantics instead of a hand-written view. A mutation publishes
 *  only what it committed, which is the modal's sole source of row values. */
export function moduleRuntime(options: {
  capabilities?: readonly ModuleId[]
  confirmationRequired?: boolean
  error?: string
  persistentProcesses?: { persisted: boolean; effective: boolean; forcedByCli: boolean }
  hydrated?: boolean
} = {}) {
  let selected = canonicalModuleIds(options.capabilities ?? MODULE_IDS)
  let moduleIds: readonly ModuleId[] = options.capabilities === undefined ? MODULE_IDS : selected
  let confirmationRequired = options.confirmationRequired ?? true
  let error = options.error
  let persistentProcesses = options.persistentProcesses ?? { persisted: false, effective: false, forcedByCli: false }
  const [view, setView] = createSignal<RuntimeModulesView | undefined>()

  function publish(): void {
    const effectiveModuleIds = error === undefined ? moduleIds : []
    // Production derives capabilities and the Workflows mode from the
    // effective selection, where a module whose dependency is off is off.
    const effective = effectiveSelection(selected)
    setView({
      capabilities: effective,
      moduleIds: effectiveModuleIds,
      descriptorIdentity: moduleDescriptorIdentity(moduleIds, confirmationRequired),
      modules: moduleProtocolRows(effectiveModuleIds),
      warnings: [],
      requireWorkflowConfirmation: confirmationRequired,
      workflowsMode: workflowsModeOf(effective, confirmationRequired),
      persistentProcesses,
      ...(error === undefined ? {} : { error }),
    })
  }
  if (options.hydrated !== false) publish()

  function commit(next: readonly ModuleId[], nextConfirmation = confirmationRequired, nextModuleIds: readonly ModuleId[] = next): PolicyResult {
    const canonical = canonicalModuleIds(next)
    const normalized = normalizeModuleSelection(canonical)
    if (!normalized.ok) return { ok: false, error: { message: normalized.error } }
    selected = canonical
    moduleIds = nextModuleIds
    confirmationRequired = nextConfirmation
    error = undefined
    publish()
    return { ok: true }
  }

  const setModule = mock(async (feature: ModuleId, _expected: boolean, enabled: boolean): Promise<PolicyResult> => {
    const nextModules = enabled ? [...moduleIds, feature] : moduleIds.filter((member) => member !== feature)
    const nextCapabilities = MODULE_IDS.filter((capability) => nextModules.includes(capability))
    return commit(nextCapabilities, confirmationRequired, nextModules)
  })
  const setModules = mock(async (preset: "minimal" | "full", _expected: { descriptorIdentity: string }): Promise<PolicyResult> => commit(
    MODULE_PRESETS[preset].moduleIds,
    preset === "full" ? true : confirmationRequired,
    preset === "full" ? MODULE_IDS : [],
  ))
  const setWorkflowMode = mock(async (_expected: WorkflowsMode, mode: WorkflowsMode): Promise<PolicyResult> => {
    const next: readonly ModuleId[] = mode === "off" ? selected.filter((member) => member !== "workflows") : [...selected, "workflows"]
    const nextModuleIds: readonly ModuleId[] = mode === "off" ? moduleIds.filter((member) => member !== "workflows") : [...moduleIds, "workflows"]
    return commit(next, mode === "ask", nextModuleIds)
  })

  const setPersistentProcesses = mock(async (_expected: boolean, enabled: boolean): Promise<PolicyResult> => {
    persistentProcesses = {
      persisted: enabled,
      effective: persistentProcesses.forcedByCli || enabled,
      forcedByCli: persistentProcesses.forcedByCli,
    }
    publish()
    return { ok: true }
  })
  return {
    capabilities: { view, setModule, setModules, setWorkflowMode, setPersistentProcesses },
    hydrate: publish,
    /** An external replacement, as a config edit outside this process makes it. */
    replace: (next: readonly ModuleId[]) => {
      selected = canonicalModuleIds(next)
      moduleIds = selected
      publish()
    },
    publishError: (message: string) => {
      error = message
      publish()
    },
    clearError: () => {
      error = undefined
      publish()
    },
    confirmationRequired: () => confirmationRequired,
  }
}

export function configValues(overrides: Partial<RuntimeConfigValues> = {}): RuntimeConfigValues {
  return {
    theme: "flywheel", moduleSelection: [], allowPersistentProcesses: false, foregroundBashHoldSeconds: 2,
    showThinking: true, idleCompaction: true, autoDeleteSessionDays: 0, writeSyntaxTheme: "nord", requireWorkflowConfirmation: true,
    diffColors: "theme", compatibleRendering: "auto", webSearchProvider: "chatgpt",
    fontTipDismissed: false, tabsHintDismissed: false, proactiveCompactionThreshold: 270_000, showBuild: false,
    moduleSections: { subscription_usage: { alert_thresholds: [] }, remote: { keep_awake: true } }, autoInstall: true,
    profiles: { default: profileConfig() }, keybindings: {}, budget: { max_invocations: 10, max_tokens: 10, max_wall_clock_minutes: 10 },
    workflow: { max_attempts: 10 }, notificationsDesktop: true,
    ...overrides,
  }
}

export function createModal(options: {
  initialProactiveCompactionThreshold?: number
  initialCopilotMonthlyCreditCap?: number
  siblingCopilotMonthlyCreditCap?: number
  initialUpdateAutoInstall?: boolean
  /** Stands in for `FLYWHEEL_DISABLE_AUTOUPDATE`. The durable value moves and
   *  the effective one does not, which is the case a fixture that echoed back
   *  the requested value could not express at all. */
  updateOverrideHoldsOff?: boolean
  runtime?: ReturnType<typeof moduleRuntime>
  authView?: RuntimeAuthView
  foregroundSessionId?: string
  configStatus?: RuntimeConfigView["status"]
  configWarnings?: RuntimeConfigView["warnings"]
  configDiagnostics?: RuntimeConfigView["diagnostics"]
  /** The Settings rows the modules contribute. */
  moduleRows?: readonly ModuleRow[]
} = {}) {
  const modals = createModalStack()
  const showToast = mock(() => {})
  const openThemeModal = mock(() => {})
  const openModelsModal = mock(() => {})
  const openSessionsModal = mock(() => {})
  const openStatusModal = mock(() => {})
  const openAuthModal = mock(() => {})
  const activateModuleRow = mock((_action: ModuleRowAction) => {})
  const openSettingsDestination = mock(async (destination: SettingsDestination) => {
    if (destination.kind === "models") openModelsModal()
    else if (destination.kind === "auth") openAuthModal()
  })
  // Stands in for the workspace update projection: the runtime publishes the
  // policy, so a successful command is only observable through this view. The
  // policy is derived the way the service derives it, never echoed.
  const overrideHoldsOff = options.updateOverrideHoldsOff ?? false
  const autoInstallView = (persisted: boolean) => ({ persisted, forcedOff: overrideHoldsOff, effective: persisted && !overrideHoldsOff })
  const [updateStatus, publishUpdateStatus] = createSignal<UpdateStatusView | undefined>(
    options.initialUpdateAutoInstall === undefined
      ? undefined
      : { revision: 1, autoInstall: autoInstallView(options.initialUpdateAutoInstall), status: { kind: "idle" } },
  )
  const setUpdateAutoInstall = mock(async (_expected: boolean, value: boolean): Promise<WriteResult> => {
    publishUpdateStatus({ revision: 2, autoInstall: autoInstallView(value), status: { kind: "idle" } })
    return okWrite
  })
  const runtime = options.runtime ?? moduleRuntime()
  const [auth, publishAuth] = createSignal<RuntimeAuthView | undefined>(options.authView ?? {
    providers: [],
    warnings: [],
    authFilePath: "/profiles/default/auth.json",
    profile: { id: "default", displayName: "Default", source: "default", availableProfiles: [{ id: "default", displayName: "Default" }, { id: "work", displayName: "Work" }] },
    subscriptionSpendConsent: { kind: "available", profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] },
  })
  const [foregroundSessionId] = createSignal(options.foregroundSessionId)
  const [gitAiAttributionStatus] = createSignal({ kind: "available" as const })
  const dispatch = mock(async (command: RuntimeAuthProfileMutation): Promise<RuntimeAuthProfileMutationResult> => {
    if (command.type === "auth.profile.create") return { id: command.displayName }
    if (command.type === "auth.profile.rename") return { id: command.id, displayName: command.displayName }
    if (command.type === "auth.profile.unbind_current_project") return { bound: false }
    return { id: command.id }
  })
  const authProfiles = runtimeDispatch({
    "auth.profile.select": dispatch, "auth.profile.create": dispatch, "auth.profile.rename": dispatch,
    "auth.profile.bind_current_project": dispatch, "auth.profile.unbind_current_project": dispatch, "auth.profile.delete": dispatch,
  })
  const query = mock(async (): Promise<import("../../../../src/protocol/auth-profile-selection-protocol-types.js").RuntimeAuthProfileDeletionPreview> => ({ kind: "automatic", source: { id: "work", displayName: "Work" }, successor: { id: "default", displayName: "Default" } }))
  const [config, publishConfig] = createSignal<RuntimeConfigView>({
    revision: 1,
    values: configValues({
      proactiveCompactionThreshold: options.initialProactiveCompactionThreshold ?? 270_000,
      profiles: { default: profileConfig(options.initialCopilotMonthlyCreditCap ?? 3_900), work: profileConfig(options.siblingCopilotMonthlyCreditCap ?? 3_900) },
    }),
    status: options.configStatus ?? { kind: "valid" }, warnings: options.configWarnings ?? [], diagnostics: options.configDiagnostics ?? [],
  })
  const configDispatch = mock(async (command: RuntimeConfigMutation): Promise<RuntimeConfigMutationResult> => {
    if (command.type === "config.reset") {
      publishConfig({ ...config(), revision: config().revision + 1 })
      return { kind: "committed", revision: config().revision }
    }
    const values = config().values
    const next = command.target?.kind === "profile"
      ? { ...values, profiles: { ...values.profiles, [command.target.profileId]: { ...profileConfig(), ...values.profiles[command.target.profileId], providers: { github_copilot: { monthly_credit_cap: command.setting.id === "provider" ? command.setting.desired : values.profiles[command.target.profileId]?.providers.github_copilot?.monthly_credit_cap ?? 3_900 } }, ...(command.setting.id === "gitAiAttribution" || command.setting.id === "allowTrainingRoutes" ? { [command.setting.id]: command.setting.desired } : {}) } } }
      : command.setting.id === "module" ? { ...values, moduleSections: { ...values.moduleSections, [command.setting.section]: { ...values.moduleSections[command.setting.section], [command.setting.key]: command.setting.desired } } }
      : { ...values, [command.setting.id]: command.setting.desired }
    publishConfig({ revision: config().revision + 1, values: next, status: { kind: "valid" }, warnings: [], diagnostics: [] })
    return { kind: "committed", revision: config().revision } as const
  })
  const settled = (command: Extract<FrontendMutation, { type: "config.mutate" }>): boolean => {
    const values = config().values
    const setting = command.setting
    if (command.target?.kind === "profile") {
      const profile = values.profiles[command.target.profileId]
      if (setting.id === "gitAiAttribution" || setting.id === "allowTrainingRoutes") return profile?.[setting.id] === setting.desired
      return setting.id === "provider" && profile?.providers[setting.providerId]?.[setting.key] === setting.desired
    }
    if (setting.id === "module") return JSON.stringify(values.moduleSections[setting.section]?.[setting.key]) === JSON.stringify(setting.desired)
    return setting.id !== "gitAiAttribution" && setting.id !== "allowTrainingRoutes" && setting.id !== "provider" && values[setting.id] === setting.desired
  }
  const settings = createSettingsStore({ view: config, settlePublication: async (command, revision) => config().revision >= revision && (command.type === "config.reset" || settled(command)) }, { dispatch: runtimeDispatch({ "config.mutate": configDispatch, "config.reset": configDispatch }) })
  const modal = useSettingsModal({
    directories: DIRECTORIES,
    launcher,
    modal: modals,
    renderModal: () => "mock-settings-modal",
    showToast,
    settings,
    operations: settingsOperations,
    currentThemeName: () => "flywheel",
    openThemeModal,
    openSettingsDestination,
    openSessionsModal,
    openAuthProfiles: mock(() => {}),
    openStatusModal,
    moduleRows: () => options.moduleRows ?? [],
    activateModuleRow,
    updateStatus,
    auth,
    appService: { dispatch: authProfiles, query: runtimeQuery({ authProfileDeletionPreview: query }) },
    authProfileSelection: createAuthProfileSelection({ appService: { dispatch: authProfiles }, foregroundSessionId, showToast }),
    setUpdateAutoInstall,
    capabilities: runtime.capabilities,
    gitAiAttributionStatus,
  })
  return { modal, modals, showToast, settings, runtime, activateModuleRow, openThemeModal, openAuthModal, openModelsModal, openSettingsDestination, openSessionsModal, openStatusModal, setUpdateAutoInstall, publishUpdateStatus, publishAuth, dispatch, query, configDispatch, publishConfig }
}

function flattenRows(rows: readonly SettingsRow[]): readonly SettingsRow[] {
  return rows.flatMap((row) => row.kind === "group" || row.kind === "disclosure" ? [row, ...flattenRows(row.rows())] : [row])
}

export function rowIds(modal: SettingsModalHook): string[] {
  return flattenRows(modal.settingsItems()).flatMap((row) => row.kind === "separator" ? [] : [row.id])
}

export function rowOf(modal: SettingsModalHook, id: string) {
  const row = flattenRows(modal.settingsItems()).find((candidate) => candidate.kind !== "separator" && candidate.id === id)
  if (row === undefined || row.kind === "separator") throw new Error(`Missing settings row: ${id}`)
  return row
}

export function indexOf(modal: SettingsModalHook, id: string): number {
  const index = modal.settingsItems().findIndex((candidate) => candidate.kind !== "separator" && candidate.id === id)
  if (index < 0) throw new Error(`Missing settings row: ${id}`)
  return index
}

export function valueOf(modal: SettingsModalHook, id: string): string {
  const row = rowOf(modal, id)
  if (row.kind === "navigation" || row.kind === "confirmation" || row.kind === "group" || row.kind === "disclosure") throw new Error(`Settings row carries no value: ${id}`)
  return row.value()
}

export function activate(modal: SettingsModalHook, id: string): void {
  const currentView = modal.settingsView()
  const visibleIndex = currentView.kind === "list" ? currentView.rows?.findIndex((row) => row.kind !== "separator" && row.id === id) ?? -1 : -1
  if (visibleIndex >= 0) {
    modal.activateSettingsRow(visibleIndex)
    return
  }
  if (currentView.kind === "list" && currentView.rows !== undefined) {
    modal.closeSettingsModal()
    modal.openSettingsModal()
  }
  const rootIndex = modal.settingsItems().findIndex((candidate) => candidate.kind !== "separator" && candidate.id === id)
  if (rootIndex >= 0) {
    modal.activateSettingsRow(rootIndex)
    return
  }
  const parentIndex = modal.settingsItems().findIndex((candidate) => (candidate.kind === "group" || candidate.kind === "disclosure") && flattenRows(candidate.rows()).some((row) => row.kind !== "separator" && row.id === id))
  if (parentIndex < 0) throw new Error(`Missing settings row: ${id}`)
  modal.activateSettingsRow(parentIndex)
  const view = modal.settingsView()
  const childIndex = view.kind === "list" ? view.rows?.findIndex((row) => row.kind !== "separator" && row.id === id) ?? -1 : -1
  if (childIndex < 0) throw new Error(`Missing grouped settings row: ${id}`)
  modal.activateSettingsRow(childIndex)
}

export async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve()
}
