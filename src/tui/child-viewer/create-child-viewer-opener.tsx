/** @jsxImportSource @opentui/solid */
import { createSignal } from "solid-js"
import { ChildSessionViewer, createChildSessionViewerInput, type ChildSessionViewerProps } from "./child-session-viewer.js"
import type { ViewerContext, ViewerHandle } from "../components/modal-stack.js"
import type { SessionSurface } from "../hooks/state/sessions/create-session-surface.js"
import type { RuntimeClient, SessionRow } from "../../protocol/app-service-types.js"
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
  readonly openModuleSession: (session: Pick<SessionRow, "id" | "kind">) => Promise<boolean>
  readonly client: Pick<RuntimeClient, "query">
  /** Routes slash text typed in a child view, as the chat composer does. */
  readonly dispatchCommand: (text: string) => Promise<boolean>
  readonly viewer: (sessionId: string) => Omit<ChildSessionViewerProps, "sessionId" | "input" | "onClose" | "showToast" | "active" | "focused">
}

interface ViewerLinkDeps {
  /** The surface the viewer shows, once it exists. */
  readonly surface: () => SessionSurface | undefined
  readonly client: Pick<RuntimeClient, "query">
  readonly openChild: ChildPlaces["openChild"]
  readonly navigateUri: (uri: string) => void
  readonly showToast: ChildSessionViewerProps["showToast"]
}

/** The link rule of a session viewer: a link to a child of the session it
 *  shows opens that child over the viewer, so the viewer below keeps its
 *  state. Any other link, and a listed child that no longer exists, navigates
 *  as the shell does, so the shell reports a missing session. */
export function viewerLinkNavigator(deps: ViewerLinkDeps): (uri: string) => void {
  return (uri) => {
    const child = parseSessionLink(uri)
    if (!child || !deps.surface()?.summary()?.childSessionIds?.includes(child.sessionId)) { deps.navigateUri(uri); return }
    void deps.client.query({ type: "sessionDetail", sessionId: child.sessionId }).then(({ view }) => { if (view) deps.openChild(view.row); else deps.navigateUri(uri) }, (cause: unknown) => {
      deps.showToast({ message: `Open failed for ${child.sessionId}: ${errorMessage(cause)}`, variant: "error" })
    })
  }
}

/** Ordinary child viewers retain the stack below them. Modules own their own inspection chrome. */
export function createChildViewerOpener(deps: ChildViewerOpenerDeps): ChildPlaces {
  const places: ChildPlaces = { openChild(child) {
    // A module's open reads the runtime, and a read can fail while it is busy.
    void deps.openModuleSession(child).then((opened) => { if (!opened) openChild(child.id) }, (cause: unknown) => {
      deps.showToast({ message: `Open failed for ${child.id}: ${errorMessage(cause)}`, variant: "error" })
    })
  } }
  function openChild(sessionId: string): void {
    let surface: SessionSurface | undefined
    const [handle, setHandle] = createSignal<ViewerHandle>()
    const close = () => { handle()?.close() }
    const input = createChildSessionViewerInput({ onClose: close, dispatchCommand: deps.dispatchCommand })
    const navigate = viewerLinkNavigator({ surface: () => surface, client: deps.client, openChild: places.openChild, navigateUri: deps.navigateUri, showToast: deps.showToast })
    const opened = deps.viewerLayer.push(() => {
      const viewer = deps.viewer(sessionId)
      return <NavigationProvider value={navigate}><ChildSessionViewer {...viewer}
        returnDraft={deps.returnDraft}
        createSurface={(id) => (surface = viewer.createSurface(id))} sessionId={sessionId} input={input}
        active={() => handle()?.isActive() ?? false} focused={() => handle()?.isFocused() ?? false} onClose={close} showToast={deps.showToast} /></NavigationProvider>
    }, { onKey: input.onKey, onPaste: input.onPaste, route: { kind: "child", sessionId } })
    setHandle(opened)
  }
  return places
}
