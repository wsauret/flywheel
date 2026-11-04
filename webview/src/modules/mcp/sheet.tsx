import { createComputed, createEffect, on, onCleanup, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import { mcpDomain, mcpEnabledAction, mcpProjectEnabledAction, mcpScopeDetail, type McpStatusRow, MCP_COMMAND_NAME } from "../../../../src/protocol/modules/mcp.js"
import { useClient } from "../../app/client-context.js"
import { Sheet, SheetEmpty, SheetLoading, SheetRow } from "../../app/sheets/sheet.js"
import { createMcpMutation } from "./mutation.js"

/** Applied scope and connection state come from the current project's protocol view. */
export function McpSheet() {
  const client = useClient()
  const servers = () => client.state().modules[mcpDomain.domain]
  const projectRoot = client.state().projectRoot
  const lifetime = new AbortController()
  const active = () => client.state().projectRoot === projectRoot && client.state().settings?.moduleIds.includes("mcp") !== false
  const cancel = () => lifetime.abort()
  client.signal.addEventListener("abort", cancel, { once: true })
  onCleanup(() => { cancel(); client.signal.removeEventListener("abort", cancel) })
  createComputed(() => { if (client.signal.aborted || !active()) cancel() })
  const operation = createMcpMutation({ actions: client.actions, dispatch: (mutation) => client.connection.dispatch(mutation), confirm: client.confirm, report: client.report }, active, lifetime.signal)
  const controls = new Map<string, HTMLElement>()
  let sheet: HTMLDivElement | undefined
  let focused: string | undefined
  let previous: readonly string[] = []
  const runAction = async (name: string, target: HTMLButtonElement, action: () => Promise<void>) => {
    focused = name
    await action()
    if (!lifetime.signal.aborted && focused === name && target.isConnected) target.focus({ preventScroll: true })
  }
  createEffect(on(servers, (rows) => {
    const names = rows?.map((row) => row.name) ?? []
    if (focused !== undefined && !names.includes(focused)) {
      const index = previous.indexOf(focused)
      const next = previous.slice(index + 1).find((name) => names.includes(name)) ?? previous.slice(0, index).toReversed().find((name) => names.includes(name)) ?? names[0]
      focused = next
      const element = next === undefined ? sheet?.querySelector<HTMLButtonElement>('button[aria-label="Close"]') : controls.get(next)?.querySelector<HTMLButtonElement>("button")
      element?.focus({ preventScroll: true })
    }
    previous = names
  }))
  const register = (name: string, element: HTMLDivElement) => {
    controls.set(name, element)
    element.addEventListener("focusin", () => { focused = name })
    element.addEventListener("focusout", (event) => { if (event.relatedTarget instanceof Node && sheet?.contains(event.relatedTarget) && !element.contains(event.relatedTarget) && focused === name) focused = undefined })
    onCleanup(() => { if (controls.get(name) === element) controls.delete(name) })
  }
  const tone = (server: McpStatusRow) => (server.error !== undefined ? "error" : server.status === "ready" ? "ok" : "warn")
  return (
    <div ref={(element) => { sheet = element }}><Sheet title={MCP_COMMAND_NAME} onClose={client.closeSheet}>
      <Show when={servers()} fallback={<SheetLoading />}>{(rows) =>
      <Show when={rows().length > 0} fallback={<SheetEmpty>No MCP servers configured.</SheetEmpty>}>
        <Key each={rows()} by="name">
          {(server) => (
            <SheetRow
              label={server().name}
              tone={tone(server())}
              detail={<>
                {`${server().status} · ${server().toolCount} tool${server().toolCount === 1 ? "" : "s"}`}<br />
                {mcpScopeDetail(server())}<Show when={server().error}>{(error) => <> · {error()}</>}</Show>
              </>}
            >
              <div class="sheet-row-main" ref={(element) => register(server().name, element)} aria-busy={operation.working(server().name) || undefined}>
                <Show when={server().status === "needs_auth"}><button class="secondary" disabled={operation.working(server().name)} onClick={(event) => { void runAction(server().name, event.currentTarget, () => operation.authenticate(server())) }}>Authenticate</button></Show>
                <Show when={server().status === "failed"}><button class="secondary" disabled={operation.working(server().name)} onClick={(event) => { void runAction(server().name, event.currentTarget, () => operation.reconnect(server())) }}>Reconnect</button></Show>
                <button class="secondary" disabled={operation.working(server().name)} onClick={(event) => { void runAction(server().name, event.currentTarget, () => operation.enabled(server(), mcpEnabledAction(server()))) }}>{mcpEnabledAction(server()).label}</button>
                <Show when={mcpProjectEnabledAction(server())}>{(action) => <button class="secondary" disabled={operation.working(server().name)} onClick={(event) => { void runAction(server().name, event.currentTarget, () => operation.enabled(server(), action())) }}>{action().label}</button>}</Show>
                <button class="ghost" disabled={operation.working(server().name)} onClick={(event) => { void runAction(server().name, event.currentTarget, () => operation.remove(server())) }}>Remove</button>
                <Show when={operation.working(server().name)}><span>Working…</span></Show>
              </div>
            </SheetRow>
          )}
        </Key>
      </Show>
      }</Show>
    </Sheet></div>
  )
}
