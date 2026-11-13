import { onCleanup, type Accessor } from "solid-js"
import type { AgentViewKind } from "../../protocol/client/slash-route.js"

/** One transcript the terminal shows over the foreground chat: an agent's,
 *  or another chat's. */
interface ShownTranscript {
  /** True while this view is the one in front of the viewer stack. */
  readonly active: Accessor<boolean>
  /** Opens the model and effort of the shown session's own serving seat. */
  readonly openModel: () => void
  /** The kind of session the view shows. */
  readonly kind: AgentViewKind
}

/** Which transcript the person sees: the active view over the foreground
 *  chat, or that chat itself. A command whose target is the transcript in
 *  view reaches the session the person sees, never the foreground chat
 *  (PI-INTERACTION-019). */
export interface TranscriptInView {
  /** Registers a view for the life of the calling reactive owner. */
  show(view: ShownTranscript): void
  /** Opens the model and effort of the transcript in view. */
  openModel(): void
  /** The kind of session in view over the foreground chat, or undefined
   *  while that chat itself is. */
  agentInView(): AgentViewKind | undefined
}

export function createTranscriptInView(openChatModel: () => void): TranscriptInView {
  const shown: ShownTranscript[] = []
  return {
    show(view) {
      shown.push(view)
      onCleanup(() => { shown.splice(shown.indexOf(view), 1) })
    },
    openModel() {
      const agent = shown.find((view) => view.active())
      if (agent) agent.openModel()
      else openChatModel()
    },
    agentInView: () => shown.find((view) => view.active())?.kind,
  }
}
