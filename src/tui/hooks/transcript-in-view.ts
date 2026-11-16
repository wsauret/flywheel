import { createSignal, onCleanup, type Accessor } from "solid-js"
import type { AgentViewKind } from "../../protocol/client/slash-route.js"

/** A chat that a view over the foreground chat shows exactly as its tab does.
 *  Each command that acts on a chat acts on it there, as it would in its tab. */
export interface ChatInView {
  readonly sessionId: Accessor<string | undefined>
  readonly openBackground: () => void
  readonly resume: () => void
  readonly openChanges: () => void
  /** Closes the chat as Close chat does, and leaves the view. */
  readonly closeChat: () => void
}

/** One transcript the terminal shows over the foreground chat: an agent's,
 *  or another chat's. */
type ShownTranscript = {
  /** True while this view is the one in front of the viewer stack. */
  readonly active: Accessor<boolean>
  /** Opens the model and effort of the shown session's own serving seat. */
  readonly openModel: () => void
} & ({ readonly kind: Exclude<AgentViewKind, "chat"> } | { readonly kind: "chat"; readonly chat: ChatInView })

/** Which transcript the person sees: the active view over the foreground
 *  chat, or that chat itself. A command whose target is the transcript in
 *  view reaches the session the person sees, never the foreground chat
 *  (PI-INTERACTION-019). */
export interface TranscriptInView {
  /** Registers a view for the life of the calling reactive owner. */
  show(view: ShownTranscript): void
  /** Opens the model and effort of the transcript in view. */
  openModel(): void
  /** The kind of agent session in view over the foreground chat, or
   *  undefined while a chat is in view, the foreground chat or another. */
  agentInView(): Exclude<AgentViewKind, "chat"> | undefined
  /** The chat that a view over the foreground chat shows, or undefined while
   *  the foreground chat or an agent is in view. */
  chatInView(): ChatInView | undefined
}

export function createTranscriptInView(openChatModel: () => void): TranscriptInView {
  // A signal, so a reader that ran before a view registered reads again once it does.
  const [shown, setShown] = createSignal<readonly ShownTranscript[]>([])
  const inView = (): ShownTranscript | undefined => shown().find((view) => view.active())
  return {
    show(view) {
      setShown((views) => [...views, view])
      onCleanup(() => { setShown((views) => views.filter((candidate) => candidate !== view)) })
    },
    openModel() {
      const view = inView()
      if (view) view.openModel()
      else openChatModel()
    },
    agentInView: () => { const view = inView(); return view?.kind === "chat" ? undefined : view?.kind },
    chatInView: () => { const view = inView(); return view?.kind === "chat" ? view.chat : undefined },
  }
}
