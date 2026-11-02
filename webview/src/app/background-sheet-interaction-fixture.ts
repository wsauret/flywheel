import { createComponent, createRoot, createSignal } from "solid-js"
import type { FrontendEvent } from "../../../src/protocol/app-service-types.js"
import type { BackgroundWorkRow, BackgroundWorkTarget } from "../../../src/protocol/background-index-protocol-types.js"
import { ClientExtensionsProvider } from "./client-extensions.js"
import type { WebModuleClient } from "../web-module-client.js"

import { createElement, insert, nodes, textContent } from "./render-ownership-host-fixture.js"
import { BackgroundSheet } from "./sheets/background-sheet.js"
import { fakeClient, fakeClientActions, fakeViewState } from "./client-context-fixture.js"
import { fakeRuntimeConnection } from "../client/runtime-connection-fixture.js"
import { fakeLanes } from "../../../tests/helpers/fake-lanes.js"

const tick = async (): Promise<void> => {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
}

/** Mounts the real background sheet over a chat whose transcript has loaded
 *  no block, so every card the rows name is outside the loaded window. */
export function mountBackgroundSheet(rows: readonly BackgroundWorkRow[], stored: { [key: string]: string } = {}) {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const [state] = createSignal(fakeViewState({ sessionId: "chat" }))
    const queries: unknown[] = []
    const mutations: unknown[] = []
    const landings: Array<readonly [string, string]> = []
    const marked: Array<string | undefined> = []
    const selected: Array<readonly [string, unknown]> = []
    const openedTargets: BackgroundWorkTarget[] = []
    const confirmations: Array<(confirmed: boolean) => void> = []
    const listeners = new Set<(event: FrontendEvent) => void>()
    const lanes = fakeLanes()
    let currentRows = rows
    let closed = 0
    Reflect.set(globalThis, "localStorage", {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, value: string) => { stored[key] = value },
    })
    const client = fakeClient({
      state,
      actions: fakeClientActions({
        async openAround(sessionId, entryId) { landings.push([sessionId, entryId]); return `block-${entryId}` },
        selectSession(sessionId, link) { selected.push([sessionId, link]) },
      }),
      connection: fakeRuntimeConnection({
        onQuery: (request) => { queries.push(request) },
        onDispatch: (mutation) => { mutations.push(mutation) },
        queries: { sessionBackgroundWork: () => ({ snapshotPosition: 1, rows: currentRows }) },
        mutations: { "background.terminate": () => ({ ok: true }) },
      }, {
        ...lanes.client,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }),
      markBlock(blockId) { marked.push(blockId) },
      closeSheet() { closed += 1 },
      confirm() { return new Promise((resolve) => { confirmations.push(resolve) }) },
    })
    Reflect.set(globalThis, "__flywheelBackgroundSheetTestClient", client)
    const extension: WebModuleClient = {
      provide: render => render(), header: () => undefined, surface: () => undefined, input: () => undefined, coversConversation: () => false, openUri: () => false, move: () => false, back: () => false,
      openTarget: target => { openedTargets.push(target); return true },
    }
    insert(root, createComponent(ClientExtensionsProvider, {
      value: [extension],
      get children() { return createComponent(BackgroundSheet, {}) },
    }))

    const rowOf = (label: string) => {
      const row = nodes(root).find((node) => typeof node.properties.class === "string" && node.properties.class.includes("sheet-row-button") && textContent(node).includes(label))
      if (!row) throw new Error(`Missing row: ${label}`)
      return row
    }
    const handler = (node: ReturnType<typeof rowOf>, name: string) => {
      const run = node.properties[name]
      if (typeof run !== "function") throw new Error(`Node has no ${name} handler`)
      return run
    }
    return {
      dispose(): void {
        disposeRoot()
        Reflect.deleteProperty(globalThis, "__flywheelBackgroundSheetTestClient")
        Reflect.deleteProperty(globalThis, "localStorage")
      },
      ready: tick,
      row: rowOf,
      elements: () => nodes(root),
      refresh(next: readonly BackgroundWorkRow[]) { currentRows = next; lanes.open() },
      text: () => textContent(root),
      queries: () => queries,
      mutations: () => mutations,
      landings: () => landings,
      marked: () => marked,
      selected: () => selected,
      openedTargets: () => openedTargets,
      closed: () => closed,
      stored: () => stored,
      tap(label: string): void { handler(rowOf(label), "onClick")() },
      enter(label: string): void {
        const row = rowOf(label)
        handler(row, "onKeyDown")({ key: "Enter", target: row, currentTarget: row, preventDefault() {} })
      },
      click(label: string, within?: string): void {
        const scope = within === undefined ? root : rowOf(within)
        const button = nodes(scope).find((node) => node.tag === "button" && textContent(node) === label)
        if (!button) throw new Error(`Missing button: ${label}`)
        handler(button, "onClick")({ stopPropagation() {} })
      },
      settleConfirmation(confirmed: boolean): void {
        const settle = confirmations.shift()
        if (!settle) throw new Error("No pending confirmation")
        settle(confirmed)
      },
    }
  })
}
