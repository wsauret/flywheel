import { createComponent, createRoot, createSignal, Show, type JSX } from "solid-js"
import type { PromptRequest } from "./client-context.js"
import { fakeClient, fakeClientActions, fakeViewState } from "./client-context-fixture.js"
import { PromptDialog } from "./dialogs.js"
import { createElement, insert, nodes, textContent } from "./render-ownership-host-fixture.js"
import type { ModuleDomainViews } from "../client/module-domain-views.js"
import { fakeRuntimeConnection, type FakeConnectionScript } from "../client/runtime-connection-fixture.js"
import type { ClientViewState } from "../client/view-state.js"
import { CommandsSheet } from "./sheets/commands-sheet.js"
import { ProfilesSheet } from "./sheets/profiles-sheet.js"
import { SettingsSheet } from "./sheets/settings-sheet.js"
import { IntroCard } from "./intro-card.js"
import { NeedsProviderStage } from "./stages.js"

/** What a fixture publishes over the idle frame: the fields it names, and
 *  the module views it names over the idle ones. */
export type SemanticPublication = Omit<Partial<ClientViewState>, "modules"> & { readonly modules?: Partial<ModuleDomainViews> }

/** Mounts the real catalog and settings surfaces under immutable client publications. */
export function mountSemanticRows(kind: "commands" | "profiles" | "settings" | "intro" | "providers", initial: SemanticPublication, connection: FakeConnectionScript = {}) {
  return mountSemanticComponent({ commands: CommandsSheet, profiles: ProfilesSheet, settings: SettingsSheet, intro: IntroCard, providers: NeedsProviderStage }[kind], initial, connection)
}

/** Mounts a surface with client publications, actions, and the real prompt
 *  dialog. Every mutation is recorded in `calls` before `connection` answers it. */
export function mountSemanticComponent<P extends object>(Component: (props: { readonly sessionId: string } & P) => JSX.Element, initial: SemanticPublication, connection: FakeConnectionScript = {}, props?: P) {
  return createRoot((dispose) => {
    const root = createElement("root")
    const idle = fakeViewState()
    const frame = (publication: SemanticPublication): ClientViewState => ({ ...idle, ...publication, modules: { ...idle.modules, ...publication.modules } })
    const [state, setState] = createSignal(frame(initial))
    const calls: unknown[] = []
    const reports: { severity: "info" | "warning"; message: string }[] = []
    const prompts: unknown[] = []
    const confirmations: Array<(value: boolean) => void> = []
    const [prompt, setPrompt] = createSignal<{ request: PromptRequest; resolve: (value: string | undefined) => void }>()
    const client = fakeClient({
      state,
      report(severity, message) { reports.push({ severity, message }) },
      prompt(request) { prompts.push(request); return new Promise<string | undefined>(resolve => { setPrompt({ request, resolve }) }) },
      confirm() { return new Promise<boolean>(resolve => { confirmations.push(resolve) }) },
      openSheet(...args) { calls.push(args) },
      openSurface(id) { calls.push(id) },
      insertText(text) { calls.push(text) },
      connection: fakeRuntimeConnection({ ...connection, onDispatch: (mutation) => { calls.push(mutation) } }),
      actions: fakeClientActions({
        commandWorking: () => false,
        invokeCommand(id) { calls.push(id) },
        applySetting: async (action) => { calls.push(action); return { kind: "applied" } },
      }),
    })
    Reflect.set(globalThis, "__flywheelSemanticRowsClient", client)
    // Object.assign types an optional generic source as `{ sessionId } & P`; a spread of `P | undefined` loses P.
    const sessionProps = { sessionId: "chat" }
    insert(root, createComponent(Component, Object.assign(sessionProps, props)))
    insert(root, () => <Show when={prompt()}>{pending => <PromptDialog request={pending().request} onSettle={value => { pending().resolve(value); setPrompt(undefined) }} />}</Show>)
    return {
      dispose() { dispose(); Reflect.deleteProperty(globalThis, "__flywheelSemanticRowsClient") },
      publish: (next: SemanticPublication) => setState(() => frame(next)),
      calls: () => calls,
      reports: () => reports,
      prompts: () => prompts,
      settleConfirmation(value: boolean) {
        const resolve = confirmations.shift()
        if (!resolve) throw new Error("No confirmation is pending")
        resolve(value)
      },
      elements: () => nodes(root),
      text: () => textContent(root),
      button: (label: string) => nodes(root).find(node => node.tag === "button" && textContent(node).includes(label)),
    }
  })
}
