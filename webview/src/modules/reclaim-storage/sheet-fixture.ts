import { createComponent, createRoot, createSignal } from "solid-js"
import type { FrontendMutation } from "../../../../src/protocol/app-service-types.js"
import type { RuntimeStorageView, StorageReclaimResult } from "../../../../src/protocol/modules/reclaim-storage.js"
import type { StorageReclaimPreview } from "../../../../src/protocol/store-reclaim.js"
import { ClientContext } from "../../app/client-context.js"
import { fakeClient, fakeViewState } from "../../app/client-context-fixture.js"
import { fakeRuntimeConnection } from "../../client/runtime-connection-fixture.js"
import { createElement, insert, nodes, textContent } from "../../test-support/render-ownership-host-fixture.js"
import { ReclaimStorageSheet } from "./sheet.js"

/** Runs the real Reclaim storage sheet over a scripted preview and reclaim
 *  answer, with the module's view published through `publish`. */
export function mountReclaimStorage(options: {
  readonly preview: StorageReclaimPreview
  readonly view?: RuntimeStorageView
  readonly result?: StorageReclaimResult
}) {
  return createRoot(dispose => {
    const root = createElement("root")
    const mutations: FrontendMutation[] = []
    let answered = options.preview
    let previewReads = 0
    const lifetime = new AbortController()
    const [view, setView] = createSignal<RuntimeStorageView | null>(options.view ?? null)
    const idle = fakeViewState()
    const client = fakeClient({
      signal: lifetime.signal,
      state: () => ({ ...idle, modules: { ...idle.modules, reclaim_storage: view() } }),
      connection: fakeRuntimeConnection({
        onDispatch: (mutation) => { mutations.push(mutation) },
        queries: { "storage.reclaimPreview": () => { previewReads++; return answered } },
        mutations: { "storage.reclaim": () => options.result ?? { ok: true } },
      }),
    })
    insert(root, createComponent(ClientContext.Provider, {
      value: client,
      get children() { return createComponent(ReclaimStorageSheet, {}) },
    }))
    const button = (label: string) => nodes(root).find(item => item.tag === "button" && textContent(item) === label)
    const row = (label: string) => nodes(root).find(item => String(item.properties.class).includes("sheet-row") && textContent(item).startsWith(label))
    const paragraph = (start: string) => nodes(root).find(item => item.tag === "p" && textContent(item).startsWith(start))
    return {
      mutations, button, row, paragraph,
      text: () => textContent(root),
      publish: setView,
      previewReads: () => previewReads,
      /** The service measures `next`, which the next preview read answers. */
      measure(next: StorageReclaimPreview) { answered = next },
      click(label: string) {
        const run = button(label)?.properties.onClick
        if (typeof run !== "function") throw new Error(`Missing click: ${label}`)
        run()
      },
      async settle() { for (let n = 0; n < 8; n++) await Promise.resolve() },
      dispose() { lifetime.abort(); dispose() },
    }
  })
}
