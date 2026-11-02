import { createContext, createSignal, useContext } from "solid-js"
import type { RuntimeClient } from "../../../protocol/app-service-types.js"
import type { WorkflowDetail } from "../../../protocol/modules/workflows.js"
import { dispatchInterrupt, resumeMutation, type ControlRefusal } from "../../../protocol/client/session-controls.js"
import { workflowAgentOpenTarget, type WorkflowAgentTarget } from "../../../protocol/client/workflow-agent.js"
import type { WorkflowAgentState } from "../../../infra/output-blocks.js"
import type { WorkflowCardChoices } from "../../../protocol/client/workflow-card.js"
import type { FrontendWorkflowView, WorkflowAgentLive, WorkflowLiveView } from "../../../protocol/workflow-view-protocol-types.js"
import type { WorkflowRoleReadings } from "./serving-labels.js"

/** What a workflow card in a transcript reads beyond its block: the
 *  workflow's view and live state, which it folds while its run goes on or
 *  once a person made a choice; the workflow's held detail, whose row
 *  admits its header's Interrupt, Resume, or Restart; the role readings of
 *  its agents' sessions, which name the model that serves each agent; the
 *  choices a person made on each card, which outlive the card's rows as the
 *  transcript scrolls; and the agent view that an agent line opens over the
 *  chat. A transcript without a provider draws each card from its block
 *  alone. */
export interface WorkflowCards extends WorkflowRoleReadings {
  /** Follows a workflow's view and live state from now on. */
  follow(sessionId: string): { release(): void }
  view(sessionId: string): FrontendWorkflowView | undefined
  live(sessionId: string): readonly WorkflowAgentLive[]
  /** Holds a workflow's detail while a card shows it, until the release. */
  hold(sessionId: string): { release(): void }
  row(workflowId: string): WorkflowDetail | undefined
  choices(cardId: string): WorkflowCardChoices | undefined
  choose(cardId: string, choices: WorkflowCardChoices): void
  interrupt(row: WorkflowDetail): void
  resume(row: WorkflowDetail): void
  restart(row: WorkflowDetail): void
  /** Opens an agent's view over the chat that shows the card: an agent
   *  that runs follows its item, and one that settled stays pinned. */
  openAgent(sessionId: string, agent: { readonly agentNodeId: string; readonly state: WorkflowAgentState }): void
}

const WorkflowCardsContext = createContext<WorkflowCards>()

export const WorkflowCardsProvider = WorkflowCardsContext.Provider

export function useWorkflowCards(): WorkflowCards | undefined {
  return useContext(WorkflowCardsContext)
}

/** The terminal's one source of workflow cards, over its caches. */
export function createWorkflowCards(deps: {
  readonly views: { view(sessionId: string): FrontendWorkflowView | undefined; retain(sessionId: string): { release(): void } }
  readonly live: { view(sessionId: string): WorkflowLiveView | undefined; retain(sessionId: string): { release(): void } }
  readonly details: { retain(workflowId: string): { release(): void }; view(workflowId: string): WorkflowDetail | undefined }
  readonly roles: WorkflowRoleReadings
  readonly client: Pick<RuntimeClient, "dispatch">
  readonly report: (refusal: ControlRefusal) => void
  readonly openAgent: (sessionId: string, target: WorkflowAgentTarget) => void
}): WorkflowCards {
  const [choices, setChoices] = createSignal<ReadonlyMap<string, WorkflowCardChoices>>(new Map())
  return {
    roleView: deps.roles.roleView,
    ensureRoleViews: deps.roles.ensureRoleViews,
    follow(sessionId) {
      const holds = [deps.views.retain(sessionId), deps.live.retain(sessionId)]
      return { release() { for (const hold of holds) hold.release() } }
    },
    view: (sessionId) => deps.views.view(sessionId),
    live: (sessionId) => deps.live.view(sessionId)?.agents ?? [],
    hold: (sessionId) => deps.details.retain(sessionId),
    row: (sessionId) => deps.details.view(sessionId),
    choices: (cardId) => choices().get(cardId),
    choose(cardId, next) {
      setChoices((current) => new Map([...current, [cardId, next]]))
    },
    interrupt(row) {
      void dispatchInterrupt(deps.client, row).then((refusal) => { if (refusal !== undefined) deps.report(refusal) })
    },
    resume(row) {
      void deps.client.dispatch(resumeMutation(row)).then((result) => { if (!result.ok) deps.report({ reason: result.error, variant: "error" }) })
    },
    restart(row) {
      void deps.client.dispatch({ type: "workflow.restart", workflowId: row.workflowId }).then((result) => { if (!result.ok) deps.report({ reason: result.error, variant: "error" }) })
    },
    openAgent: (sessionId, agent) => deps.openAgent(sessionId, workflowAgentOpenTarget(agent)),
  }
}
