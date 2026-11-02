/** The one setting catalog (ARCH-PROTOCOL-066, PI-INTERACTION-081).
 *
 *  Every client's Settings shows these sections, in this order, with these
 *  row names and descriptions. A client chooses only how a row looks, and it
 *  leaves out a row whose `host` names another client. A client renders every
 *  entry through a table keyed by entry id that is total over the entries it
 *  shows, so an entry added here does not compile until each client that
 *  shows it can render it.
 *
 *  A slot is a place for a family of rows that another owner publishes:
 *  provider modules declare their numeric settings, runtime modules declare
 *  their switches and configuration rows, and client modules contribute their
 *  own rows. The catalog fixes where the family sits; its owner names its rows. */

/** How a row changes what it shows. `switch`, `choice`, and `number` change
 *  one value in place; `screen` opens another surface; `action` runs once. */
type SettingControl = "switch" | "choice" | "number" | "screen" | "action"

/** The client host whose own behavior a row describes. */
export type SettingHost = "terminal" | "browser"

interface CatalogRowDeclaration {
  readonly label: string
  readonly description: string
  readonly control: SettingControl
  /** The only host that shows this row. Absent means every host. */
  readonly host?: SettingHost
  /** The persisted setting the row presents, by its definition id. */
  readonly setting?: string
}

const ROWS = {
  "auth-profile": { label: "Auth profile", description: "Choose the auth profile whose credentials Flywheel uses.", control: "choice" },
  "project-profile": { label: "Project profile", description: "Bind this project to an auth profile, or follow the selection.", control: "choice" },
  "show-build": { label: "Show build (this project)", description: "Show the backend build id on the welcome card of this project.", control: "switch" },
  "git-ai-attribution": { label: "Git AI attribution", description: "Mark commits made under the active profile as AI-assisted.", control: "switch" },
  models: { label: "Models", description: "Choose each role's model and effort, for a chat or the defaults.", control: "screen" },
  authentication: { label: "Authentication", description: "Sign in to a model provider, add an API key, or review paid use.", control: "screen" },
  "auth-profiles": { label: "Auth profiles", description: "Create, rename, bind, or delete credential profiles.", control: "screen" },
  "allow-training-routes": { label: "Allow training routes", description: "Let providers train on requests sent through contributor routes.", control: "switch" },
  status: { label: "Status", description: "Version, model, account, and connection health.", control: "screen" },
  theme: { label: "Theme", description: "Choose the interface color theme.", control: "screen", host: "terminal", setting: "theme" },
  "show-thinking": { label: "Show thinking", description: "Show the model's thinking as text in the transcript.", control: "switch", setting: "showThinking" },
  "write-syntax-theme": { label: "Write syntax theme", description: "Write tool colors only. Chat Markdown keeps the interface theme.", control: "choice", setting: "writeSyntaxTheme" },
  "diff-colors": { label: "Diff colours", description: "Theme tints, or the standard green and red every diff tool uses.", control: "choice", setting: "diffColors" },
  "compatible-rendering": { label: "Compatible rendering", description: "Connect borders in Terminal.app; Auto detects the terminal.", control: "choice", host: "terminal", setting: "compatibleRendering" },
  font: { label: "Font", description: "Install the bundled Monaspace Argon terminal font.", control: "action", host: "terminal" },
  "auto-install": { label: "Automatic updates", description: "Install new Flywheel releases automatically.", control: "switch", setting: "autoInstall" },
  "proactive-compaction-threshold": { label: "Auto compact at", description: "Compact after this many context tokens. 0 turns it off.", control: "number", setting: "proactiveCompactionThreshold" },
  "idle-compaction": { label: "Idle compaction", description: "Save notes and reset large idle chats before cache expiry.", control: "switch", setting: "idleCompaction" },
  "auto-delete-session-days": { label: "Auto-delete unused chats", description: "Permanently delete chats after N inactive days. 0 turns it off.", control: "number", setting: "autoDeleteSessionDays" },
  "capability-preset": { label: "Capabilities preset", description: "Minimal turns every module off. Full turns the defaults on.", control: "choice" },
  "workflow-mode": { label: "Workflow mode", description: "Whether agents may launch workflows, and whether they ask first.", control: "choice" },
  "allow-persistent-processes": { label: "Allow persistent processes", description: "Let selected processes outlive Flywheel; you must stop them.", control: "switch", setting: "allowPersistentProcesses" },
  "web-search-provider": { label: "Web search provider", description: "The first web retrieval provider Flywheel tries.", control: "choice", setting: "webSearchProvider" },
  sessions: { label: "Sessions", description: "Browse, resume, and delete chats and workflows.", control: "screen" },
  "reset-defaults": { label: "Reset to defaults", description: "Return shared settings to their defaults.", control: "action" },
} as const satisfies { readonly [id: string]: CatalogRowDeclaration }

type Rows = typeof ROWS
export type SettingRowId = keyof Rows

/** One row of the catalog, with its id. */
export type SettingCatalogRow<Id extends SettingRowId = SettingRowId> = { readonly [K in Id]: Rows[K] & { readonly kind: "row"; readonly id: K } }[Id]

/** The families of rows whose owner is not the catalog. */
export type SettingSlotId =
  /** Each enabled provider module's numeric settings for the active profile. */
  | "provider-settings"
  /** The rows the client's own modules contribute, such as remote access. */
  | "client-modules"
  /** The switch of every enabled module that sits in no group. */
  | "agent-capability-modules"
  /** One subsection per module group, each with its modules' switches and configuration rows. */
  | "capability-groups"

export interface SettingCatalogSlot<Id extends SettingSlotId = SettingSlotId> {
  readonly kind: "slot"
  readonly id: Id
}

/** A named group of rows inside a section. */
export interface SettingCatalogSubsection<Id extends string = string> {
  readonly kind: "subsection"
  readonly id: Id
  readonly label: string
  readonly description: string
  readonly entries: readonly (SettingCatalogRow | SettingCatalogSlot)[]
}

export type SettingCatalogEntry = SettingCatalogRow | SettingCatalogSlot | SettingCatalogSubsection

export interface SettingCatalogSection {
  readonly title: string
  readonly entries: readonly SettingCatalogEntry[]
}

function row<Id extends SettingRowId>(id: Id): SettingCatalogRow<Id> {
  // SAFETY: `ROWS[id]` is the declaration under `id`, so the spread with `id` is exactly the row of `Id`; the generic index erases that correlation.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: generic index of a const table
  return { ...ROWS[id], kind: "row", id } as SettingCatalogRow<Id>
}

const slot = <Id extends SettingSlotId>(id: Id): SettingCatalogSlot<Id> => ({ kind: "slot", id })

const subsection = <Id extends string>(id: Id, label: string, description: string, entries: SettingCatalogSubsection["entries"]): SettingCatalogSubsection<Id> => ({ kind: "subsection", id, label, description, entries })

/** The rows a module group starts with, ahead of its modules' rows. */
const SETTING_GROUP_HEADS = {
  "Web retrieval": [row("web-search-provider")],
} as const satisfies { readonly [group: string]: readonly SettingCatalogRow[] }

/** The rows module group `group` starts with. */
export function settingGroupHead(group: string): readonly SettingCatalogRow[] {
  return Object.entries(SETTING_GROUP_HEADS).find(([name]) => name === group)?.[1] ?? []
}

export const SETTING_SECTIONS = [
  { title: "Session", entries: [row("auth-profile"), row("project-profile"), row("show-build"), row("git-ai-attribution")] },
  { title: "Models and auth", entries: [row("models"), row("authentication"), row("auth-profiles"), row("allow-training-routes"), slot("provider-settings")] },
  { title: "Application", entries: [
    row("status"),
    slot("client-modules"),
    subsection("appearance", "Appearance", "Configure interface appearance and transcript display.", [row("show-thinking"), row("write-syntax-theme"), row("diff-colors"), row("theme"), row("compatible-rendering"), row("font")]),
    subsection("maintenance", "Maintenance", "Configure updates, context compaction, and chat cleanup.", [row("auto-install"), row("proactive-compaction-threshold"), row("idle-compaction"), row("auto-delete-session-days")]),
  ] },
  { title: "Autonomy", entries: [
    row("capability-preset"),
    row("workflow-mode"),
    subsection("agent-capabilities", "Agent capabilities", "Configure background work, learning, skills, and subagents.", [slot("agent-capability-modules"), row("allow-persistent-processes")]),
    slot("capability-groups"),
  ] },
  { title: "Manage", entries: [row("sessions"), row("reset-defaults")] },
] as const satisfies readonly SettingCatalogSection[]

type SectionEntry = (typeof SETTING_SECTIONS)[number]["entries"][number]
type WithChildren<E> = E extends { readonly kind: "subsection"; readonly entries: readonly (infer Child)[] } ? E | Child : E
type LaidOutEntry = WithChildren<SectionEntry> | (typeof SETTING_GROUP_HEADS)[keyof typeof SETTING_GROUP_HEADS][number]

/** The laid-out entry whose id is `Id`. */
type SettingCatalogEntryOf<Id extends string> = Extract<LaidOutEntry, { readonly id: Id }>

/** Whether `host` shows the catalog entry or module configuration row. */
export function shownOn(entry: SettingCatalogEntry | { readonly host?: SettingHost }, host: SettingHost): boolean {
  return !("host" in entry) || entry.host === undefined || entry.host === host
}

/** The id of every entry `host` shows: rows, slots, and subsections. A
 *  client's renderer table is keyed by exactly this union. */
export type SettingEntryIdOn<H extends SettingHost> = Exclude<LaidOutEntry, { readonly host: Exclude<SettingHost, H> }>["id"]

/** A client's renderer of every entry its host shows. A subsection's
 *  renderer receives its children already rendered. */
export type SettingRenderers<H extends SettingHost, R> = {
  readonly [K in SettingEntryIdOn<H>]: (entry: SettingCatalogEntryOf<K>, children: () => readonly R[]) => readonly R[]
}

/** Renders `entries` for `host` through its renderer table, in catalog order. */
export function renderSettingEntries<H extends SettingHost, R>(host: H, entries: readonly SettingCatalogEntry[], renderers: SettingRenderers<H, R>): readonly R[] {
  return entries.flatMap((entry) => {
    if (!shownOn(entry, host)) return []
    // SAFETY: an entry shown on `host` has an id of `SettingEntryIdOn<H>`, and its renderer takes that entry; the mapped table erases the id and entry correlation.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: lookup in a mapped renderer table
    const render = renderers[entry.id as SettingEntryIdOn<H>] as (entry: SettingCatalogEntry, children: () => readonly R[]) => readonly R[]
    return render(entry, () => entry.kind === "subsection" ? renderSettingEntries(host, entry.entries, renderers) : [])
  })
}

/** Every row in catalog order, subsection rows in place and module group
 *  heads at their slot. */
export const SETTING_ROWS: readonly SettingCatalogRow[] = SETTING_SECTIONS.flatMap((section) => section.entries.flatMap(function rowsOf(entry: SettingCatalogEntry): readonly SettingCatalogRow[] {
  if (entry.kind === "row") return [entry]
  if (entry.kind === "subsection") return entry.entries.flatMap(rowsOf)
  return entry.id === "capability-groups" ? Object.values(SETTING_GROUP_HEADS).flat() : []
}))

/** The id of every row that changes one value in place. */
export type InPlaceSettingRowId = { readonly [K in SettingRowId]: Rows[K]["control"] extends "switch" | "choice" | "number" ? K : never }[SettingRowId]

/** The rows that change one value in place, in catalog order. A command
 *  surface lists these as its settings rows. */
export const IN_PLACE_SETTING_ROWS: readonly SettingCatalogRow<InPlaceSettingRowId>[] = SETTING_ROWS.filter((entry): entry is SettingCatalogRow<InPlaceSettingRowId> => entry.control === "switch" || entry.control === "choice" || entry.control === "number")

/** The catalog row of `id`. */
export function settingCatalogRow<Id extends SettingRowId>(id: Id): SettingCatalogRow<Id> {
  return row(id)
}

/** The setting ids the catalog presents. */
export type SettingCatalogSettingId = { readonly [K in SettingRowId]: Rows[K] extends { readonly setting: infer S extends string } ? S : never }[SettingRowId]

/** The row that presents the persisted setting `setting`. */
export function settingCatalogRowFor(setting: SettingCatalogSettingId): SettingCatalogRow {
  const found = SETTING_ROWS.find((entry) => "setting" in entry && entry.setting === setting)
  if (found === undefined) throw new Error(`No catalog row presents ${setting}`)
  return found
}
