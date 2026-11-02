import { batch, createEffect, createMemo, createSignal, on, onCleanup, untrack, type Accessor } from "solid-js"
import { workflowAgentModel, workflowAgentMove, type WorkflowAgentTarget } from "../../../../src/protocol/client/workflow-agent.js"
import { workflowParked, workflowStateLabel } from "../../../../src/protocol/client/session-controls.js"
import { SESSION_KEY, sessionOf } from "../../app/screen-stack.js"
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
const KEY = "flywheelPlace"

/** Adopts a directly selected workflow member into its launching chat's history.
 * The effect lasts for its Solid owner and waits for the member's inspection. */
export function createWorkflowAgentAdoption(
  navigation: ReturnType<typeof createWorkflowNavigation>,
  selected: Accessor<Pick<SessionSummary, "id" | "workflowMembership"> | undefined>,
  reading: Accessor<WorkflowReading>,
) {
  createEffect(() => {
    if (navigation.place()) return
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
  if (!(state instanceof Object) || !(KEY in state)) return undefined
  const value = state[KEY]
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
  return { ...(state instanceof Object ? state : {}), [KEY]: place, [SESSION_KEY]: shown }
}
export function workflowCut(reading: WorkflowReading) {
  const detail = reading.detail
  const parked = workflowParked(reading.live, detail)
  return workflowStateLabel(reading.view?.attemptsStatus === "loaded" ? reading.view.state : undefined, detail?.stoppedBy, detail?.definitionDrift, parked)
}

/** History records workflow places, but only actual conversation sessions are selected. */
export function createWorkflowNavigation(options: {
  readonly reading: Accessor<WorkflowReading>
  readonly selected: Accessor<string | undefined>
  readonly select: (id: string) => void
}, port: HistoryPort = browserHistory()) {
  const [place, setPlace] = createSignal(placeOf(port.state))
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
  const selectPlace = (current: WorkflowPlace | undefined) => {
    const target = current?.kind === "card" ? current.chatSessionId : sessionId()
    if (target !== undefined && target !== untrack(options.selected)) options.select(target)
  }
  const onPop = (event: { readonly state: unknown }) => {
    const previous = untrack(place)
    const next = placeOf(event.state)
    batch(() => {
      setPlace(next)
      if (next) selectPlace(next)
      else if (previous) options.select(sessionOf(event.state) ?? previous.chatSessionId)
    })
  }
  port.addPopStateListener(onPop)
  onCleanup(() => port.removePopStateListener(onPop))
  // An agent whose session was unknown when its entry was written names it
  // once its workflow's view arrives, before the selection moves to it.
  createEffect(on(sessionId, id => {
    if (id === undefined) return
    if (sessionOf(port.state) !== id) port.replaceState(entry(port.state, untrack(place), id))
    if (id !== untrack(options.selected)) options.select(id)
  }))
  // The entry is written before the selection moves, so a host that follows
  // the selection finds the entry that already names the new session.
  const write = (next: WorkflowPlace, replace: boolean) => {
    const state = entry(port.state, next, untrack(() => shownSession(next, modelOf)))
    if (replace) port.replaceState(state)
    else port.pushState(state)
    setPlace(next)
    selectPlace(next)
  }
  createEffect(on(model, shown => {
    const current = untrack(place)
    if (shown && current?.kind === "agent" && current.target.kind === "agent" && current.target.follow && !current.target.historySessionId && shown.agentNodeId !== current.target.agentNodeId) {
      write({ ...current, target: { kind: "agent", agentNodeId: shown.agentNodeId, follow: true } }, true)
    }
  }))
  return {
    place, model, sessionId,
    openCard(workflowId: string, chatSessionId: string) { write({ kind: "card", workflowId, chatSessionId }, false) },
    openAgent(workflowId: string, chatSessionId: string, target: WorkflowAgentViewTarget, origin: "chat" | "card") {
      write({ kind: "agent", workflowId, chatSessionId, target, origin }, place()?.kind === "agent")
    },
    /** Takes an agent session that was selected without a place, as a
     *  direct open or a link does, as an agent view opened from its chat:
     *  the current entry becomes the chat's and the agent's goes over it,
     *  so Back returns to the chat that launched the workflow. */
    adoptAgent(workflowId: string, chatSessionId: string, target: WorkflowAgentViewTarget) {
      port.replaceState(entry(port.state, undefined, chatSessionId))
      write({ kind: "agent", workflowId, chatSessionId, target, origin: "chat" }, false)
    },
    move(direction: 1 | -1) {
      const current = place()
      const reading = options.reading()
      if (current?.kind !== "agent" || reading.view?.attemptsStatus !== "loaded") return false
      const next = workflowAgentMove(reading.view, model(), direction, workflowCut(reading), reading.live)
      if (!next) return false
      write({ ...current, target: { kind: "agent", ...next } }, true)
      return true
    },
    history(session: string | undefined) {
      const current = place()
      if (current?.kind !== "agent" || current.target.kind !== "agent") return
      write({ ...current, target: { ...current.target, follow: false, historySessionId: session } }, true)
    },
    back() {
      if (!place()) return false
      port.back()
      return true
    },
    /** Leaves a card over `chatSessionId` for the chat itself, in a new
     *  entry, so Back returns to the card. */
    reveal(chatSessionId: string) {
      const current = place()
      if (current?.kind !== "card" || current.chatSessionId !== chatSessionId) return
      port.pushState(entry(port.state, undefined, chatSessionId))
      setPlace(undefined)
    },
  }
}
