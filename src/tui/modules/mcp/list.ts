import { createSignal, onCleanup } from "solid-js"
import { mcpDomain, mcpEnabledAction, mcpProjectEnabledAction, type McpStatusRow } from "../../../protocol/modules/mcp.js"
import type { ListModalKeyEvent } from "../../components/modal-list-keys.js"
import type { TuiSurfaceHost } from "../../tui-module.js"
import { createKeyedListSelection } from "../../hooks/create-keyed-list-selection.js"

export interface McpRemovalState {
  readonly row: McpStatusRow
  readonly focus: number
}

type McpRequest = Extract<Parameters<TuiSurfaceHost["client"]["dispatch"]>[0], { type: "mcp.authenticate" | "mcp.reconnect" | "mcp.setEnabled" | "mcp.remove" }>

/** The cached surface owns unsettled operations across modal openings. */
export function createMcpOperations(host: Pick<TuiSurfaceHost, "client" | "showToast">) {
  const [pending, setPending] = createSignal<string>()
  const run = (operation: string, request: McpRequest, done: string, active: () => boolean) => {
    if (!active() || pending()) return
    setPending(operation)
    void host.client.dispatch(request).then((result) => {
      if (!active()) return
      if (!result.ok) host.showToast({ message: result.error, variant: "error" })
      else if ("warning" in result && result.warning) host.showToast({ message: result.warning, variant: "warning" })
      else host.showToast({ message: done, variant: "success" })
    }).catch(() => {
      if (active()) host.showToast({ message: "MCP action failed. Check server settings and try again.", variant: "error" })
    }).finally(() => { setPending(undefined) })
  }
  return { pending, run }
}

/** Each opening owns its cursor and review; protocol rows remain the authority. */
export function createMcpList(host: Pick<TuiSurfaceHost, "read" | "client" | "showToast" | "close">, operations = createMcpOperations(host)) {
  const [review, setReview] = createSignal<McpRemovalState>()
  const { pending } = operations
  const rows = () => host.read(mcpDomain)
  const selection = createKeyedListSelection(() => rows()?.map((row) => row.name) ?? [])
  const cursor = selection.cursor
  const selected = () => rows()?.[cursor()]
  let active = true
  onCleanup(() => { active = false })
  const select = (index: number) => { if (!pending() && !review()) selection.select(Math.max(0, index)) }
  /** Runs the one action that repairs the selected row's connection, when its status has one. */
  const repair = () => {
    const row = selected()
    if (!row || review()) return
    if (row.status === "needs_auth") operations.run(`Authenticating ${row.name}...`, { type: "mcp.authenticate", server: row.name }, `${row.name} authenticated`, () => active)
    else if (row.status === "failed") operations.run(`Reconnecting ${row.name}...`, { type: "mcp.reconnect", server: row.name }, `${row.name} connected`, () => active)
  }
  const setEnabled = (project = false) => {
    const row = selected()
    if (!row || review()) return
    const action = project ? mcpProjectEnabledAction(row) : mcpEnabledAction(row)
    if (action) operations.run(`${action.enabled ? "Enabling" : "Disabling"} ${row.name}...`, { type: "mcp.setEnabled", server: row.name, scope: action.scope, enabled: action.enabled, expected: row.expected }, `${row.name} ${action.enabled ? "enabled" : "disabled"}`, () => active)
  }
  const remove = () => { const row = selected(); if (active && row && !pending() && !review()) setReview({ row, focus: 0 }) }
  const cancel = () => { if (!pending()) setReview(undefined) }
  const confirm = () => {
    const state = review()
    if (!state || pending()) return
    setReview(undefined)
    operations.run(`Removing ${state.row.name}...`, { type: "mcp.remove", server: state.row.name, scope: state.row.definitionScope, expected: state.row.expected }, `${state.row.name} removed`, () => active)
  }
  const close = () => { host.close() }
  const key = (event: ListModalKeyEvent): boolean => {
    const name = event.name.toLowerCase()
    if (pending()) {
      if (name === "escape" || name === "q") close()
      event.preventDefault?.()
      return true
    }
    const state = review()
    if (state) {
      event.preventDefault?.()
      if (name === "escape" || name === "q") cancel()
      else if (name === "left" || name === "right" || name === "tab") setReview({ ...state, focus: state.focus === 0 ? 1 : 0 })
      else if (name === "return" || name === "enter") { if (state.focus === 0) cancel(); else confirm() }
      return true
    }
    if (name === "up" || name === "k" || name === "down" || name === "j") {
      const count = rows()?.length ?? 0
      if (count) select((cursor() + (name === "up" || name === "k" ? count - 1 : 1)) % count)
    } else if (name === "enter" || name === "return") repair()
    else if (name === "r") { if (selected()?.status === "failed") repair() }
    else if (name === "e") setEnabled()
    else if (name === "p") setEnabled(true)
    else if (name === "d") remove()
    else if (name === "escape" || name === "q") close()
    else return false
    event.preventDefault?.()
    return true
  }
  return { rows, cursor, selected, select, navigationRevision: selection.revision, pending, review, repair, setEnabled, remove, cancel, confirm, close, key }
}

export type McpList = ReturnType<typeof createMcpList>
