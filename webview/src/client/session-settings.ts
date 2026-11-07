import type { ModuleId } from "../../../src/protocol/module-ids.js"
import { configProblemText } from "../../../src/protocol/client/config-problem-copy.js"
import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { ModelSelectionSlot } from "../../../src/protocol/model-assignment-protocol-types.js"
import type { ModuleConfigBooleanControl, ModuleConfigNumberListControl, RuntimeModulesView } from "../../../src/protocol/module-protocol-types.js"
import { capabilityPreset, switchableModules, type CapabilityPresetReading } from "../../../src/protocol/client/capabilities.js"
import type { WriteSyntaxThemeId } from "../../../src/protocol/write-syntax-theme.js"
import type { RuntimeServingSeat } from "../../../src/protocol/role-protocol-types.js"

/** One effort stop the chat seat can be set to, as the panel's slider shows it. */
interface PanelEffortOption {
  readonly effort: string | null
  readonly label: string
  readonly current: boolean
  readonly selectable: boolean
}

/** Everything the command panel's settings rows read, in one snapshot.
 *
 *  Effective and persisted are both carried because they answer different
 *  questions: the row shows what is in force, and a mutation must state what
 *  was stored, or a CLI override would make the toggle fight itself. */
/** One setting the runtime rejected or normalized, named so the row can say
 *  so, and what that means for the value in force. */
interface SettingProblem {
  readonly settingId: string
  readonly message: string
}

/** One provider-scoped numeric setting as the sheet edits it: the declaration
 *  the module made, and the value in force for the profile. */
export interface PanelProviderSetting {
  readonly providerId: string
  readonly key: string
  readonly label: string
  readonly description: string
  readonly min: number
  readonly max: number
  readonly off: number
  readonly value: number
}

/** One boolean setting a module owns the row for, with the value in force. */
export type PanelModuleSetting =
  | (ModuleConfigBooleanControl & { readonly value: boolean })
  | (ModuleConfigNumberListControl & { readonly value: readonly number[] })

/** The panel's settings rows that belong to the workspace, not to a session. */
export interface WorkspaceSettings {
  /** The runtime's capability view, as its last module patch or read published it. */
  readonly capabilities: RuntimeModulesView
  readonly moduleIds: readonly ModuleId[]
  readonly capabilitiesOn: number
  readonly capabilitiesTotal: number
  /** Which preset the module set matches, or custom when it matches neither. */
  readonly capabilityPreset: CapabilityPresetReading
  readonly workflowMode: "off" | "ask" | "on"
  readonly persistentProcesses: { readonly effective: boolean; readonly persisted: boolean; readonly forcedByCli: boolean }
  readonly compactionThreshold: number
  readonly autoDeleteSessionDays: number
  readonly idleCompaction: boolean
  readonly shellWriteGuard: boolean
  readonly webSearchProvider: "chatgpt" | "exa"
  readonly showThinking: boolean
  /** This project's Show build setting, as the connected runtime resolves it. */
  readonly showBuild: boolean
  readonly writeSyntaxTheme: WriteSyntaxThemeId
  readonly diffColors: "theme" | "standard"
  /** The profile the profile-scoped settings below belong to. */
  readonly profileId: string
  /** Every provider module's numeric settings in force for the profile, with the value the runtime applies. */
  readonly providerSettings: readonly PanelProviderSetting[]
  /** Every enabled module's boolean configuration rows, with the value in force. */
  readonly moduleSettings: readonly PanelModuleSetting[]
  readonly gitAiAttribution: boolean
  /** Whether the active profile allows model routes that may train on requests. */
  readonly allowTrainingRoutes: boolean
  /** Settings the runtime could not accept as written, for the rows to annotate. */
  readonly problems: readonly SettingProblem[]
  /** The configuration file's state when it is not simply valid. */
  readonly configStatus?: string
  /** The account-global auth profile in use, and how many exist. The count is
   *  what the cycle row needs to know whether cycling can do anything. */
  readonly profile: { readonly displayName: string; readonly count: number }
  /** Configuration problems the runtime reported, the module error among
   *  them. They explain why a setting row may not be doing what
   *  it says, so the panel pins them above everything. */
  readonly configProblems: readonly string[]
}

/** The seat in use, which belongs to one session, or to the defaults with no
 *  session open. A page keeps the seat of every session it keeps resident, so
 *  a return names the seat without a read. */
export interface PanelSeat {
  /** The seat the panel's model rows read and write: the running agent's while
   *  an agent of a workflow runs, otherwise the chat's. */
  readonly seatSlot: ModelSelectionSlot
  /** The seat's current model, absent while no provider serves one. */
  readonly seatModel?: string
  /** The seat's current effort, beside its model. */
  readonly seatEffort?: string
  /** Effort stops the seat offers on its current model. Empty when the model
   *  has no effort choice. */
  readonly seatEfforts: readonly PanelEffortOption[]
  /** The session the seat was read for. Present means the inline rows steer
   *  this session's own override; absent means they edit the defaults. */
  readonly seatSessionId?: string
}

/** Everything the panel's settings rows read: the workspace's settings and
 *  the seat of the session the panel steers. */
export type PanelSettings = WorkspaceSettings & PanelSeat

const DEFAULTS = { kind: "defaults" } as const

/** The seat in use and its effort stops, scoped to `sessionId` when there is
 *  one: the panel's inline rows steer this conversation, and only the Models
 *  browser edits the defaults every new session inherits. Empty rather than
 *  failed when no provider is connected yet. */
export async function readSeat(connection: Pick<RuntimeConnection, "query">, sessionId: string | undefined, slot: ModelSelectionSlot, serving?: RuntimeServingSeat): Promise<PanelSeat> {
  const scoped = { seatSlot: slot, seatEfforts: [], ...(sessionId === undefined ? {} : { seatSessionId: sessionId }) }
  const scope = sessionId === undefined ? DEFAULTS : { kind: "session", sessionId } as const
  const seat = serving === undefined ? (await connection.query({ type: "modelAssignments", scope, slots: [slot] }))[0] : serving.selection
  if (!seat) return scoped
  const efforts = await connection.query({ type: "effortOptions", scope, slot, model: seat.model })
  return {
    ...scoped,
    seatModel: seat.model,
    seatEffort: seat.effort,
    seatEfforts: efforts.map((entry) => ({ effort: entry.effort, label: entry.label, current: entry.current === true, selectable: entry.selectable })),
  }
}

/** One snapshot for the workspace's settings rows: three queries, one shape. */
export async function readWorkspaceSettings(connection: Pick<RuntimeConnection, "query">): Promise<WorkspaceSettings> {
  const [modules, config, auth] = await Promise.all([
    connection.query({ type: "moduleSnapshot" }),
    connection.query({ type: "configSnapshot" }),
    connection.query({ type: "authStatusSnapshot", scope: DEFAULTS }),
  ])
  const view = modules.capabilities
  const switchable = switchableModules(view)
  const values = config.config.values
  const profileId = auth.auth.profile.id
  const profile = values.profiles[profileId]
  return {
    capabilities: view,
    moduleIds: view.modules.filter((module) => module.effective).map((module) => module.id),
    capabilitiesOn: switchable.filter((module) => module.effective).length,
    capabilitiesTotal: switchable.length,
    capabilityPreset: capabilityPreset(view),
    workflowMode: view.workflowsMode,
    persistentProcesses: view.persistentProcesses,
    compactionThreshold: values.proactiveCompactionThreshold,
    autoDeleteSessionDays: values.autoDeleteSessionDays,
    idleCompaction: values.idleCompaction,
    shellWriteGuard: values.shellWriteGuard,
    webSearchProvider: values.webSearchProvider,
    showThinking: values.showThinking,
    showBuild: values.showBuild,
    writeSyntaxTheme: values.writeSyntaxTheme,
    diffColors: values.diffColors,
    profileId,
    providerSettings: view.modules.flatMap((module) => module.effective ? module.providerSettings ?? [] : []).map((setting) => ({
      providerId: setting.providerId, key: setting.key, label: setting.label, description: setting.description, min: setting.min, max: setting.max, off: setting.off,
      value: profile?.providers[setting.providerId]?.[setting.key] ?? setting.defaultValue,
    })),
    moduleSettings: view.modules.flatMap((module) => module.effective ? module.configSettings ?? [] : []).map((control): PanelModuleSetting => {
      if (control.control === "config-boolean") {
        if (!("section" in control)) return { ...control, value: values[control.setting] }
        const value = values.moduleSections[control.section]?.[control.key]
        return { ...control, value: typeof value === "boolean" ? value : control.defaultValue }
      }
      const value = values.moduleSections[control.section]?.[control.key]
      return { ...control, value: value === undefined || typeof value === "boolean" ? control.defaultValue : value }
    }),
    gitAiAttribution: profile?.gitAiAttribution ?? false,
    allowTrainingRoutes: profile?.allowTrainingRoutes ?? false,
    problems: config.config.diagnostics.map((diagnostic) => ({ settingId: diagnostic.settingId, message: configProblemText(diagnostic.reason, config.config.status) })),
    ...(config.config.status.kind === "valid" ? {} : { configStatus: config.config.status.message }),
    profile: { displayName: auth.auth.profile.displayName, count: auth.auth.profile.availableProfiles.length },
    configProblems: view.warnings,
  }
}

/** True while the desktop notifications setting is on and its module is in
 *  force. The terminal and the page read this one setting. */
export function desktopNotificationsOn(settings: WorkspaceSettings | undefined): boolean {
  return settings?.moduleSettings.some((setting) => setting.control === "config-boolean" && !("section" in setting) && setting.setting === "notificationsDesktop" && setting.value) ?? false
}
