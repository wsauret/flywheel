import { HOST_ACTION_NAMES } from "../../../src/protocol/client/host-action-names.js"
import { Key } from "@solid-primitives/keyed"
import { scrollEdges } from "./scroll-edges.js"
import { createEffect, createMemo, createSignal, on, Show } from "solid-js"

import type { BuiltInCommandDescriptor } from "../../../src/protocol/command-catalog-protocol-types.js"
import { CAPABILITIES_DETAIL } from "../../../src/protocol/client/capabilities.js"
import { WEB_MODULES } from "../modules.js"
import { moduleMenuRows } from "../web-module.js"
import { catalogSummary, COMMAND_MENU_SECTIONS } from "../client/command-choices.js"
import type { PanelSettings } from "../client/session-settings.js"
import { offeredControls, summaryOf } from "../client/view-state.js"
import type { ClientContextValue } from "./client-context.js"
import { copySessionId } from "./session-copy.js"
import { promptSessionRename } from "./session-actions.js"
import { createInPlaceSettingRows, createSettingRowState, type InPlaceSettingRow } from "./sheets/setting-rows.js"
import { commandReading, commandRefusal, offeredCommandGroups } from "./surfaces.js"
import "../styles/command-panel.css"

/** The composer's `/` panel: the command menu (PI-INTERACTION-017). A bare
 *  slash lists the catalog's top commands, then every setting that changes
 *  in place with its control, then the actions on the chat in front, then
 *  every other command, and a footer says how many commands typing searches.
 *  The runtime's command catalog names and orders every command and the
 *  setting catalog every setting (ARCH-PROTOCOL-037, ARCH-PROTOCOL-066);
 *  this panel adds only the actions on this session and host that no
 *  command covers, such as copying the session ID.
 *
 *  The current value sits right-aligned; toggles and settings change in
 *  place without closing the panel; descriptions exist for hover and search,
 *  never as list text; and the long tail of rows is `filterOnly`, hidden
 *  until the user types.
 *
 *  A row that needs the host, such as the editor's file picker, appears only
 *  when this host carries that command, and a command whose surface this
 *  host has no place for, such as Keyboard shortcuts on a phone, appears in
 *  no list. */

export interface PanelRow {
  readonly id: string
  readonly label: string
  /** Hover tooltip and search text. Never rendered in the list. */
  readonly description?: string
  /** Current value, right-aligned in a secondary colour. */
  readonly value?: string
  /** True while the value waits on the runtime. */
  readonly valueBusy?: boolean
  /** Renders an in-place switch. Rows with a toggle keep the panel open. */
  readonly toggle?: boolean
  /** Steps the value through its choices, which the arrow keys and the
   *  chevrons around the value drive. */
  readonly cycle?: (direction: 1 | -1) => void
  /** Hidden from the bare panel; present once the user types. */
  readonly filterOnly?: boolean
  /** Words a search matches besides the label and description, such as a
   *  command's slash token, so "/bg" finds Background work. */
  readonly keywords?: readonly string[]
  /** The slash tokens that name this row exactly. A query equal to one ranks
   *  this row first, so "/model" picks Models, never a row whose name merely
   *  starts with the word. */
  readonly tokens?: readonly string[]
  /** Acting on the row leaves the panel open, for settings that flip in place
   *  and for a row that writes the draft itself. */
  readonly keepOpen?: boolean
  /** True while the row's action waits on the runtime. Only a row that stays
   *  open after it acts can show it; another control for the same action,
   *  such as the composer's Interrupt, shows it for a row that closes. */
  readonly working?: boolean
  readonly run: () => void
}

export interface PanelGroup {
  readonly title: string
  readonly rows: readonly PanelRow[]
}

interface PanelDeps {
  readonly client: ClientContextValue
  /** The text after the leading slash, or undefined when the panel is closed. */
  readonly query: () => string | undefined
  /** Clears the draft, which closes the panel. */
  readonly close: () => void
}

/** One in-place setting as a panel row, steering the same value and write as
 *  its Settings row. A number is typed in Settings, so it opens there. */
function settingRow({ id, model }: InPlaceSettingRow, openSettings: () => void): PanelRow {
  const shown = model.read()
  // The problem leads the hover text, because it says why the value may not be in force.
  const row = { id: `setting:${id}`, label: shown.label, description: [shown.problem, shown.detail].filter(Boolean).join(" · "), working: shown.working }
  switch (model.kind) {
    case "switch": {
      const { on: switchedOn, disabled, set } = model.read()
      return { ...row, toggle: switchedOn, keepOpen: true, run: () => { if (!disabled) set(!switchedOn) } }
    }
    case "choice": {
      const { value, options } = model.read()
      const at = options.findIndex((option) => option.value === value)
      const cycle = (direction: 1 | -1) => {
        const next = options[(at + direction + options.length) % options.length]
        if (next !== undefined && next.value !== value) next.select()
      }
      return { ...row, value: options[at]?.label ?? value, cycle, keepOpen: true, run: () => cycle(1) }
    }
    case "cycle": {
      const { text, step } = model.read()
      return { ...row, value: text, cycle: step, keepOpen: true, run: () => step(1) }
    }
    case "field":
      return { ...row, value: model.read().text, run: openSettings }
  }
}

/** Every row the panel can show, grouped and ordered. Assembled fresh from the
 *  view state on each read so values and toggles are always current. */
function buildGroups(deps: PanelDeps, settingRows: () => readonly InPlaceSettingRow[]): readonly PanelGroup[] {
  const { client } = deps
  const { actions } = client
  const state = client.state()
  const sessionId = state.sessionId
  const selectedSession = summaryOf(state, sessionId)
  const offered = offeredControls(state, selectedSession)
  // A child's rows differ from a listed session's; its actions are read as
  // one list so the row checks stay string checks.
  const childActions: readonly string[] | undefined = selectedSession && selectedSession.kind !== "chat" ? selectedSession.admittedActions ?? [] : undefined
  /** What the rows call the open session: its kind, so a workflow is never
   *  named a subagent or a chat. */
  const noun = selectedSession?.kind ?? "chat"
  const writeClipboardText = client.host.capabilities.writeClipboardText
  /** A row for a host command, or nothing when this host lacks it. */
  const hostRow = (id: string, row: Omit<PanelRow, "run">): PanelRow[] =>
    actions.hasHostCommand(id) ? [{ ...row, run: () => actions.runHostCommand(id) }] : []

  /** A row this view refuses keeps the panel and the draft, and says why,
   *  the way a typed token's refusal does. */
  const refused = (notice: string) => ({ keepOpen: true, run: () => client.report("warning", notice) })

  /** A catalog command as its descriptor states it. It runs the way a typed
   *  token does, is refused where a typed token is, and counts as a use the
   *  same way. */
  const commandRows = (commands: readonly BuiltInCommandDescriptor[], filterOnly = false): PanelRow[] => commands.flatMap((command) => {
    const surface = command.opens === undefined ? undefined : client.surface(command.opens)
    if (surface?.listed?.() === false) return []
    const reading = commandReading(client, command)
    const refusal = commandRefusal(client, command.id)
    return [{
      id: `command:${command.id}`,
      label: command.title,
      description: command.description,
      keywords: [command.id, ...command.aliases],
      tokens: [command.id, ...command.aliases],
      ...(reading === undefined ? {} : { value: reading.text, ...(reading.busy ? { valueBusy: true } : {}) }),
      ...(filterOnly ? { filterOnly } : {}),
      ...(refusal === undefined ? {
        run: () => {
          actions.invokeCommand(command.id)
          actions.recordCommandUse(command.id)
        },
      } : refused(refusal)),
    }]
  })
  const catalog = offeredCommandGroups(client)

  const settings: PanelRow[] = state.settings === undefined ? [] : settingRows().map((row) => settingRow(row, () => client.openSheet("settings")))

  // The actions on the session in front that no command covers.
  const session: PanelRow[] = [
    ...(sessionId === undefined || writeClipboardText === undefined ? [] : [{
      id: "copy-session-id",
      label: "Copy session ID",
      description: `Copy this ${noun}'s full debugging identifier`,
      run: () => { void copySessionId(writeClipboardText, client.report, sessionId) },
    }]),
    ...(sessionId === undefined || childActions !== undefined ? [] : [
      { id: "close-session", label: HOST_ACTION_NAMES["flywheel.closeSession"], description: "Close this session's runtime; its history stays.", run: () => actions.closeSession(sessionId) },
    ]),
    // Interrupt for every session kind while a turn runs (PI-INTERACTION-043,
    // PI-AGENT-020). Stop is terminal and exists only for a session that
    // answers a parent's tool call.
    ...(sessionId === undefined || offered.primary !== "interrupt" ? [] : [{
      id: "interrupt-session",
      label: HOST_ACTION_NAMES["flywheel.interrupt"],
      description: "Interrupt the running turn or agent; its work so far is kept and it can resume",
      run: () => actions.interrupt(),
    }]),
    ...(sessionId === undefined || !offered.stop ? [] : [{
      id: "stop-session",
      label: "Stop",
      description: "End this run for the chat that started it; it cannot resume",
      run: () => actions.stop(sessionId),
    }]),
    ...(sessionId === undefined || childActions !== undefined ? [] : [{
      id: "rename-chat",
      label: HOST_ACTION_NAMES["flywheel.renameSession"],
      description: "Give this conversation a name you will recognise",
      filterOnly: true,
      run: () => { void promptSessionRename(client, sessionId) },
    }]),
    ...(sessionId === undefined || (childActions !== undefined && !childActions.includes("session.delete")) ? [] : [{
      id: "delete-session",
      label: `Delete ${noun}`,
      description: childActions === undefined ? "Remove this conversation permanently" : `Remove this ${noun} permanently`,
      filterOnly: true,
      run: () => {
        const title = selectedSession?.title ?? sessionId
        void client.confirm({ title: `Delete "${title}"?`, detail: "The conversation and its history are removed. This cannot be undone. Files it changed on disk are not touched.", confirmLabel: "Delete", destructive: true })
          .then((confirmed) => { if (confirmed) actions.removeSession(sessionId) })
      },
    }]),
  ]

  // The actions on this client and host that no command covers.
  const host: PanelRow[] = [
    // The editor mentions files through its own dialog; every other host
    // through the composer's `@` picker.
    ...(actions.hasHostCommand("flywheel.addFiles")
      ? hostRow("flywheel.addFiles", { id: "mention-file", label: HOST_ACTION_NAMES["flywheel.addFiles"], description: "Put a project file's path into the next message", filterOnly: true, keywords: ["attach", "@"] })
      : [{ id: "mention-file", label: HOST_ACTION_NAMES["flywheel.addFiles"], description: "Put a project file's path into the next message", filterOnly: true, keywords: ["attach", "mention", "@"], keepOpen: true, run: () => client.openMentions() }]),
    ...hostRow("flywheel.revertTurn", { id: "revert-turn", label: HOST_ACTION_NAMES["flywheel.revertTurn"], description: "Review the files this chat changed and put back what you choose", filterOnly: true }),
    ...(state.settings === undefined ? [] : [
      { id: "available-models", label: HOST_ACTION_NAMES["flywheel.pickProviderModels"], description: "Curate which provider models Flywheel may use", filterOnly: true, run: () => client.openSheet("provider-models") },
      {
        id: "capabilities",
        label: "Capabilities",
        description: CAPABILITIES_DETAIL,
        value: `${state.settings.capabilitiesOn} of ${state.settings.capabilitiesTotal} on`,
        filterOnly: true,
        run: () => client.openSheet("capabilities"),
      },
    ]),
    ...moduleMenuRows(WEB_MODULES, client, "panel"),
    ...hostRow("flywheel.showRuntimeLog", { id: "runtime-log", label: HOST_ACTION_NAMES["flywheel.showRuntimeLog"], description: "Open the runtime's own output", filterOnly: true }),
    { id: "reconnect", label: HOST_ACTION_NAMES["flywheel.reconnect"], description: "Reconnect to the Flywheel runtime", filterOnly: true, run: () => actions.reconnect() },
    // The version rides as the value because it is the first thing a report
    // needs and this row is where a person goes when something is wrong. The
    // runtime serves this client and refuses any other build, so its version
    // is the client's too.
    ...(actions.canOpenExternal ? [{
      id: "github-issue",
      label: "Open a GitHub issue",
      description: "Open a GitHub issue against Flywheel",
      filterOnly: true,
      ...(state.runtimeVersion === undefined ? {} : { value: state.runtimeVersion }),
      run: () => actions.openExternal("https://github.com/wsauret/flywheel/issues"),
    }] : []),
  ]

  const problems: PanelRow[] = state.settings === undefined || state.settings.configProblems.length === 0 ? [] : [{
    id: "config-problems",
    label: `${state.settings.configProblems.length} configuration problem${state.settings.configProblems.length === 1 ? "" : "s"}`,
    description: state.settings.configProblems.join(" · "),
    run: () => {
      const [first, ...rest] = state.settings?.configProblems ?? []
      if (first === undefined) return
      void client.confirm({ title: first, ...(rest.length === 0 ? {} : { detail: rest.join("\n") }), confirmLabel: "OK" })
    },
  }]

  return [
    // Problems first, because they explain why a row below may not be doing
    // what it says.
    { title: "Problems", rows: problems },
    { title: COMMAND_MENU_SECTIONS.top, rows: commandRows(catalog.top) },
    { title: "Settings", rows: settings },
    { title: COMMAND_MENU_SECTIONS.chat, rows: [...commandRows(catalog.chat), ...session] },
    { title: COMMAND_MENU_SECTIONS.rest, rows: [...commandRows(catalog.more), ...host, ...commandRows(catalog.rest, true)] },
  ].filter((group) => group.rows.length > 0)
}

/** An exact slash token ranks first, then label prefixes, label contains,
 *  keywords, and descriptions. Zero means no match. */
function score(row: PanelRow, query: string): number {
  if (row.tokens?.includes(query)) return 5
  const label = row.label.replace(/^\//, "").toLowerCase()
  if (label.startsWith(query)) return 4
  if (label.includes(query)) return 3
  if (row.keywords?.some((keyword) => keyword.startsWith(query))) return 2
  if (row.description?.toLowerCase().includes(query)) return 1
  return 0
}

export function createCommandPanel(deps: PanelDeps) {
  const [selectedId, setSelectedId] = createSignal<string>()
  const settingState = createSettingRowState(deps.client)
  const current = (): PanelSettings => {
    const settings = deps.client.state().settings
    if (settings === undefined) throw new Error("The command menu lists settings only once they are read")
    return settings
  }
  const settingRows = createInPlaceSettingRows(deps.client, settingState, current)
  let scroll: HTMLDivElement | undefined

  interface VisibleRow extends PanelRow {
    readonly flatIndex: number
    readonly section: string | undefined
  }

  const visible = createMemo((): readonly VisibleRow[] => {
    const query = deps.query()
    if (query === undefined) return []
    const trimmed = query.trim().toLowerCase()
    const ranked: { row: PanelRow; title: string; rank: number }[] = []
    for (const group of buildGroups(deps, settingRows)) {
      for (const row of group.rows) {
        const rank = trimmed === "" ? (row.filterOnly === true ? 0 : 1) : score(row, trimmed)
        if (rank !== 0) ranked.push({ row, title: group.title, rank })
      }
    }
    if (trimmed !== "") ranked.sort((a, b) => b.rank - a.rank)
    return ranked.map(({ row, title }, flatIndex) => ({
      ...row,
      flatIndex,
      section: ranked[flatIndex - 1]?.title === title ? undefined : title,
    }))
  })
  const activeIndex = createMemo(() => visible().findIndex((row) => row.id === selectedId()))

  const open = () => visible().length > 0
  /** The catalog the bare panel is not showing, as one line that opens it:
   *  the commands the Commands sheet lists on this host. */
  const footer = () => {
    if ((deps.query() ?? "").trim() !== "") return undefined
    const { top, chat, more, rest } = offeredCommandGroups(deps.client)
    return catalogSummary([...top, ...chat, ...more, ...rest])
  }

  createEffect(on([deps.query, visible], ([query, rows], previous) => {
    setSelectedId((id) => query === previous?.[0] && rows.some((row) => row.id === id) ? id : rows[0]?.id)
  }))

  // Keyboard focus stays in the composer, so the list cannot rely on native
  // focus scrolling: the active row is walked into view by hand.
  createEffect(() => {
    selectedId()
    activeIndex()
    scroll?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" })
  })

  const pick = (row: PanelRow): void => {
    row.run()
    // A row that writes the draft itself keeps it, so only a plain action
    // still needs the draft cleared to close the panel.
    if (row.keepOpen !== true) deps.close()
  }

  /** Lets the composer's keydown hand the panel its keys first. True when the
   *  key was the panel's to handle. */
  const onKeyDown = (event: Pick<KeyboardEvent, "key" | "preventDefault">): boolean => {
    if (!open()) return false
    const rows = visible()
    if (event.key === "ArrowDown") {
      event.preventDefault()
      setSelectedId(rows[(activeIndex() + 1) % rows.length]?.id)
      return true
    }
    if (event.key === "ArrowUp") {
      event.preventDefault()
      setSelectedId(rows[(activeIndex() - 1 + rows.length) % rows.length]?.id)
      return true
    }
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      const row = rows[activeIndex()]
      const direction = event.key === "ArrowRight" ? 1 as const : -1 as const
      if (row?.toggle !== undefined) {
        // Directional rather than a blind flip: right means on, left means
        // off, and an arrow that would not change anything does nothing.
        event.preventDefault()
        if ((direction === 1) !== row.toggle) pick(row)
        return true
      }
      if (row?.cycle !== undefined) {
        event.preventDefault()
        row.cycle(direction)
        return true
      }
    }
    if (event.key === "Enter" || event.key === "Tab") {
      const row = rows[activeIndex()]
      if (row) {
        event.preventDefault()
        pick(row)
        return true
      }
    }
    if (event.key === "Escape") {
      event.preventDefault()
      deps.close()
      return true
    }
    return false
  }

  const view = () => (
    <Show when={open()}>
      <div class="command-panel" role="listbox">
        <div class="panel-scroll scroll-edges" ref={(el) => { scroll = el; scrollEdges(el) }}>
          <div class="panel-scroll-content">
          {/* Row ids retain DOM identity through background updates and rank
              changes. Section headings ride on each run's first row, so a
              repeated group never merges away the global ranking. */}
          <Key each={visible()} by={(row) => row.id}>
            {(row) => (
              <>
                <Show when={row().section}>
                  {(title) => (
                    <>
                      <Show when={row().flatIndex > 0}><div class="panel-divider" /></Show>
                      <div class="panel-section">{title()}</div>
                    </>
                  )}
                </Show>
                <div
                  class="panel-row"
                  role="option"
                  aria-selected={row().id === selectedId()}
                  aria-busy={row().working || undefined}
                  data-active={row().id === selectedId()}
                  title={row().description}
                  onMouseEnter={() => setSelectedId(row().id)}
                  onPointerDown={(event) => event.preventDefault()}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(row())}
                >
                  <span class="panel-label">{row().label}</span>
                  {/* One virtual column for whatever a row shows on the
                      right, so values and toggles line up down the panel
                      instead of each ending at its own width. */}
                  <Show when={row().value !== undefined || row().toggle !== undefined}>
                    <span class="panel-control">
                      <Show when={row().cycle}>{(cycle) => <span class="panel-cycle-chevron" aria-hidden="true" onClick={(event) => { event.stopPropagation(); cycle()(-1) }}>‹</span>}</Show>
                      <Show when={row().value !== undefined}><span class="panel-value" aria-busy={row().valueBusy || undefined}>{row().value}</span></Show>
                      <Show when={row().cycle}>{(cycle) => <span class="panel-cycle-chevron" aria-hidden="true" onClick={(event) => { event.stopPropagation(); cycle()(1) }}>›</span>}</Show>
                      <Show when={row().toggle !== undefined}><span class="panel-toggle" classList={{ on: row().toggle === true }} /></Show>
                    </span>
                  </Show>
                </div>
              </>
            )}
          </Key>
          </div>
        </div>
        <Show when={footer()}>
          {(text) => (
            <div class="panel-footer" role="button" onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={() => { deps.client.openSheet("commands"); deps.close() }}>{text()}</div>
          )}
        </Show>
      </div>
    </Show>
  )

  return { view, onKeyDown, open }
}
