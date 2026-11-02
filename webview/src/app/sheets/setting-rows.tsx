import { Key } from "@solid-primitives/keyed"
import { createSignal, Show, type JSX } from "solid-js"

import type { AuthProviderStatus } from "../../../../src/protocol/auth-status-protocol-types.js"
import { formatModuleNumberList, parseModuleNumberList } from "../../../../src/protocol/client/module-number-list.js"
import { formatAutoDeleteSessionDays, parseAutoDeleteSessionDays } from "../../../../src/protocol/client/format.js"
import { gitAiAttributionReading } from "../../../../src/protocol/client/git-ai-attribution-copy.js"
import { moduleUnavailableReason } from "../../../../src/protocol/client/capabilities.js"
import { autoInstallOverride, persistentProcessesOverride } from "../../../../src/protocol/client/runtime-policy-copy.js"
import { describeUpdateStatus } from "../../../../src/protocol/client/update-status-copy.js"
import { MODULE_SETTING_GROUPS, type ModuleConfigSettingControl, type ModuleProtocolRow, type RuntimeModulesView } from "../../../../src/protocol/module-protocol-types.js"
import { renderSettingEntries, SETTING_SECTIONS, settingCatalogRow, settingGroupHead, shownOn, type InPlaceSettingRowId, type SettingCatalogEntry, type SettingEntryIdOn, type SettingRenderers, type SettingRowId } from "../../../../src/protocol/setting-catalog.js"
import { WRITE_SYNTAX_THEME_OPTIONS } from "../../../../src/protocol/write-syntax-theme.js"
import { moduleRows } from "../../../../src/protocol/modules.js"
import { pageDomainReader } from "../../client/module-domain-views.js"
import { WEB_MODULES } from "../../modules.js"
import { moduleMenuRows } from "../../web-module.js"
import type { PanelModuleSetting, PanelProviderSetting, PanelSettings } from "../../client/session-settings.js"
import { desktopPermissionDetail, desktopSwitchOn, isDesktopNotificationsSetting } from "../../client/desktop-notifier.js"
import { moduleSettingId, parseProviderSetting, providerSettingId, settingKeys, settingRowKey, settingTarget, validCompactionThreshold, type InlineSettingAction, type SettingId, type SettingOutcome } from "../../client/settings-actions.js"
import type { ClientContextValue } from "../client-context.js"
import { applyCapabilityPreset, presetKeys, presetOptions, WORKFLOWS_MODE_OPTIONS } from "./capability-preset.js"
import { SettingRow, SheetField, SheetSegment, SheetSwitch } from "./controls.js"
import { SheetRow } from "./sheet.js"
import { ModuleRowView } from "./status-sheet.js"

/** The browser's rendering of the setting catalog (ARCH-PROTOCOL-066).
 *
 *  Every row takes its name and description from the catalog and edits its
 *  setting where it is read: a switch for a boolean, a segment for a short
 *  enum, a field for a number or a list. Every write states the value in force
 *  when it runs as its expectation, so two clients cannot silently overwrite
 *  each other, and a refusal is reported under the row. A setting the runtime
 *  rejected or normalized says so under its row too. */

type SettingWrite = InlineSettingAction | { readonly kind: "set-capability-preset"; readonly preset: "minimal" | "full" }

/** What every row of one surface shares: its writes and the refusal each write
 *  left under its row, until the next successful write. */
export interface SettingRowState {
  readonly apply: (action: SettingWrite) => Promise<void | boolean>
  /** The row's refusal, else the problem the runtime reported under the
   *  configuration's own name for the setting, `configId`. */
  readonly problem: (row: SettingId, configId?: string) => string | undefined
  /** Whether any write of the setting `row` is in flight. */
  readonly busy: (row: SettingId) => boolean
  /** Whether a write of exactly this value is in flight, for one segment option. */
  readonly writing: (action: InlineSettingAction) => boolean
}

export function createSettingRowState(client: ClientContextValue): SettingRowState {
  const settings = () => client.state().settings
  const [refusals, setRefusals] = createSignal<ReadonlyMap<SettingId, string>>(new Map())
  const record = (rowId: SettingId, outcome: SettingOutcome | undefined) => {
    setRefusals((current) => {
      const next = new Map(current)
      if (outcome?.kind === "notice" && outcome.severity === "warning") next.set(rowId, outcome.message)
      else next.delete(rowId)
      return next
    })
  }
  return {
    // A row's id is the setting it writes, so the row reads its working state
    // from the actions layer under the keys the write runs under: the same
    // value joins the write in flight, and another value runs after it.
    apply: (action) => {
      if (action.kind === "set-capability-preset") {
        const keys = presetKeys(action.preset)
        return client.actions.runInOrder(keys.row, keys.write, async () => record("preset", await applyCapabilityPreset(client, action.preset)))
      }
      return client.actions.applySetting(action).then((outcome) => {
        if (action.kind !== "set-provider-setting" || action.profileId === settings()?.profileId) record(settingTarget(action), outcome)
      })
    },
    problem: (row, configId) => {
      const refused = refusals().get(row)
      if (refused !== undefined) return refused
      return configId === undefined ? undefined : settings()?.problems.find((entry) => entry.settingId === configId)?.message
    },
    busy: (row) => client.actions.working(settingRowKey(row)),
    writing: (action) => client.actions.working(settingKeys(action).write),
  }
}

const compactionText = (tokens: number) => (tokens === 0 ? "off" : tokens.toLocaleString())
const parseTokens = (raw: string) => Number(raw.replaceAll(",", "").trim())

/** How a provider module's switch reads: on, and what the credential behind it is doing. */
function providerState(provider: AuthProviderStatus | undefined): string {
  if (provider === undefined || provider.source === "unconfigured") return "on, not configured"
  if (provider.source === "invalid") return "on, credential invalid"
  if (provider.source === "misconfigured") return "on, misconfigured"
  if (provider.expired) return "on, signed out"
  return provider.source === "stored_key" ? "on, key stored" : "on, signed in"
}

/** What one row that changes a value in place shows, whichever control edits it. */
interface InPlaceShown {
  readonly label: string
  readonly detail: string | undefined
  readonly problem: string | undefined
  /** Whether a write of the row's setting is in flight. */
  readonly working: boolean
}

interface SwitchShown extends InPlaceShown {
  readonly on: boolean
  readonly disabled: boolean
  readonly set: (on: boolean) => void
}

/** One value of a choice, with the write that picks it. */
interface ChoiceOption {
  readonly value: string
  readonly label: string
  /** Whether a write of exactly this value is in flight. */
  readonly writing: boolean
  readonly select: () => void
}

interface ChoiceShown extends InPlaceShown {
  readonly value: string
  readonly options: readonly ChoiceOption[]
}

/** A value that steps through a list the row does not spell out, such as the auth profiles. */
interface CycleShown extends InPlaceShown {
  readonly text: string
  readonly step: (direction: 1 | -1) => void
}

/** A number or a list, typed into the row's field. */
interface FieldShown extends InPlaceShown {
  readonly text: string
  readonly numeric: boolean
  readonly validate: (draft: string) => string | undefined
  readonly commit: (draft: string) => void | Promise<void | boolean>
}

/** One in-place row, by the control that edits it, read reactively. A row's
 *  control never changes; what it shows does. Settings draws the row from
 *  this, and a command surface steers the same values and writes with its
 *  own keys (PI-INTERACTION-081). */
export type InPlaceRowModel =
  | { readonly kind: "switch"; readonly read: () => SwitchShown }
  | { readonly kind: "choice"; readonly read: () => ChoiceShown }
  | { readonly kind: "cycle"; readonly read: () => CycleShown }
  | { readonly kind: "field"; readonly read: () => FieldShown }

function inPlaceControl(row: InPlaceRowModel): JSX.Element {
  switch (row.kind) {
    case "switch": {
      const { read } = row
      return <SheetSwitch label={read().label} on={read().on} disabled={read().disabled} working={read().working} onChange={(on) => read().set(on)} />
    }
    case "choice": {
      const { read } = row
      const option = (value: string) => read().options.find((candidate) => candidate.value === value)
      return <SheetSegment label={read().label} value={read().value} options={read().options} working={read().working} writing={(value) => option(value)?.writing ?? false} onChange={(value) => option(value)?.select()} />
    }
    case "cycle": {
      const { read } = row
      return <button class="sheet-field-value" aria-busy={read().working || undefined} onClick={() => read().step(1)}>{read().text}</button>
    }
    case "field": {
      const { read } = row
      return <SheetField label={read().label} value={read().text} inputMode={read().numeric ? "numeric" : "text"} working={read().working} validate={(draft) => read().validate(draft)} onCommit={(draft) => read().commit(draft)} />
    }
  }
}

/** One in-place row as Settings draws it: its name, detail, and problem, with
 *  its control on the right. `row` is read once, so a caller passes a model it
 *  built, never a call that builds one per read. */
function InPlaceSettingView(props: { readonly row: InPlaceRowModel }) {
  const shown = (): InPlaceShown => props.row.read()
  return <SettingRow label={shown().label} detail={shown().detail} problem={shown().problem}>{inPlaceControl(props.row)}</SettingRow>
}

/** One module's switch. An invalid selection disables every switch, and the
 *  surface states that error once at its top: only a complete replacement,
 *  such as a preset, repairs it. */
function moduleSwitchModel(client: ClientContextValue, view: () => RuntimeModulesView, module: () => ModuleProtocolRow): InPlaceRowModel {
  return { kind: "switch", read: () => {
    const { id, setting } = module()
    const reason = moduleUnavailableReason(view(), module())
    const on = view().moduleIds.includes(id)
    const provider = setting?.group === undefined || setting.providerId === undefined || !on
      ? undefined
      : providerState(client.state().authStatus?.auth.providers.find((candidate) => candidate.providerId === setting.providerId))
    return {
      label: setting?.label ?? id,
      detail: [setting?.description, provider].filter((part): part is string => part !== undefined).join(" · "),
      problem: reason,
      working: client.actions.working(settingRowKey(`module:${id}`)),
      on,
      disabled: view().error !== undefined || (reason !== undefined && !on),
      set: (next) => { void client.actions.applySetting({ kind: "set-module", moduleId: id, on: next }) },
    }
  } }
}

export function ModuleSwitchRow(props: { readonly client: ClientContextValue; readonly view: RuntimeModulesView; readonly module: ModuleProtocolRow }) {
  const row = moduleSwitchModel(props.client, () => props.view, () => props.module)
  return <InPlaceSettingView row={row} />
}

/** The configuration's own name for a module setting, as the runtime reports problems under it. */
const moduleConfigId = (setting: PanelModuleSetting | ModuleConfigSettingControl) => ("section" in setting ? `${setting.section}.${setting.key}` : setting.setting)

/** The modules with a switch in `group`, or in no group, in the runtime's order. */
const switchModules = (view: RuntimeModulesView, group: string | undefined) => view.modules.filter((module) => module.setting?.control === "binary" && module.setting.group === group)

/** Every catalog entry the browser shows, rendered for the settings in `current`. */
export function browserSettingRenderers(client: ClientContextValue, state: SettingRowState, current: () => PanelSettings): SettingRenderers<"browser", JSX.Element> {
  return browserSettingParts(client, state, current).renderers
}

/** The renderer table, and the rows of the slot families it renders, which a
 *  command surface also lists one by one. */
function browserSettingParts(client: ClientContextValue, state: SettingRowState, current: () => PanelSettings) {
  const named = (id: SettingRowId) => settingCatalogRow(id)
  const subsection = (entry: { readonly label: string }, children: () => readonly JSX.Element[]) => [<div class="sheet-subsection">{entry.label}</div>, ...children()]
  const profile = () => client.state().authStatus?.auth.profile

  /** One module's configuration row, under the module's switch. */
  const moduleSettingModel = (setting: () => PanelModuleSetting): InPlaceRowModel => {
    const row = moduleSettingId(setting())
    const shown = (): InPlaceShown => {
      // The desktop notifications switch shows whether this page notifies, which the browser decides too.
      const desktop = isDesktopNotificationsSetting(setting())
      return {
        label: setting().label,
        detail: (desktop ? desktopPermissionDetail(client.state().desktopPermission) : undefined) ?? setting().description,
        problem: state.problem(row, moduleConfigId(setting())),
        working: state.busy(row),
      }
    }
    if (setting().control === "config-boolean") {
      return { kind: "switch", read: () => {
        const entry = setting()
        const value = entry.control === "config-boolean" && entry.value
        return {
          ...shown(),
          on: isDesktopNotificationsSetting(entry) ? desktopSwitchOn(value, client.state().desktopPermission) : value,
          disabled: false,
          set: (on) => { const latest = setting(); if (latest.control === "config-boolean") void state.apply({ kind: "set-module-setting", setting: latest, on }) },
        }
      } }
    }
    // Each read narrows the row's item signal afresh: a field that unmounts
    // mid-edit commits after the row has left the list.
    const list = () => { const entry = setting(); return entry.control === "config-number-list" ? entry : undefined }
    const parse = (draft: string) => { const entry = list(); return entry && parseModuleNumberList(entry.suffix === undefined ? draft : draft.replaceAll(entry.suffix, ""), entry) }
    const text = () => { const entry = list(); return entry === undefined ? "" : formatModuleNumberList(entry.value, entry) }
    return { kind: "field", read: () => ({
      ...shown(),
      text: text(),
      numeric: false,
      validate: (draft) => { const entry = list(); return entry !== undefined && parse(draft) === undefined ? `Use increasing whole numbers from ${entry.min} to ${entry.max}.` : undefined },
      commit: (draft) => { const entry = list(); const value = parse(draft); if (entry !== undefined && value !== undefined) return state.apply({ kind: "set-module-number-list", setting: entry, value }) },
    }) }
  }
  /** One provider module's numeric setting, for the profile it was read for. */
  const providerSettingModel = (setting: () => PanelProviderSetting): InPlaceRowModel => {
    const row = providerSettingId(setting())
    const { profileId, profile: { displayName } } = current()
    const asTyped = (draft: string) => (draft === "off" ? String(setting().off) : draft)
    return { kind: "field", read: () => ({
      label: setting().label,
      detail: `${setting().description} For the ${displayName} profile.`,
      problem: state.problem(row),
      working: state.busy(row),
      text: setting().value === setting().off ? "off" : setting().value.toLocaleString(),
      numeric: true,
      validate: (draft) => { const parsed = parseProviderSetting(asTyped(draft), setting()); return "problem" in parsed ? parsed.problem : undefined },
      commit: (draft) => { const parsed = parseProviderSetting(asTyped(draft), setting()); if ("value" in parsed) return state.apply({ kind: "set-provider-setting", profileId, setting: setting(), value: parsed.value }) },
    }) }
  }
  /** The configuration rows a module shows while it is on. */
  const moduleConfigSettings = (module: ModuleProtocolRow) => {
    const configIds = new Set((module.effective ? module.configSettings ?? [] : []).filter((control) => shownOn(control, "browser")).map(moduleConfigId))
    return current().moduleSettings.filter((setting) => configIds.has(moduleConfigId(setting)))
  }
  /** A module's switch, then its configuration rows while it is on. */
  const moduleBlock = (module: () => ModuleProtocolRow) => (
    <>
      <ModuleSwitchRow client={client} view={current().capabilities} module={module()} />
      <Key each={moduleConfigSettings(module())} by={moduleSettingId}>{(setting) => { const row = moduleSettingModel(setting); return <InPlaceSettingView row={row} /> }}</Key>
    </>
  )
  const groups = () => MODULE_SETTING_GROUPS.filter((group) => switchModules(current().capabilities, group).length > 0)

  /** The name, detail, problem, and working state of catalog row `id`, whose writes run under `row`. */
  const shownFor = (id: SettingRowId, row: SettingId, configId?: string, detail?: string): InPlaceShown => ({
    label: named(id).label,
    detail: detail ?? named(id).description,
    problem: state.problem(row, configId),
    working: state.busy(row),
  })
  const choice = (value: string, label: string, action: InlineSettingAction): ChoiceOption => ({ value, label, writing: state.writing(action), select: () => { void state.apply(action) } })

  /** Every catalog row the browser changes in place. */
  const models = {
    "auth-profile": { kind: "cycle", read: () => ({ ...shownFor("auth-profile", "profile"), text: current().profile.displayName, step: (direction) => { void state.apply({ kind: "cycle-profile", direction }) } }) },
    "project-profile": { kind: "choice", read: () => {
      const shown = profile()
      const option = (id: string, label: string) => choice(id, label, { kind: "set-project-profile", profileId: id === "" ? undefined : id })
      return { ...shownFor("project-profile", "project-profile"), value: shown?.projectBinding ?? "", options: [option("", "None"), ...(shown?.availableProfiles ?? []).map((available) => option(available.id, available.displayName))] }
    } },
    "show-build": { kind: "switch", read: () => ({ ...shownFor("show-build", "show-build", "showBuild"), on: current().showBuild, disabled: false, set: (on) => { void state.apply({ kind: "set-show-build", on }) } }) },
    "git-ai-attribution": { kind: "switch", read: () => ({
      ...shownFor("git-ai-attribution", "git-attribution", "gitAiAttribution"),
      problem: state.problem("git-attribution", "gitAiAttribution") ?? (current().gitAiAttribution ? gitAiAttributionReading(client.state().gitAiAttribution) : undefined),
      on: current().gitAiAttribution,
      disabled: false,
      set: (on) => { void state.apply({ kind: "set-git-ai-attribution", on }) },
    }) },
    "allow-training-routes": { kind: "switch", read: () => ({ ...shownFor("allow-training-routes", "training-routes", "allowTrainingRoutes"), on: current().allowTrainingRoutes, disabled: false, set: (on) => { void state.apply({ kind: "set-allow-training-routes", on }) } }) },
    "show-thinking": { kind: "switch", read: () => ({ ...shownFor("show-thinking", "thinking", "showThinking"), on: current().showThinking, disabled: false, set: (on) => { void state.apply({ kind: "set-show-thinking", on }) } }) },
    "write-syntax-theme": { kind: "choice", read: () => ({ ...shownFor("write-syntax-theme", "write-syntax-theme", "writeSyntaxTheme"), value: current().writeSyntaxTheme, options: WRITE_SYNTAX_THEME_OPTIONS.map(({ value, label }) => choice(value, label, { kind: "set-write-syntax-theme", theme: value })) }) },
    "diff-colors": { kind: "choice", read: () => ({ ...shownFor("diff-colors", "diff-colors", "diffColors"), value: current().diffColors, options: [choice("theme", "Theme", { kind: "set-diff-colors", mode: "theme" }), choice("standard", "Standard", { kind: "set-diff-colors", mode: "standard" })] }) },
    "auto-install": { kind: "switch", read: () => {
      const autoInstall = client.state().update?.autoInstall
      return { ...shownFor("auto-install", "updates", "autoInstall", autoInstall === undefined ? undefined : autoInstallOverride(autoInstall)), on: autoInstall?.persisted ?? false, disabled: false, set: () => { void state.apply({ kind: "toggle-auto-install" }) } }
    } },
    "proactive-compaction-threshold": { kind: "field", read: () => ({
      ...shownFor("proactive-compaction-threshold", "compaction", "proactiveCompactionThreshold"),
      text: compactionText(current().compactionThreshold),
      numeric: true,
      validate: (draft) => (draft.trim() === "off" || validCompactionThreshold(parseTokens(draft)) ? undefined : "0, off, or a whole number of at least 50,000."),
      commit: (draft) => state.apply({ kind: "set-compaction-threshold", tokens: draft.trim() === "off" ? 0 : parseTokens(draft) }),
    }) },
    "idle-compaction": { kind: "switch", read: () => ({ ...shownFor("idle-compaction", "idle-compaction", "idleCompaction"), on: current().idleCompaction, disabled: false, set: (on) => { void state.apply({ kind: "set-idle-compaction", on }) } }) },
    "auto-delete-session-days": { kind: "field", read: () => ({
      ...shownFor("auto-delete-session-days", "auto-delete-session-days", "autoDeleteSessionDays"),
      text: formatAutoDeleteSessionDays(current().autoDeleteSessionDays),
      numeric: true,
      validate: (draft) => { const parsed = parseAutoDeleteSessionDays(draft); return "problem" in parsed ? parsed.problem : undefined },
      commit: (draft) => { const parsed = parseAutoDeleteSessionDays(draft); if ("value" in parsed) return state.apply({ kind: "set-auto-delete-session-days", days: parsed.value }) },
    }) },
    "capability-preset": { kind: "choice", read: () => ({
      ...shownFor("capability-preset", "preset"),
      value: current().capabilityPreset,
      // Custom is a reading, never a write: it names a selection that matches neither preset.
      options: presetOptions(current().capabilityPreset).map(({ value, label }) => ({ value, label, writing: client.actions.working(presetKeys(value).write), select: () => { if (value !== "custom") void state.apply({ kind: "set-capability-preset", preset: value }) } })),
    }) },
    "workflow-mode": { kind: "choice", read: () => ({ ...shownFor("workflow-mode", "workflow-mode"), value: current().workflowMode, options: WORKFLOWS_MODE_OPTIONS.map(({ value, label }) => choice(value, label, { kind: "set-workflow-mode", mode: value })) }) },
    "allow-persistent-processes": { kind: "switch", read: () => ({
      ...shownFor("allow-persistent-processes", "persistent", "allowPersistentProcesses", persistentProcessesOverride(current().persistentProcesses)),
      on: current().persistentProcesses.persisted,
      disabled: false,
      set: () => { void state.apply({ kind: "toggle-persistent-processes" }) },
    }) },
    "web-search-provider": { kind: "choice", read: () => ({ ...shownFor("web-search-provider", "web-search", "webSearchProvider"), value: current().webSearchProvider, options: [choice("chatgpt", "ChatGPT", { kind: "set-web-search", provider: "chatgpt" }), choice("exa", "Exa", { kind: "set-web-search", provider: "exa" })] }) },
  } satisfies { readonly [K in BrowserInPlaceRowId]: InPlaceRowModel }
  const inPlace = (id: BrowserInPlaceRowId) => () => [<InPlaceSettingView row={models[id]} />]

  const renderers: SettingRenderers<"browser", JSX.Element> = {
    "auth-profile": inPlace("auth-profile"),
    "project-profile": () => [<Show when={profile()}><InPlaceSettingView row={models["project-profile"]} /></Show>],
    "show-build": inPlace("show-build"),
    "git-ai-attribution": inPlace("git-ai-attribution"),
    models: () => [<SheetRow label={named("models").label} detail={named("models").description} {...(current().seatModel === undefined ? {} : { value: current().seatModel })} onClick={() => client.openSheet("models")} />],
    authentication: () => [<SheetRow label={named("authentication").label} detail={named("authentication").description} onClick={() => client.openSheet("providers")} />],
    "auth-profiles": () => [<SheetRow label={named("auth-profiles").label} detail={named("auth-profiles").description} value={current().profile.displayName} onClick={() => client.openSheet("profiles")} />],
    "allow-training-routes": inPlace("allow-training-routes"),
    "provider-settings": () => [
      <Key each={current().providerSettings} by={(setting) => JSON.stringify([current().profileId, providerSettingId(setting)])}>{(setting) => { const row = providerSettingModel(setting); return <InPlaceSettingView row={row} /> }}</Key>,
    ],
    status: () => [<SheetRow label={named("status").label} detail={named("status").description} value={describeUpdateStatus(client.state().update?.status)} onClick={() => client.openSheet("status")} />],
    "client-modules": () => [
      <Key each={moduleRows("settings", pageDomainReader(client.state), current().moduleIds)} by="id">
        {(row) => <ModuleRowView row={row()} onAction={(action) => { if (action.kind === "command") client.actions.invokeCommand(action.id); else client.openSurface(action.id) }} />}
      </Key>,
      // This host's own rows, such as the phone's paired machines.
      <Key each={moduleMenuRows(WEB_MODULES, client, "settings")} by="id">{(row) => <SheetRow label={row().label} detail={row().description} value={row().value} working={row().working} onClick={row().run} />}</Key>,
    ],
    appearance: subsection,
    "show-thinking": inPlace("show-thinking"),
    "write-syntax-theme": inPlace("write-syntax-theme"),
    "diff-colors": inPlace("diff-colors"),
    maintenance: subsection,
    "auto-install": () => [<Show when={client.state().update?.autoInstall}><InPlaceSettingView row={models["auto-install"]} /></Show>],
    "proactive-compaction-threshold": inPlace("proactive-compaction-threshold"),
    "idle-compaction": inPlace("idle-compaction"),
    "auto-delete-session-days": inPlace("auto-delete-session-days"),
    "capability-preset": inPlace("capability-preset"),
    "workflow-mode": inPlace("workflow-mode"),
    "agent-capabilities": subsection,
    "agent-capability-modules": () => [<Key each={switchModules(current().capabilities, undefined)} by={(module) => module.id}>{moduleBlock}</Key>],
    "allow-persistent-processes": inPlace("allow-persistent-processes"),
    "web-search-provider": inPlace("web-search-provider"),
    "capability-groups": () => [
      <Key each={groups()} by={(group) => group}>
        {(group) => (
          <>
            <div class="sheet-subsection">{group()}</div>
            {renderSettingEntries("browser", settingGroupHead(group()), renderers)}
            <Key each={switchModules(current().capabilities, group())} by={(module) => module.id}>{moduleBlock}</Key>
          </>
        )}
      </Key>,
    ],
    sessions: () => [<SheetRow label={named("sessions").label} detail={named("sessions").description} value={`${client.state().sessions.length}`} onClick={() => client.openSheet("sessions")} />],
    "reset-defaults": () => [
      <SheetRow label={named("reset-defaults").label} detail={named("reset-defaults").description} tone="warn" onClick={() => {
        void client.confirm({
          title: "Reset settings to their defaults?",
          detail: `Theme, thinking, Write syntax theme, diff colours, terminal rendering, desktop notifications, the web provider, compaction, automatic chat deletion, enabled module settings, and the ${current().profile.displayName} profile's provider settings return to their defaults. Capabilities, models, and accounts are not touched.`,
          confirmLabel: "Reset",
          destructive: true,
        }).then((confirmed) => { if (confirmed) void state.apply({ kind: "reset-defaults" }) })
      }} />,
      <Show when={state.problem("reset")}>{(message) => <div class="sheet-problem">{message()}</div>}</Show>,
    ],
  }
  /** Whether the renderer above shows nothing for `id` yet, because the runtime has not published what it edits. */
  const awaitsRuntime = (id: SettingRowId): boolean =>
    (id === "project-profile" && profile() === undefined) || (id === "auto-install" && client.state().update?.autoInstall === undefined)
  return { renderers, models, awaitsRuntime, groups, moduleConfigSettings, moduleSettingModel, providerSettingModel }
}

/** The id of every catalog row the browser shows. */
export type BrowserSettingRowId = Extract<SettingEntryIdOn<"browser">, SettingRowId>

/** The id of every catalog row the browser changes in place. */
type BrowserInPlaceRowId = Extract<BrowserSettingRowId, InPlaceSettingRowId>

/** One catalog row, by id, with the same write path, working state, and
 *  refusal as Settings. A command surface lists rows through this. */
export function SettingCatalogRowView(props: { readonly client: ClientContextValue; readonly state: SettingRowState; readonly current: () => PanelSettings; readonly id: BrowserSettingRowId }) {
  return <>{renderSettingEntries("browser", [settingCatalogRow(props.id)], browserSettingRenderers(props.client, props.state, props.current))}</>
}

/** One row that changes its value in place, as a command surface lists it. */
export interface InPlaceSettingRow {
  readonly id: string
  readonly model: InPlaceRowModel
}

/** Every row of the setting catalog that changes one value in place and that
 *  the browser shows, in catalog order: the catalog's own switch, choice, and
 *  number rows, each provider setting at its slot, and each module's switch
 *  and configuration rows at its module's place. A command surface lists
 *  these with the same values, writes, working state, and refusal as Settings
 *  (PI-INTERACTION-081). The accessor is reactive. */
export function createInPlaceSettingRows(client: ClientContextValue, state: SettingRowState, current: () => PanelSettings): () => readonly InPlaceSettingRow[] {
  const parts = browserSettingParts(client, state, current)
  const changesInPlace = (id: SettingRowId): id is BrowserInPlaceRowId => Object.hasOwn(parts.models, id)
  // Each module's own switch, then its configuration rows, as Settings lists them.
  const moduleInPlaceRows = (group: string | undefined): readonly InPlaceSettingRow[] => switchModules(current().capabilities, group)
    .flatMap((module) => [
      { id: `module-switch:${module.id}`, model: moduleSwitchModel(client, () => current().capabilities, () => module) },
      ...parts.moduleConfigSettings(module).map((setting) => ({ id: moduleSettingId(setting), model: parts.moduleSettingModel(() => setting) })),
    ])
  const rowsOf = (entry: SettingCatalogEntry): readonly InPlaceSettingRow[] => {
    switch (entry.kind) {
      case "subsection": return entry.entries.flatMap(rowsOf)
      case "row": return changesInPlace(entry.id) && !parts.awaitsRuntime(entry.id) ? [{ id: entry.id, model: parts.models[entry.id] }] : []
      case "slot":
        switch (entry.id) {
          case "provider-settings": return current().providerSettings.map((setting) => ({ id: providerSettingId(setting), model: parts.providerSettingModel(() => setting) }))
          case "client-modules": return []
          case "agent-capability-modules": return moduleInPlaceRows(undefined)
          case "capability-groups": return parts.groups().flatMap((group) => [...settingGroupHead(group).flatMap(rowsOf), ...moduleInPlaceRows(group)])
        }
    }
  }
  return () => SETTING_SECTIONS.flatMap((section) => section.entries.flatMap(rowsOf))
}
