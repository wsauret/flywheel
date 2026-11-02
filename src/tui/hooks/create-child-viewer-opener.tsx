/** @jsxImportSource @opentui/solid */
import { createSignal, type JSX } from "solid-js"
import { ChildSessionViewer, createChildSessionViewerInput, type ChildSessionViewerProps } from "../components/child-session-viewer.js"
import type { ViewerContext, ViewerHandle } from "../components/modal-stack.js"
import type { SessionSurface } from "./create-session-surface.js"
import type { SessionRow } from "../../protocol/app-service-types.js"
import { NavigationProvider } from "../context/navigation.js"
import { parseSessionLink } from "../../protocol/client/session-links.js"
import { errorMessage } from "../../infra/error-message.js"

export interface ChildPlaces {
  openChild(child: Pick<SessionRow, "id" | "kind">): void
}
interface ChildViewerOpenerDeps {
  readonly returnDraft?: ChildSessionViewerProps["returnDraft"]
  readonly viewerLayer: ViewerContext
  readonly showToast: ChildSessionViewerProps["showToast"]
  readonly navigateUri: (uri: string) => void
  readonly provide: (children: () => JSX.Element) => JSX.Element
  readonly openModuleSession: (session: Pick<SessionRow, "id" | "kind">) => boolean | Promise<boolean>
  readonly kindOf: (sessionId: string) => SessionRow["kind"] | undefined
  /** Routes slash text typed in a child view, as the chat composer does. */
  readonly dispatchCommand: (text: string) => Promise<boolean>
  readonly viewer: (sessionId: string) => Omit<ChildSessionViewerProps, "sessionId" | "input" | "onClose" | "showToast" | "active" | "focused">
}

/** Ordinary child viewers retain the stack below them. Modules own their own inspection chrome. */
export function createChildViewerOpener(deps: ChildViewerOpenerDeps): ChildPlaces {
  const places: ChildPlaces = { openChild(child) {
    const result = deps.openModuleSession(child)
    if (typeof result === "boolean") { if (!result) openChild(child.id) }
    // A module's open reads the runtime, and a read can fail while it is busy.
    else void result.then((opened) => { if (!opened) openChild(child.id) }, (cause: unknown) => {
      deps.showToast({ message: `Open failed for ${child.id}: ${errorMessage(cause)}`, variant: "error" })
    })
  } }
  function openChild(sessionId: string): void {
    let surface: SessionSurface | undefined
    const [handle, setHandle] = createSignal<ViewerHandle>()
    const close = () => { handle()?.close() }
    const input = createChildSessionViewerInput({ onClose: close, dispatchCommand: deps.dispatchCommand })
    const navigate = (uri: string) => {
      const target = parseSessionLink(uri)
      const kind = target && deps.kindOf(target.sessionId)
      if (target && kind && surface?.summary()?.childSessionIds?.includes(target.sessionId)) places.openChild({ id: target.sessionId, kind })
      else deps.navigateUri(uri)
    }
    const opened = deps.viewerLayer.push(() => {
      const viewer = deps.viewer(sessionId)
      return deps.provide(() => <NavigationProvider value={navigate}><ChildSessionViewer {...viewer}
        returnDraft={deps.returnDraft}
        createSurface={(id) => (surface = viewer.createSurface(id))} sessionId={sessionId} input={input}
        active={() => handle()?.isActive() ?? false} focused={() => handle()?.isFocused() ?? false} onClose={close} showToast={deps.showToast} /></NavigationProvider>)
    }, { onKey: input.onKey, onPaste: input.onPaste, route: { kind: "child", sessionId } })
    setHandle(opened)
  }
  return places
}
