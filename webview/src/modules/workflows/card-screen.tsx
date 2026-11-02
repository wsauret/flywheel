import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type Accessor } from "solid-js"

import type { LoadedWorkflowView } from "../../../../src/protocol/workflow-view-protocol-types.js"
import { formatElapsed } from "../../../../src/protocol/client/format.js"
import { activeTimeMs } from "../../../../src/protocol/client/session-time.js"
import { workflowCardControls, workflowParked, workflowResumeTitle, workflowStateLabel } from "../../../../src/protocol/client/session-controls.js"
import { workflowCard, workflowCardChoice, workflowCardNotice, workflowCardSettled, workflowRunName, workflowViewCardStatus, type WorkflowCardChoices } from "../../../../src/protocol/client/workflow-card.js"
import { workflowOutline } from "../../../../src/protocol/client/workflow-outline.js"
import { workflowAgentOpenTarget } from "../../../../src/protocol/client/workflow-agent.js"
import { actionKey, controlActionKey } from "../../client/action-key.js"
import type { WorkflowAgentViewTarget } from "./navigation.js"
import { WORKFLOW_CONTROLS, WorkflowCard } from "./card.js"
import { useWorkflows } from "./context.js"
import type { WorkflowReading } from "./inspection.js"

/** A workflow's full-size card: its whole plan, in place of a transcript,
 *  in the pane of the selected workflow. The toolbar names it and its way
 *  back to the chat. The header line names the workflow's state and time,
 *  and the controls its row admits: Interrupt, Resume, or Restart,
 *  then Stop. Every phase follows in run order, with every agent of an
 *  expanded phase in item order, and the plan bar stays at the foot of the
 *  scroller. The card is one tree that the keys move through; a selection
 *  of an agent opens its agent view. */
export function WorkflowCardScreen(props: {
  /** The workflow's view, or undefined when its plan is unavailable, such
   *  as saved progress that cannot be read. The header, its controls, and
   *  the notice still show, so Restart stays in reach. */
  readonly view: Accessor<LoadedWorkflowView | undefined>
  /** Opens an agent's view, or the follow-up conversation's, over the card. */
  readonly onOpen: (target: WorkflowAgentViewTarget) => void
  readonly workflowId: string
  readonly reading: Accessor<WorkflowReading>
  readonly onBack: () => void
}) {
  const client = useWorkflows()
  const sessionId = () => props.workflowId
  const row = () => props.reading().detail
  const live = () => props.reading().live
  const parked = () => workflowParked(live(), row())
  const status = createMemo(() => workflowViewCardStatus(props.view()?.state, row(), parked()))
  const stateWord = () => workflowStateLabel(props.view()?.state, row()?.stoppedBy, row()?.definitionDrift, parked())
  const outline = createMemo(() => { const view = props.view(); return view === undefined ? undefined : workflowOutline(view, stateWord(), live(), row() ?? undefined) })
  const [choices, setChoices] = createSignal<WorkflowCardChoices>()
  const card = createMemo(() => {
    const folded = outline()
    const chosen = choices()
    return folded === undefined ? undefined : workflowCard(folded, { settled: workflowCardSettled(status()), size: "full", ...(chosen === undefined ? {} : { choices: chosen }) })
  })
  const sessions = createMemo(() => new Map(outline()?.phases.flatMap(phase =>
    phase.agents.flatMap(agent => agent.sessionId === undefined ? [] : [[agent.agentNodeId, agent.sessionId] as const]))))
  const roles = untrack(() => ({ get: client.host.state().roleAssignments, subscribe: client.host.state().subscribeRoleAssignments }))

  // The selected line. With none chosen yet, the phase that runs, else the
  // first phase.
  const [chosenKey, setChosenKey] = createSignal<string>()
  const selected = () => chosenKey() ?? (() => {
    const phases = outline()?.phases ?? []
    const running = phases.find(({ state: phase }) => phase === "running" || phase === "parked") ?? phases[0]
    return running === undefined ? undefined : `phase:${running.key}`
  })()

  // The time ticks while the run goes on.
  const [now, setNow] = createSignal(Date.now())
  createEffect(() => {
    if (status() !== "active") return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })
  const stats = createMemo(() => {
    // The time the workflow worked, as its inline card and the terminal
    // count it: an interrupt adds none.
    const detail = row()
    const elapsed = detail ? activeTimeMs(detail.durationMs, detail.streamingStartedAt, now()) : 0
    const word = stateWord() ?? ""
    return [word === "" ? "" : `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`, elapsed >= 1000 ? formatElapsed(elapsed) : ""].filter(Boolean)
  })
  const controls = () => workflowCardControls(row(), false, parked())

  return (
    <div class="workflow-card-screen">
      <div class="workflow-card-screen-head">
        <button class="workflow-agent-back" onClick={props.onBack}>Back to chat</button>
        <strong>{row() === undefined && props.view() === undefined ? "Loading workflow…" : workflowRunName(props.view(), row()?.title)}</strong>
        <Show when={row()?.auth}>{auth => <label class="workflow-profile">Profile
          <select aria-label="Workflow auth profile" value={auth().profile.id} onChange={event => {
            const profileId = event.currentTarget.value
            void client.host.actions.run(`workflow-profile:${props.workflowId}`, async () => {
              const result = await client.host.connection.dispatch({ type: "workflow.profile.select", workflowId: props.workflowId, profileId })
              if (!result.ok) throw new Error(result.error)
            })
          }}><For each={auth().profile.availableProfiles}>{profile => <option value={profile.id}>{profile.displayName}</option>}</For></select>
        </label>}</Show>
        <span class="workflow-card-screen-stats">{stats().join(" · ")}</span>
        <Show when={controls().primary}>
          {(control) => (
            <button type="button" class="workflow-action" aria-label={WORKFLOW_CONTROLS[control()].word} title={control() === "resume" ? workflowResumeTitle(props.view()?.state) : WORKFLOW_CONTROLS[control()].title}
              aria-busy={client.host.actions.working(controlActionKey(control(), sessionId())) || undefined}
              onClick={() => client.control(sessionId(), control())}
            ><span aria-hidden="true">{WORKFLOW_CONTROLS[control()].icon}</span><span class="control-word">{WORKFLOW_CONTROLS[control()].word}</span></button>
          )}
        </Show>
        <Show when={controls().stop}>
          <button type="button" class="workflow-action" aria-label="Stop" title="Stop this workflow. Its run ends for the chat that started it and cannot resume."
            aria-busy={client.host.actions.working(actionKey("stop", sessionId())) || undefined}
            onClick={() => client.control(sessionId(), "stop")}
          ><span aria-hidden="true">{"■"}</span><span class="control-word">Stop</span></button>
        </Show>
      </div>
      <div class="workflow-card-screen-scroll">
        <Show when={card() !== undefined && outline() !== undefined ? { card: card()!, outline: outline()! } : undefined} fallback={
          <>
            <Show when={workflowCardNotice(row(), { status: status() }, undefined)}>{(notice) => <div class="workflow-card-notice" role="status">{notice()}</div>}</Show>
            <p class="workflow-agent-empty workflow-card-screen-unavailable">This workflow's plan is unavailable.</p>
          </>
        }>{(shown) => <WorkflowCard
          card={shown().card}
          status={status()}
          live={live()}
          choices={choices()}
          notice={workflowCardNotice(row(), { status: status() }, shown().card)}
          now={now}
          sessions={sessions()}
          roles={roles}
          full={{
            outline: shown().outline,
            followUp: props.view()?.followUp === true,
            selected,
            onSelect: setChosenKey,
          }}
          onAction={(action) => {
            switch (action.kind) {
              case "agent": props.onOpen({ kind: "agent", ...workflowAgentOpenTarget(action) }); return
              case "followUp": props.onOpen({ kind: "followUp" }); return
              case "phase":
              case "counted": setChoices(workflowCardChoice(choices(), action, shown().card, status()))
            }
          }}
        />}</Show>
      </div>
    </div>
  )
}

