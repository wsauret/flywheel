import { onCleanup, type Accessor } from "solid-js"
import type { AgentViewKind } from "../../protocol/client/slash-route.js"

/** One agent transcript the terminal shows over the foreground chat. */
interface ShownTranscript {
  /** True while this view is the one in front of the viewer stack. */
  readonly active: Accessor<boolean>
  /** Opens the model and effort of the shown session's own serving seat. */
  readonly openModel: () => void
  /** The kind of agent the view shows. */
  readonly kind: AgentViewKind
}

/** Which transcript the person sees: the active agent view over the
 *  foreground chat, or that chat itself. A command whose target is the
 *  transcript in view reaches the agent the person sees, never its parent
 *  chat (PI-INTERACTION-019). */
export interface TranscriptInView {
  /** Registers an agent view for the life of the calling reactive owner. */
  show(view: ShownTranscript): void
  /** Opens the model and effort of the transcript in view. */
  openModel(): void
  /** The kind of agent in view, or undefined while the chat itself is. */
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
