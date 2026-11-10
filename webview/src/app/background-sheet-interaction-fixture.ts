import { createComponent, createRoot, createSignal } from "solid-js"
import type { FrontendEvent } from "../../../src/protocol/app-service-types.js"
import { backgroundCursor, type BackgroundPatchPayload, type BackgroundWorkRow, type BackgroundWorkTarget } from "../../../src/protocol/background-index-protocol-types.js"
import { backgroundIndexState, createBackgroundIndexReadings, type HeldBackgroundIndex } from "../../../src/protocol/client/background-index.js"
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
 *  no block, so every card the rows name is outside the loaded window. The
 *  chat's background index is followed and read before the sheet mounts, as
 *  the web client follows it from the chat's selection. */
export async function mountBackgroundSheet(rows: readonly BackgroundWorkRow[], stored: { [key: string]: string } = {}) {
  const queries: unknown[] = []
  const mutations: unknown[] = []
  const listeners = new Set<(event: FrontendEvent) => void>()
  const lanes = fakeLanes()
  const connection = fakeRuntimeConnection({
    onQuery: (request) => { queries.push(request) },
    onDispatch: (mutation) => { mutations.push(mutation) },
    queries: { sessionBackgroundWork: () => ({ snapshotPosition: 1, rows }) },
    mutations: { "background.terminate": () => ({ ok: true }), "background.release": () => ({ ok: true }) },
  }, {
    ...lanes.client,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  })
  let held: HeldBackgroundIndex | undefined
  const viewState = () => fakeViewState({ sessionId: "chat", backgroundIndex: backgroundIndexState(held) })
  const [state, setState] = createSignal(viewState())
  const readings = createBackgroundIndexReadings({
    client: connection,
    admits: (sessionId) => sessionId === "chat",
    views: {
      get: () => held,
      set: (_sessionId, view) => { held = view },
      delete: () => { held = undefined },
      keys: () => held === undefined ? [] : ["chat"],
    },
    changed: () => setState(viewState()),
  })
  readings.ensure(["chat"])
  await tick()
  const readBeforeMount = queries.length
  let position = 1
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const landings: Array<readonly [string, string]> = []
    const marked: Array<string | undefined> = []
    const selected: Array<readonly [string, unknown]> = []
    const openedTargets: BackgroundWorkTarget[] = []
    const confirmations: Array<(confirmed: boolean) => void> = []
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
      connection,
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
        readings.dispose()
        Reflect.deleteProperty(globalThis, "__flywheelBackgroundSheetTestClient")
        Reflect.deleteProperty(globalThis, "localStorage")
      },
      ready: tick,
      row: rowOf,
      elements: () => nodes(root),
      /** Publishes one row patch of the chat's index. */
      patch(payload: BackgroundPatchPayload): void {
        position += 1
        for (const listener of listeners) listener({ type: "patch", patch: { cursor: backgroundCursor("chat"), position, prevPosition: position - 1, payload } })
      },
      text: () => textContent(root),
      /** The reads made before the sheet mounted, when the chat was followed. */
      queriesBeforeMount: () => queries.slice(0, readBeforeMount),
      /** The reads made since the sheet mounted. */
      queriesSinceMount: () => queries.slice(readBeforeMount),
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
