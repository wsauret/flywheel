import { createComponent, createRoot, createSignal } from "solid-js"
import type { SideQuestionView, SideQuestionResult } from "../../../../src/protocol/modules/side-question.js"
import { fakeClient, fakeClientActions, fakeClientHost, fakePanelSettings, fakeViewState } from "../../app/client-context-fixture.js"
import { fakeRuntimeConnection } from "../../client/runtime-connection-fixture.js"
import { createElement, insert, nodes, textContent } from "../../app/render-ownership-host-fixture.js"
import { SideQuestionSheet } from "./sheet.js"

interface SimulatedSheetEvent {
  readonly currentTarget?: { readonly value: string }
  readonly key?: string
  readonly shiftKey?: boolean
}

/** Drives the real surface with canonical protocol publications under a browser-condition owner. */
export function mountSideQuestion(view: SideQuestionView | null, response?: Promise<SideQuestionResult>, options: { readonly selection?: "unknown" } = {}) {
  return createRoot((disposeRoot) => {
    const root = createElement("root")
    const domains = (next: SideQuestionView | null) => ({
      "side-question": next ? { revision: next.revision, exchanges: next.exchanges } : null,
      "side-question-request": next ? { current: next.current } : null,
    })
    const idle = fakeViewState()
    const [state, setState] = createSignal(fakeViewState({ sessionId: "parent", modules: { ...idle.modules, ...domains(view) }, settings: options.selection === "unknown" ? undefined : fakePanelSettings({ moduleIds: ["side-question"] }) }))
    const mutations: unknown[] = []
    const copied: string[] = []
    const opened: string[] = []
    let closed = 0
    let focused = 0
    const answer = (): SideQuestionResult | Promise<SideQuestionResult> => response ?? { ok: true, destinationSessionId: "kept" }
    const client = fakeClient({
      state,
      connection: fakeRuntimeConnection({
        onDispatch: (mutation) => { mutations.push(mutation) },
        mutations: { "side-question.ask": answer, "side-question.keep": answer, "side-question.clear": answer, "side-question.stop": answer },
      }),
      host: fakeClientHost({ capabilities: { writeClipboardText: async (text) => { copied.push(text) } } }),
      actions: fakeClientActions({
        selectSession: (id) => { opened.push(id) },
        send: async () => { throw new Error("Parent send must not run") },
      }),
      closeSheet: () => { closed += 1 }, focusComposer: () => { focused += 1 },
    })
    Reflect.set(globalThis, "__sideQuestionClient", client)
    insert(root, createComponent(SideQuestionSheet, {}))
    const find = (tag: string, label?: string) => {
      const node = nodes(root).find((item) => item.tag === tag && (label === undefined || textContent(item) === label || item.properties["aria-label"] === label))
      if (!node) throw new Error(`Missing ${tag}: ${label}`)
      return node
    }
    const event = (node: ReturnType<typeof find>, name: string, value: SimulatedSheetEvent = {}) => {
      const handler = node.properties[name]
      if (typeof handler !== "function") throw new Error(`Missing handler ${name}`)
      handler({ preventDefault() {}, stopPropagation() {}, ...value })
    }
    const body = () => {
      const node = nodes(root).find((item) => item.properties.class === "sheet-body scroll-edges")
      if (!node) throw new Error("Missing sheet scroll body")
      return node
    }
    return {
      text: () => textContent(root), mutations, copied, opened,
      closed: () => closed, focused: () => focused,
      publish(next: SideQuestionView | null) { setState((old) => ({ ...old, modules: { ...old.modules, ...domains(next) } })) },
      leave() { setState((old) => ({ ...old, sessionId: "other" })) },
      disable() { setState((old) => ({ ...old, settings: fakePanelSettings({ moduleIds: [] }) })) },
      click(label: string) { event(find("button", label), "onClick") },
      ask(question: string) { event(find("textarea"), "onInput", { currentTarget: { value: question } }); event(find("form"), "onSubmit") },
      draft: () => find("textarea").properties.value,
      inputDisabled: () => find("textarea").properties.disabled,
      inputFocusRequested: () => find("textarea").properties.focused,
      disabled: (label: string) => find("button", label).properties.disabled,
      inFooter: (tag: string, label?: string) => {
        for (let node = find(tag, label).parent; node; node = node.parent) {
          if (node.properties.class === "sheet-footer") return true
        }
        return false
      },
      key(key: string, shiftKey = false) { event(find("textarea"), "onKeyDown", { key, shiftKey }) },
      type(question: string) { event(find("textarea"), "onInput", { currentTarget: { value: question } }) },
      escape() { event(find("section"), "onKeyDown", { key: "Escape" }) },
      scroll(value: number) { body().scrollTop = value; event(body(), "onScroll") },
      offset: () => body().scrollTop,
      async ready() { for (let i = 0; i < 8; i += 1) await Promise.resolve() },
      dispose() { disposeRoot(); Reflect.deleteProperty(globalThis, "__sideQuestionClient") },
    }
  })
}
