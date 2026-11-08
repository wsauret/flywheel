import { batch, createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import { workflowAgentModel, workflowAgentMove, type WorkflowAgentTarget } from "../../../../src/protocol/client/workflow-agent.js"
import { workflowParked, workflowStateLabel } from "../../../../src/protocol/client/session-controls.js"
import { LEVEL_KEY, SESSION_KEY, sessionOf } from "../../app/screen-stack.js"
import type { WorkflowReading } from "./inspection.js"
import type { SessionSummary } from "../../client/view-state.js"

export type WorkflowAgentViewTarget =
  | ({ readonly kind: "agent"; readonly historySessionId?: string } & WorkflowAgentTarget)
  | { readonly kind: "followUp" }

export type WorkflowPlace =
  | { readonly kind: "card"; readonly workflowId: string; readonly chatSessionId: string }
  | { readonly kind: "agent"; readonly workflowId: string; readonly chatSessionId: string; readonly origin: "chat" | "card"; readonly target: WorkflowAgentViewTarget }

export interface HistoryPort {
  readonly state: unknown
  pushState(state: unknown): void
  replaceState(state: unknown): void
  back(): void
  addPopStateListener(listener: (event: { readonly state: unknown }) => void): void
  removePopStateListener(listener: (event: { readonly state: unknown }) => void): void
}

/** Adopts a directly selected workflow member into its launching chat's history.
 * The effect lasts for its Solid owner and waits for the member's inspection.
 * It tracks only its causes, the selected row and the reading; the
 * navigation decides whether the person is at a place already. */
export function createWorkflowAgentAdoption(
  navigation: ReturnType<typeof createWorkflowNavigation>,
  selected: Accessor<Pick<SessionSummary, "id" | "workflowMembership"> | undefined>,
  reading: Accessor<WorkflowReading>,
) {
  createEffect(() => {
    const row = selected()
    const member = row?.workflowMembership
    const current = reading()
    if (!member || !current.detail || current.view?.attemptsStatus !== "loaded" || row?.id === undefined) return
    if (member.kind === "historical-follow-up") {
      navigation.adoptAgent(member.workflowId, current.detail.launchedFrom.parentSessionId, { kind: "followUp" })
      return
    }
    const attempt = current.view.attempts.find(candidate => candidate.id === member.attemptId)
    const nodeId = attempt?.agentNodeId ?? current.view.tree.nodes.find(node => node.kind === "agent" && node.currentAttemptId === member.attemptId)?.id
    if (!nodeId) return
    navigation.adoptAgent(member.workflowId, current.detail.launchedFrom.parentSessionId, {
      kind: "agent", agentNodeId: nodeId, follow: false, historySessionId: row.id,
    })
  })
}
function placeOf(state: unknown): WorkflowPlace | undefined {
  if (!(state instanceof Object) || !(LEVEL_KEY in state)) return undefined
  const value = state[LEVEL_KEY]
  if (!(value instanceof Object) || !("workflowId" in value) || typeof value.workflowId !== "string" || !("chatSessionId" in value) || typeof value.chatSessionId !== "string" || !("kind" in value)) return undefined
  if (value.kind === "card") return { kind: "card", workflowId: value.workflowId, chatSessionId: value.chatSessionId }
  if (value.kind !== "agent" || !("target" in value) || !(value.target instanceof Object)) return undefined
  const target = value.target
  const origin = "origin" in value && value.origin === "chat" ? "chat" : "card"
  if ("kind" in target && target.kind === "followUp") return { kind: "agent", workflowId: value.workflowId, chatSessionId: value.chatSessionId, origin, target: { kind: "followUp" } }
  if (!("agentNodeId" in target) || typeof target.agentNodeId !== "string") return undefined
  return { kind: "agent", workflowId: value.workflowId, chatSessionId: value.chatSessionId, origin, target: {
    kind: "agent", agentNodeId: target.agentNodeId, follow: "follow" in target && target.follow === true,
    ...("historySessionId" in target && typeof target.historySessionId === "string" ? { historySessionId: target.historySessionId } : {}),
  } }
}
const browserHistory = (): HistoryPort => ({
  get state() { return history.state },
  pushState: value => history.pushState(value, ""), replaceState: value => history.replaceState(value, ""), back: () => history.back(),
  addPopStateListener: listener => window.addEventListener("popstate", listener),
  removePopStateListener: listener => window.removeEventListener("popstate", listener),
})
/** The entry for `place`, which names the session it shows when that is
 *  known, so the page address can follow it into this entry. */
function entry(state: unknown, place: WorkflowPlace | undefined, shown: string | undefined) {
  return { ...(state instanceof Object ? state : {}), [LEVEL_KEY]: place, [SESSION_KEY]: shown }
}
export function workflowCut(reading: WorkflowReading) {
  const detail = reading.detail
  const parked = workflowParked(reading.live, detail)
  return workflowStateLabel(reading.view?.attemptsStatus === "loaded" ? reading.view.state : undefined, detail, parked)
}

/** Where the person is in a workflow's views: the place of the history entry
 *  they are at, and the session that entry names. That is the session the
 *  pane shows: the place's own session, or, while an agent's session is not
 *  known yet, the session under its loading cover. */
interface Here { readonly place: WorkflowPlace; readonly named: string | undefined }

/** Every way the place changes. One transition function decides each. */
type NavigationEvent =
  | { readonly kind: "open"; readonly place: WorkflowPlace; readonly history: "push" | "replace" }
  | { readonly kind: "adopt"; readonly place: WorkflowPlace }
  | { readonly kind: "pop"; readonly state: unknown }
  | { readonly kind: "reveal"; readonly chatSessionId: string }
  | { readonly kind: "selected"; readonly sessionId: string | undefined }
  | { readonly kind: "read" }

/** History records workflow places, but only actual conversation sessions are selected. */
export function createWorkflowNavigation(options: {
  readonly reading: Accessor<WorkflowReading>
  readonly selected: Accessor<string | undefined>
  readonly select: (id: string) => void
}, port: HistoryPort = browserHistory()) {
  const atEntry = (state: unknown): Here | undefined => { const place = placeOf(state); return place && { place, named: sessionOf(state) } }
  const [here, setHere] = createSignal(atEntry(port.state))
  const place = createMemo(() => here()?.place)
  const modelOf = (target: WorkflowAgentTarget) => {
    const reading = options.reading()
    return reading.view?.attemptsStatus === "loaded" ? workflowAgentModel(reading.view, target, workflowCut(reading), reading.live) : undefined
  }
  const model = createMemo(() => { const current = place(); return current?.kind === "agent" && current.target.kind === "agent" ? modelOf(current.target) : undefined })
  /** The session that `current` shows; `agent` resolves its agent's model. */
  function shownSession(current: WorkflowPlace, agent: (target: WorkflowAgentTarget) => { readonly sessionId?: string } | undefined): string | undefined {
    if (current.kind === "card") return current.chatSessionId
    const view = options.reading().view
    if (current.target.kind === "followUp") return view?.attemptsStatus === "loaded" ? view.followUpSessionId : undefined
    return current.target.historySessionId ?? agent(current.target)?.sessionId
  }
  const sessionId = createMemo(() => { const current = place(); return current?.kind === "agent" ? shownSession(current, model) : undefined })
  const modelAt = (next: WorkflowPlace) => next.kind === "agent" && next.target.kind === "agent" ? modelOf(next.target) : undefined
  /** A following agent whose item moved on is at the item's current agent,
   *  which `shown`, the model of its target, names. */
  function followed(next: WorkflowPlace, shown: { readonly agentNodeId: string } | undefined): WorkflowPlace {
    if (!shown || next.kind !== "agent" || next.target.kind !== "agent" || !next.target.follow || next.target.historySessionId || shown.agentNodeId === next.target.agentNodeId) return next
    return { ...next, target: { kind: "agent", agentNodeId: shown.agentNodeId, follow: true } }
  }
  /** Moves to `next` in the one order every transition keeps: the entry,
   *  then the place, then the selection, so a host that follows the
   *  selection finds the entry that already names the new session. */
  function commit(next: WorkflowPlace | undefined, named: string | undefined, write?: "push" | "replace") {
    if (write === "push") port.pushState(entry(port.state, next, named))
    else if (write === "replace") port.replaceState(entry(port.state, next, named))
    setHere(next && { place: next, named })
    if (next && named !== undefined && named !== options.selected()) options.select(named)
  }
  function open(requested: WorkflowPlace, write: "push" | "replace") {
    const next = followed(requested, modelAt(requested))
    commit(next, shownSession(next, modelOf) ?? options.selected(), write)
  }
  function step(event: NavigationEvent): void {
    const at = here()
    switch (event.kind) {
      case "open": open(event.place, event.history); return
      case "adopt": {
        const selected = options.selected()
        // The person is at a place already, or a pop is about to restore the
        // place that the current entry records: the local page's own pop
        // listener selects the popped entry's session before this one runs.
        if ((at !== undefined && at.named === selected) || (placeOf(port.state) && sessionOf(port.state) === selected)) return
        // The current entry becomes the chat's and the agent's goes over it,
        // so Back returns to the chat that launched the workflow.
        port.replaceState(entry(port.state, undefined, event.place.chatSessionId))
        open(event.place, "push")
        return
      }
      case "pop": {
        const requested = placeOf(event.state)
        if (!requested) {
          setHere(undefined)
          const target = at && (sessionOf(event.state) ?? at.place.chatSessionId)
          if (target !== undefined && target !== options.selected()) options.select(target)
          return
        }
        // A following agent whose item moved on shows its successor, and its
        // entry names the successor before the selection moves.
        const next = followed(requested, modelAt(requested))
        const named = shownSession(next, modelOf) ?? sessionOf(event.state) ?? options.selected()
        commit(next, named, next !== requested || named !== sessionOf(event.state) ? "replace" : undefined)
        return
      }
      case "reveal":
        if (at?.place.kind === "card" && at.place.chatSessionId === event.chatSessionId) commit(undefined, event.chatSessionId, "push")
        return
      // A place lasts while the selection is the session its entry names. A
      // selection that moves anywhere else, such as a sidebar click or New
      // Chat, leaves it, so nothing the place follows can move the selection
      // or rewrite the entry of the session the person went to.
      case "selected":
        if (at && event.sessionId !== at.named) setHere(undefined)
        return
      // The view moved: a following agent's item reached its next agent, or
      // an agent's session became known.
      case "read": {
        if (!at) return
        const next = followed(at.place, model())
        const shown = next === at.place ? sessionId() : shownSession(next, modelOf)
        if (next !== at.place || (shown !== undefined && shown !== at.named)) commit(next, shown ?? at.named, "replace")
        return
      }
    }
  }
  // Effects run after the transition, so each one reads the place it left.
  const transition = (event: NavigationEvent) => batch(() => untrack(() => step(event)))
  const onPop = (event: { readonly state: unknown }) => transition({ kind: "pop", state: event.state })
  port.addPopStateListener(onPop)
  onCleanup(() => port.removePopStateListener(onPop))
  createEffect(on(options.reading, () => transition({ kind: "read" })))
  createEffect(on(options.selected, id => transition({ kind: "selected", sessionId: id }), { defer: true }))
  return {
    place, model, sessionId,
    openCard(workflowId: string, chatSessionId: string) { transition({ kind: "open", place: { kind: "card", workflowId, chatSessionId }, history: "push" }) },
    openAgent(workflowId: string, chatSessionId: string, target: WorkflowAgentViewTarget, origin: "chat" | "card") {
      transition({ kind: "open", place: { kind: "agent", workflowId, chatSessionId, target, origin }, history: place()?.kind === "agent" ? "replace" : "push" })
    },
    /** Takes an agent session that was selected without a place, as a
     *  direct open or a link does, as an agent view opened from its chat.
     *  Does nothing while the person is at a place. */
    adoptAgent(workflowId: string, chatSessionId: string, target: WorkflowAgentViewTarget) {
      transition({ kind: "adopt", place: { kind: "agent", workflowId, chatSessionId, target, origin: "chat" } })
    },
    move(direction: 1 | -1) {
      const current = place()
      const reading = options.reading()
      if (current?.kind !== "agent" || reading.view?.attemptsStatus !== "loaded") return false
      const next = workflowAgentMove(reading.view, model(), direction, workflowCut(reading), reading.live)
      if (!next) return false
      transition({ kind: "open", place: { ...current, target: { kind: "agent", ...next } }, history: "replace" })
      return true
    },
    history(session: string | undefined) {
      const current = place()
      if (current?.kind !== "agent" || current.target.kind !== "agent") return
      transition({ kind: "open", place: { ...current, target: { ...current.target, follow: false, historySessionId: session } }, history: "replace" })
    },
    back() {
      if (!place()) return false
      port.back()
      return true
    },
    /** Leaves a card over `chatSessionId` for the chat itself, in a new
     *  entry, so Back returns to the card. */
    reveal(chatSessionId: string) { transition({ kind: "reveal", chatSessionId }) },
  }
}
