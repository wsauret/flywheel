import { type Accessor, createEffect, createMemo, createSignal, type JSX, untrack } from "solid-js"
import { formatAutoDeleteSessionDays, formatTokens, parseAutoDeleteSessionDays } from "../../protocol/client/format.js"
import type { AccountDirectories } from "../../infra/directory-authorities.js"
import { ownedCommandRunner } from "../../infra/owned-command.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import { errorMessage } from "../../infra/error-message.js"
import { MIN_PROACTIVE_COMPACTION_THRESHOLD } from "../../orchestration/config/defaults.js"
import type { UpdateStatusView } from "../../protocol/update-protocol-types.js"
import type { BinaryModule, RuntimeModulesView, WorkflowsMode } from "../../protocol/module-protocol-types.js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import type { RuntimeAuthProfileDeletionPreview } from "../../protocol/auth-profile-selection-protocol-types.js"
import type { GitAiAttributionStatus } from "../../protocol/git-ai-attribution-protocol-types.js"
import type { SettingsOperations, SettingsStore } from "./create-settings-store.js"
import { presentedSettingRow, SIMPLE_SETTING_DEFINITIONS } from "../../orchestration/config/setting-definitions.js"
import { renderSettingEntries, SETTING_SECTIONS, settingCatalogRow, settingGroupHead, type SettingRenderers, type SettingRowId } from "../../protocol/setting-catalog.js"
import type { ModalContext } from "../components/modal-stack.js"
import { createSettingsModalController } from "./settings-modal-controller.js"
import { AUTH_PROFILE_PENDING } from "./auth-profile-selection.js"
import { createProfileEdit, renameProfileEdit } from "./auth-profile-edits.js"
import type { AuthProfileSelection } from "./auth-profile-selection.js"
import { cycleRowActions, simpleSettingRow, type SettingsEditResult, type SettingsRow, type SettingsSelectionConfirmation, type SettingsView } from "./settings-modal-types.js"
import { capabilityRows } from "./settings-capability-rows.js"
import type { ShellServices } from "./shell-state.js"
import type { OpenSettingsDestination } from "../settings-destination.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { ModuleRow, ModuleRowAction } from "../../protocol/protocol-module.js"
import { annotateConfigDiagnostic, annotateConfigDiagnosticGroup, createWriteRefusals } from "./settings-diagnostic-projection.js"
import { groupDigits, parseDigits, sanitizeDigitInput, sanitizeDigitPaste } from "./settings-digit-input.js"
import { createGitAiAttributionRow } from "./settings-git-ai-attribution-row.js"
import { createProviderSettingRow } from "./settings-provider-setting-row.js"
import { createTrainingRoutesRow } from "./settings-training-routes-row.js"
import { autoInstallSaved, persistentProcessesSaved } from "../../protocol/client/runtime-policy-copy.js"

interface SettingsModalDeps {
  /** Account directories the font rows and the config writes resolve from. */
  directories: AccountDirectories
  /** Launch authority the font install's cache refresh runs in. */
  launcher: LauncherScope
  modal: ModalContext
  renderModal: () => JSX.Element
  showToast: ShellServices["showToast"]
  settings: SettingsStore
  operations: SettingsOperations
  currentThemeName: Accessor<string>
  openThemeModal: () => void
  openSettingsDestination: OpenSettingsDestination
  openSessionsModal: () => void
  /** Opens Auth profiles, where profiles are created, renamed, and deleted. */
  openAuthProfiles: () => void
  openStatusModal: () => void
  /** The rows the modules contribute at the setting catalog's client-modules slot. */
  moduleRows: Accessor<readonly ModuleRow[]>
  activateModuleRow: (action: ModuleRowAction) => void
  /** The runtime's published update view. It is the only source of the
   *  auto-install value: the policy lives in the runtime, never in a client
   *  store, so this row shows what the runtime published and nothing else. */
  updateStatus: Accessor<UpdateStatusView | undefined>
  setUpdateAutoInstall: (expected: boolean, value: boolean) => Promise<RuntimePolicyResult>
  /** The runtime's complete effective-profile projection. Profile rows never
   *  retain a client-side selection. */
  auth: Accessor<RuntimeAuthView | undefined>
  appService: Pick<RuntimeClient, "dispatch" | "query"> & Partial<Pick<RuntimeClient, "subscribe">>
  gitAiAttributionStatus: Accessor<GitAiAttributionStatus | undefined>
  authProfileSelection: AuthProfileSelection
  /** The runtime's published capability projection and the three mutations a
   *  client may ask for. The rows render what the runtime published; this modal
   *  holds no selection of its own. */
  capabilities: {
    view: Accessor<RuntimeModulesView | undefined>
    setModule: (moduleId: BinaryModule, expected: boolean, enabled: boolean) => Promise<RuntimePolicyResult>
    setModules: (preset: "minimal" | "full", expected: { readonly moduleIds: readonly BinaryModule[]; readonly requireWorkflowConfirmation: boolean; readonly descriptorIdentity: string }) => Promise<RuntimePolicyResult>
    setWorkflowMode: (expected: WorkflowsMode, mode: WorkflowsMode) => Promise<RuntimePolicyResult>
    setPersistentProcesses: (expected: boolean, enabled: boolean) => Promise<RuntimePolicyResult>
  }
}

export interface SettingsModalHook {
  settingsItems: Accessor<readonly SettingsRow[]>
  settingsView: Accessor<SettingsView>
  settingsModalCursor: Accessor<number>
  openSettingsModal: () => void
  /** True while the settings modal entry is on the stack; the settings tree
   *  reads it to decide whether the root must be opened under a child. */
  settingsModalOpen: () => boolean
  closeSettingsModal: () => void
  finishSettingsEdit: () => void
  activateSettingsRow: (index: number) => void
  toggleSettingsOption: (rowIndex: number) => void
  selectSettingsOption: (rowIndex: number) => void
}

type RuntimePolicyResult = { ok: true } | { ok: false; error: { message: string } }

const UPDATE_POLICY_PENDING = "Automatic updates are unavailable until the runtime publishes its update status"


export function useSettingsModal(deps: SettingsModalDeps): SettingsModalHook {
  const { settings } = deps
  const [fontStatus, setFontStatus] = createSignal(deps.operations.getFontStatus(deps.directories))
  const [updatingRuntimePolicy, setUpdatingRuntimePolicy] = createSignal(false)
  const [profileMutationPending, setProfileMutationPending] = createSignal(false)
  const gitAiAttributionStatus = deps.gitAiAttributionStatus

  function dispatchProfile(command: Parameters<SettingsModalDeps["appService"]["dispatch"]>[0], success: string): void {
    void deps.appService.dispatch(command).then((result) => {
      if (result === undefined) deps.showToast({ message: "Auth profile command returned no result", variant: "error" })
      else if ("ok" in result && result.ok === false) {
        const message = "error" in result && typeof result.error === "string" ? result.error : "Auth profile command failed"
        deps.showToast({ message, variant: "error" })
      }
      else if ("warning" in result && typeof result.warning === "string") deps.showToast({ message: result.warning, variant: "warning", duration: 8000 })
      else deps.showToast({ message: success, variant: "success" })
    }).catch((err) => deps.showToast({ message: errorMessage(err), variant: "error" }))
  }

  function deleteProfile(id: string, displayName: string): void {
    if (profileMutationPending()) return
    const [state, setState] = createSignal<
      | { phase: "loading"; preview?: never; error?: never; successorId?: never }
      | { phase: "preview-error"; error: string; preview?: never; successorId?: never }
      | { phase: "ready"; preview: RuntimeAuthProfileDeletionPreview; successorId?: string; error?: string }
    >({ phase: "loading" })
    const load = async () => {
      setState({ phase: "loading" })
      try {
        const preview = await deps.appService.query({ type: "authProfileDeletionPreview", id })
        setState({ phase: "ready", preview })
      } catch (error) {
        setState({ phase: "preview-error", error: errorMessage(error) })
      }
    }
    // A plain derivation, not a memo. The `d` hotkey runs with no Solid owner.
    // A memo made here has no owner to dispose it, so it runs again on every
    // later change of `profileMutationPending`. The controller view memo tracks
    // these reads, and the key handlers read them once.
    const details = (): SettingsSelectionConfirmation => {
      const current = state()
      const base = { kind: "confirmation", label: "Delete Profile", choice: "cancel" } as const
      if (current.phase === "loading") return { ...base, phase: "loading", message: "Loading deletion preview...", actionLabel: "Delete" }
      if (current.phase === "preview-error") return { ...base, phase: "preview-error", message: `Could not preview deletion of ${displayName}.`, actionLabel: "Retry", error: current.error }
      const preview = current.preview
      const destination = preview?.kind === "automatic" ? `Sessions will move to ${preview.successor.displayName}. ` : preview?.kind === "fresh-default" ? "A fresh Default will be created. Sessions will move to it. " : ""
      return { ...base, phase: "ready", pending: profileMutationPending(), message: `Delete ${displayName}? ${destination}Credentials and profile settings will be removed.`, actionLabel: "Delete", ...(preview.kind === "choose" ? { candidates: preview.candidates } : {}), ...(current.successorId ? { selectedId: current.successorId } : {}), ...(current.error ? { error: current.error } : {}) }
    }
    untrack(() => controller.confirmSelection(details, (successorId) => {
      const current = untrack(state)
      if (current.phase === "ready") setState({ ...current, successorId })
    }, async () => {
      if (untrack(profileMutationPending)) return false
      const current = untrack(state)
      if (current.phase === "loading") return false
      if (current.phase === "preview-error") { await load(); return false }
      const preview = current.preview
      const successorId = preview.kind === "fresh-default" ? null : preview.kind === "automatic" ? preview.successor.id : current.successorId
      if (successorId === undefined) return false
      setProfileMutationPending(true)
      try {
        const result = await deps.appService.dispatch({ type: "auth.profile.delete", scope: { kind: "defaults" }, id, successorId })
        if ("warning" in result && result.warning) deps.showToast({ message: result.warning, variant: "warning", duration: 8000 })
        else deps.showToast({ message: `Profile ${displayName} deleted`, variant: "success" })
        return true
      } catch (error) {
        setState({ ...current, error: errorMessage(error) })
        return false
      } finally {
        setProfileMutationPending(false)
      }
    }))
    void load()
  }

  /** A closed modal cannot hide a failed write. Only the entry that started the write can clear its pending state. */
  async function saveRuntimePolicy(input: {
    save: () => Promise<RuntimePolicyResult>
    label: string
    success: string
  }): Promise<void> {
    if (updatingRuntimePolicy()) return
    const owner = controller.handle()
    setUpdatingRuntimePolicy(true)
    try {
      const result = await input.save()
      if (!result.ok) {
        deps.showToast({ message: `${input.label} update failed: ${result.error.message}`, variant: "error" })
        return
      }
      if (owner?.isOpen()) deps.showToast({ message: input.success, variant: "success" })
    } catch (error) {
      deps.showToast({ message: `${input.label} update failed: ${errorMessage(error)}`, variant: "error" })
    } finally {
      if (owner?.isOpen()) setUpdatingRuntimePolicy(false)
    }
  }

  function showMutationNotice(result: { readonly ok: true; readonly notice?: string }): void {
    if (result.notice !== undefined) deps.showToast({ message: result.notice, variant: "warning" })
  }

  async function resetToDefaults(): Promise<void> {
    if (updatingRuntimePolicy()) return
    const owner = controller.handle()
    setUpdatingRuntimePolicy(true)
    try {
      const profileId = deps.auth()?.profile.id
      if (profileId === undefined) throw new Error("Active profile is unavailable")
      const local = await settings.resetDefaults(profileId)
      if (!local.ok) {
        deps.showToast({ message: `Reset failed: ${local.error.message}`, variant: "error" })
        return
      }
      showMutationNotice(local)
      const capabilityView = deps.capabilities.view()
      const updatePolicy = deps.updateStatus()?.autoInstall
      if (!capabilityView || !updatePolicy) throw new Error("Runtime policy is unavailable")
      const results = await Promise.allSettled([
        deps.capabilities.setModules("full", { moduleIds: capabilityView.moduleIds, requireWorkflowConfirmation: capabilityView.requireWorkflowConfirmation, descriptorIdentity: capabilityView.descriptorIdentity }),
        deps.capabilities.setPersistentProcesses(capabilityView.persistentProcesses.persisted, false),
        deps.setUpdateAutoInstall(updatePolicy.persisted, true),
      ])
      let runtimeFailure: string | undefined
      for (const result of results) {
        if (result.status === "rejected") {
          runtimeFailure ??= errorMessage(result.reason)
        } else if (!result.value.ok) {
          runtimeFailure ??= result.value.error.message
        }
      }
      if (!owner?.isOpen()) return
      if (runtimeFailure !== undefined) {
        deps.showToast({ message: `Reset partially completed: ${runtimeFailure}`, variant: "error" })
        return
      }
      deps.showToast({ message: "Settings reset to defaults", variant: "success" })
      controller.close()
    } finally {
      if (owner?.isOpen()) setUpdatingRuntimePolicy(false)
    }
  }

  /** A configuration error is feedback, never a block: the rows stay active so
   *  the user can repair the selection from here. It is reported once per
   *  distinct error, so clearing it leaves no stale message behind. */
  let reportedCapabilityError: string | undefined
  function reportCapabilityError(): void {
    const error = deps.capabilities.view()?.error
    if (error === reportedCapabilityError) return
    reportedCapabilityError = error
    if (error !== undefined) deps.showToast({ message: `Capability configuration: ${error}`, variant: "error", duration: 10000 })
  }

  function installFont(): void {
    const owner = controller.handle()
    void deps.operations.installBundledFont(deps.directories, { run: ownedCommandRunner(deps.launcher) })
      .then((result) => {
        if (!owner?.isOpen()) return
        setFontStatus(result.status)
        deps.showToast({ message: deps.operations.fontInstallSummary(result), variant: "success", duration: 6000 })
      })
      .catch((err) => {
        if (owner?.isOpen()) deps.showToast({ message: `Font install failed: ${errorMessage(err)}`, variant: "error" })
      })
  }

  const refusals = createWriteRefusals(() => { const publication = settings.publication(); return publication.kind === "ready" ? publication.view.revision : undefined })
  function reportRefusal(rowId: string, label: string, message: string): void {
    refusals.record(rowId, message)
    deps.showToast({ message: `${label} update failed: ${message}`, variant: "error" })
  }

  function submitThresholdEdit(text: string): SettingsEditResult | Promise<SettingsEditResult> {
    const parsed = parseDigits(text)
    if (parsed === undefined || (parsed !== 0 && parsed < MIN_PROACTIVE_COMPACTION_THRESHOLD)) {
      return { ok: false, error: `Enter 0 to turn it off, or at least ${groupDigits(String(MIN_PROACTIVE_COMPACTION_THRESHOLD))} tokens.` }
    }
    if (parsed === settings.values.proactiveCompactionThreshold) return { ok: true }
    return settings.update("proactiveCompactionThreshold", parsed).then((result): SettingsEditResult => {
      if (!result.ok) {
        const row = settingCatalogRow("proactive-compaction-threshold")
        refusals.record(row.id, result.error.message)
        return { ok: false, error: `${row.label} update failed: ${result.error.message}` }
      }
      showMutationNotice(result)
      return { ok: true }
    })
  }



  /** The numeric settings of every provider module in force, from the catalog rows. */
  const providerSettings = createMemo(() => (deps.capabilities.view()?.modules ?? []).flatMap((module) => module.effective ? module.providerSettings ?? [] : []))
  const providerSettingRows = createMemo(() => providerSettings().map((setting) => createProviderSettingRow({
    setting,
    profileId: () => deps.auth()?.profile.id,
    value: () => {
      const profileId = deps.auth()?.profile.id
      return profileId === undefined ? undefined : settings.profileProviderSetting(profileId, setting)
    },
    profilePendingReason: AUTH_PROFILE_PENDING,
    update: settings.updateProfileProviderSetting,
    showNotice: (message) => deps.showToast({ message, variant: "warning" }),
  })))
  const named = <Id extends SettingRowId>(id: Id) => { const row = settingCatalogRow(id); return { id: row.id, label: row.label, description: row.description } }
  const annotate = (row: SettingsRow): SettingsRow => refusals.annotate(annotateConfigDiagnostic(row, settings.diagnostics(), settings.status()))
  const simpleRow = (id: keyof typeof SIMPLE_SETTING_DEFINITIONS): SettingsRow => {
    const row = presentedSettingRow(id)
    return annotate(simpleSettingRow(SIMPLE_SETTING_DEFINITIONS[id], row, {
      read: (definition) => settings.presentation.read(definition.id),
      write: (definition, value) => {
        void settings.presentation.update(definition.id, value).then((result) => {
          if (!result.ok) reportRefusal(row.id, row.label, result.error.message)
          else if (result.notice !== undefined) showMutationNotice(result)
        }).catch((error: unknown) => reportRefusal(row.id, row.label, errorMessage(error)))
        return { ok: true }
      },
      showFeedback: deps.showToast,
    }))
  }

  const profileOptionId = (id: string): string => `profile:${id}`
  const profileIdFromOptionId = (id: string): string | undefined => id.startsWith("profile:") ? id.slice("profile:".length) : undefined
  const profileEditDeps = { auth: deps.auth, appService: deps.appService, showToast: deps.showToast }
  const profileOptions = () => {
    const profile = deps.auth()?.profile
    if (!profile) return []
    return [
      ...profile.availableProfiles.map((available) => ({ kind: "choice" as const, id: profileOptionId(available.id), label: available.displayName })),
      { kind: "action" as const, id: "action:create-profile", label: "Create Profile", edit: createProfileEdit(profileEditDeps) },
    ]
  }
  const projectProfileOptions = () => [
    { kind: "choice" as const, id: "sentinel:unbound", label: "No project binding" },
    ...(deps.auth()?.profile.availableProfiles ?? []).map((available) => ({ kind: "choice" as const, id: profileOptionId(available.id), label: available.displayName })),
  ]

  const activeProfileId = () => deps.auth()?.profile.id
  const activeProfileName = () => {
    const profile = deps.auth()?.profile
    return profile?.source === "environment" ? `${profile.displayName} (environment)` : profile?.displayName
  }
  const gitAiAttributionEnabled = () => { const profileId = activeProfileId(); return profileId === undefined ? undefined : settings.profileBoolean(profileId, "gitAiAttribution") }
  const gitAiAttributionRow = createGitAiAttributionRow({
    row: named("git-ai-attribution"),
    profileId: activeProfileId,
    profileName: activeProfileName,
    enabled: gitAiAttributionEnabled,
    status: gitAiAttributionStatus,
    profilePendingReason: AUTH_PROFILE_PENDING,
    configUnavailableReason: () => { const publication = settings.publication(); return publication.kind === "error" ? publication.message : "Active profile configuration is still loading" },
    update: (profileId, enabled) => settings.updateProfileBoolean(profileId, "gitAiAttribution", enabled),
    save: saveRuntimePolicy,
  })
  const allowTrainingRoutesRow = createTrainingRoutesRow({ row: named("allow-training-routes"), profileId: activeProfileId, profileName: activeProfileName, profilePendingReason: AUTH_PROFILE_PENDING, settings, save: saveRuntimePolicy })

  /** Every Settings entry the terminal shows, by catalog id (ARCH-PROTOCOL-066). */
  const renderers: SettingRenderers<"terminal", SettingsRow> = {
    "auth-profile": () => [{
      kind: "single-select", ...named("auth-profile"),
      value: () => activeProfileName() ?? "N/A",
      options: profileOptions,
      currentId: () => {
        const id = deps.auth()?.profile.id
        return id === undefined ? undefined : profileOptionId(id)
      },
      filterable: false,
      hotkeys: [{
        key: "r", hint: "r rename",
        run: (optionId: string) => {
          const id = profileIdFromOptionId(optionId)
          const profile = deps.auth()?.profile.availableProfiles.find((available) => available.id === id)
          if (profile !== undefined) controller.editChoice(optionId, "Rename Profile", renameProfileEdit(profileEditDeps, profile.id, profile.displayName))
        },
      }, {
        key: "d", hint: "d delete",
        available: (optionId: string) => {
          const id = profileIdFromOptionId(optionId)
          return deps.auth()?.profile.source !== "environment" && id !== undefined
        },
        run: (optionId: string) => {
          const id = profileIdFromOptionId(optionId)
          const profile = deps.auth()?.profile.availableProfiles.find((available) => available.id === id)
          if (profile !== undefined) deleteProfile(profile.id, profile.displayName)
        },
      }],
      unavailableReason: () => deps.auth() ? undefined : AUTH_PROFILE_PENDING,
      onSelect: (optionId: string) => {
        const profile = deps.auth()?.profile
        const id = profileIdFromOptionId(optionId)
        if (!profile || id === undefined) return
        const selected = profile.availableProfiles.find((available) => available.id === id)
        if (selected !== undefined) void deps.authProfileSelection.select(selected.id, selected.displayName)
      },
    }],
    "project-profile": () => [{
      kind: "single-select", ...named("project-profile"),
      value: () => {
        const profile = deps.auth()?.profile
        const binding = profile?.projectBinding
        return binding === undefined ? "None" : profile?.availableProfiles.find((available) => available.id === binding)?.displayName ?? binding
      },
      options: projectProfileOptions,
      currentId: () => {
        const binding = deps.auth()?.profile.projectBinding
        return binding === undefined ? "sentinel:unbound" : profileOptionId(binding)
      },
      unavailableReason: () => deps.auth() ? undefined : AUTH_PROFILE_PENDING,
      onSelect: (optionId: string) => {
        const id = profileIdFromOptionId(optionId)
        const displayName = deps.auth()?.profile.availableProfiles.find((available) => available.id === id)?.displayName
        return dispatchProfile(
          id === undefined ? { type: "auth.profile.unbind_current_project", scope: { kind: "defaults" } } : { type: "auth.profile.bind_current_project", scope: { kind: "defaults" }, id },
          id === undefined ? "Project profile binding removed" : `Project bound to ${displayName ?? id}`,
        )
      },
    }],
    "show-build": () => [{
      kind: "cycle", ...named("show-build"),
      value: () => {
        const enabled = settings.showBuild()
        return enabled === undefined ? "N/A" : enabled ? "On" : "Off"
      },
      unavailableReason: () => { const publication = settings.publication(); return settings.showBuild() !== undefined ? undefined : publication.kind === "error" ? publication.message : "Configuration is still loading" },
      // oxlint-disable-next-line solid/reactivity -- boundary: callback becomes a keyboard event handler.
      ...cycleRowActions(() => {
        const current = settings.showBuild()
        if (current === undefined) return
        const next = !current
        void saveRuntimePolicy({
          save: async () => {
            const result = await settings.updateShowBuild(next)
            return result.ok ? { ok: true } : { ok: false, error: { message: result.error.message } }
          },
          label: "Show build",
          success: `Show build ${next ? "enabled" : "disabled"} for this project`,
        })
      }),
    }],
    "git-ai-attribution": () => [gitAiAttributionRow],
    models: () => [{ kind: "navigation", ...named("models"), onActivate: () => { void deps.openSettingsDestination({ kind: "models" }) } }],
    authentication: () => [{ kind: "navigation", ...named("authentication"), onActivate: () => { void deps.openSettingsDestination({ kind: "auth" }) } }],
    "allow-training-routes": () => [allowTrainingRoutesRow],
    "provider-settings": () => providerSettingRows(),
    status: () => [{ kind: "navigation", ...named("status"), onActivate: deps.openStatusModal }],
    "client-modules": () => deps.moduleRows().map((row) => ({
      kind: "navigation",
      id: `module:${row.id}`,
      label: row.label,
      ...(row.hint === undefined ? {} : { description: row.hint }),
      onActivate: () => { if (row.action !== undefined) deps.activateModuleRow(row.action) },
    })),
    appearance: (entry, children) => [annotateConfigDiagnosticGroup({ kind: "disclosure", id: entry.id, label: entry.label, description: entry.description, rows: children }, settings.diagnostics())],
    theme: () => [annotate({ kind: "picker", ...named("theme"), value: deps.currentThemeName, onActivate: deps.openThemeModal })],
    "show-thinking": () => [simpleRow("showThinking")],
    "write-syntax-theme": () => [simpleRow("writeSyntaxTheme")],
    "diff-colors": () => [simpleRow("diffColors")],
    "compatible-rendering": () => [simpleRow("compatibleRendering")],
    font: () => [{
      kind: "action", ...named("font"),
      value: () => fontSettingsLabel(fontStatus()),
      unavailableReason: () => {
        const status = fontStatus()
        return !status.installed && !status.installable ? "Bundled Monaspace Argon font files were not found" : undefined
      },
      onActivate: installFont,
    }],
    maintenance: (entry, children) => [annotateConfigDiagnosticGroup({ kind: "disclosure", id: entry.id, label: entry.label, description: entry.description, rows: children }, settings.diagnostics())],
    "auto-install": () => [annotate({
      kind: "cycle", ...named("auto-install"),
      value: () => {
        const policy = deps.updateStatus()?.autoInstall
        if (!policy) return "NO"
        return policy.persisted && policy.forcedOff ? "Off for this run via environment" : yesNo(policy.persisted)
      },
      unavailableReason: () => deps.updateStatus() ? undefined : UPDATE_POLICY_PENDING,
      // oxlint-disable-next-line solid/reactivity -- boundary: callback becomes a keyboard event handler.
      ...cycleRowActions(() => {
        const policy = deps.updateStatus()?.autoInstall
        if (!policy) return
        // The durable value is what this row writes. Toggling the effective
        // one could never flip while an override held it, which is how a
        // successful write used to report success and change nothing.
        const enabled = !policy.persisted
        void saveRuntimePolicy({
          save: () => deps.setUpdateAutoInstall(policy.persisted, enabled),
          label: settingCatalogRow("auto-install").label,
          success: autoInstallSaved(policy, enabled),
        })
      }),
    })],
    "proactive-compaction-threshold": () => [annotate({
      kind: "edit", ...named("proactive-compaction-threshold"),
      value: () => settings.values.proactiveCompactionThreshold === 0 ? "None" : formatTokens(settings.values.proactiveCompactionThreshold),
      edit: {
        hint: "Compact after this many input tokens. Enter 0 to turn it off.",
        current: () => groupDigits(String(settings.values.proactiveCompactionThreshold)),
        initialDraft: () => "",
        formatDraft: groupDigits,
        sanitizeInput: sanitizeDigitInput,
        sanitizePaste: sanitizeDigitPaste,
        submit: submitThresholdEdit,
      },
    })],
    "idle-compaction": () => [simpleRow("idleCompaction")],
    "auto-delete-session-days": () => {
      const row = named("auto-delete-session-days")
      return [annotate({
        kind: "edit", ...row,
        value: () => formatAutoDeleteSessionDays(settings.values.autoDeleteSessionDays),
        edit: {
          hint: "Deletion is permanent. Enter whole days, or Off.",
          current: () => String(settings.values.autoDeleteSessionDays),
          initialDraft: () => String(settings.values.autoDeleteSessionDays),
          submit: (text) => {
            const parsed = parseAutoDeleteSessionDays(text)
            if ("problem" in parsed) return { ok: false, error: parsed.problem }
            if (parsed.value === settings.values.autoDeleteSessionDays) return { ok: true }
            return settings.update("autoDeleteSessionDays", parsed.value).then((result): SettingsEditResult => {
              if (!result.ok) {
                refusals.record(row.id, result.error.message)
                return { ok: false, error: `${row.label} update failed: ${result.error.message}` }
              }
              showMutationNotice(result)
              return { ok: true }
            })
          },
        },
      })]
    },
    "capability-preset": () => { const preset = capabilities().preset; return preset === undefined ? [] : [preset] },
    "workflow-mode": () => { const mode = capabilities().workflowMode; return mode === undefined ? [] : [mode] },
    // Its rows are the ungrouped module switches, which wait for the runtime's capabilities like the preset above.
    "agent-capabilities": (entry, children) => children().length === 0 ? [] : [annotateConfigDiagnosticGroup({ kind: "disclosure", id: `capability-group:${entry.label}`, label: entry.label, description: entry.description, rows: children }, settings.diagnostics())],
    "agent-capability-modules": () => capabilities().ungrouped,
    "allow-persistent-processes": () => [annotate({
      kind: "cycle", ...named("allow-persistent-processes"),
      value: () => {
        const policy = deps.capabilities.view()?.persistentProcesses
        if (!policy) return "NO"
        return !policy.persisted && policy.effective && policy.forcedByCli ? "On for this run via CLI" : yesNo(policy.persisted)
      },
      // oxlint-disable-next-line solid/reactivity -- boundary: callback becomes a keyboard event handler.
      ...cycleRowActions(() => {
        const policy = deps.capabilities.view()?.persistentProcesses
        if (!policy) return
        const enabled = !policy.persisted
        void saveRuntimePolicy({
          save: () => deps.capabilities.setPersistentProcesses(policy.persisted, enabled),
          label: settingCatalogRow("allow-persistent-processes").label,
          success: persistentProcessesSaved(policy, enabled),
        })
      }),
    })],
    "shell-write-guard": () => [simpleRow("shellWriteGuard")],
    "web-search-provider": () => [simpleRow("webSearchProvider")],
    "capability-groups": () => capabilities().groups.map((group) => annotateConfigDiagnosticGroup(group, settings.diagnostics())),
    sessions: () => [{ kind: "navigation", ...named("sessions"), onActivate: deps.openSessionsModal }],
    "auth-profiles": () => [{ kind: "navigation", ...named("auth-profiles"), onActivate: deps.openAuthProfiles }],
    "reset-defaults": () => [{ kind: "confirmation", ...named("reset-defaults"), message: "Reset shared settings, capabilities, and updates? Project preferences, auth, and model choices stay unchanged.", actionLabel: "Reset", onConfirm: () => { void resetToDefaults() } }],
  }

  const capabilities = createMemo(() => capabilityRows({
    capabilities: deps.capabilities,
    auth: deps.auth,
    config: {
      numberList: (setting) => settings.configNumberList(setting),
      updateNumberList: (setting, value) => settings.updateConfigNumberList(setting, value),
      boolean: (setting) => settings.configBoolean(setting),
      updateBoolean: (setting, value) => settings.updateConfigBoolean(setting, value),
    },
    save: saveRuntimePolicy,
    confirm: (label, message, actionLabel, onConfirm) => controller.confirmAction(label, message, actionLabel, onConfirm),
    groupHead: (group) => renderSettingEntries("terminal", settingGroupHead(group), renderers),
  }))
  const items: Accessor<readonly SettingsRow[]> = () => SETTING_SECTIONS.flatMap((section): readonly SettingsRow[] => [
    { kind: "separator", label: section.title },
    ...renderSettingEntries("terminal", section.entries, renderers),
  ])


  const controller = createSettingsModalController({
    rows: items,
    modal: deps.modal,
    renderModal: deps.renderModal,
    blocked: () => updatingRuntimePolicy() || profileMutationPending(),
    onError: (message) => deps.showToast({ message, variant: "error" }),
  })

  // Live publication while the modal is open reports a newly stated error, and
  // its clearing leaves nothing behind.
  createEffect(() => {
    deps.capabilities.view()
    if (controller.handle()?.isOpen()) reportCapabilityError()
  })

  function openSettingsModal(): void {
    setFontStatus(deps.operations.getFontStatus(deps.directories))
    setUpdatingRuntimePolicy(false)
    reportCapabilityError()
    controller.open()
  }

  return {
    settingsItems: items,
    settingsView: controller.view,
    settingsModalCursor: controller.cursor,
    openSettingsModal,
    settingsModalOpen: () => controller.handle()?.isOpen() ?? false,
    closeSettingsModal: controller.close,
    finishSettingsEdit: controller.finishEdit,
    activateSettingsRow: controller.activateRow,
    toggleSettingsOption: controller.toggleOption,
    selectSettingsOption: controller.selectOption,
  }
}


function yesNo(value: boolean): string {
  return value ? "YES" : "NO"
}

function fontSettingsLabel(status: ReturnType<SettingsOperations["getFontStatus"]>): string {
  return status.installed ? "Installed" : "Not installed"
}
