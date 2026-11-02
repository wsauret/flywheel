import type { WorkflowTransitionResult } from "./commands.js"
import { WORKFLOW_CONTROL_FACT_TYPES, type WorkflowSessionFact } from "./session-facts.js"

const controlFactTypes: ReadonlySet<string> = new Set(WORKFLOW_CONTROL_FACT_TYPES)

/** Add projection companions before control semantics while preserving one terminal proposal boundary. */
export function composeWorkflowProposal(
  transition: WorkflowTransitionResult,
  companions: readonly WorkflowSessionFact[],
): WorkflowTransitionResult {
  if (transition.command.kind !== "commit") {
    if (companions.length > 0) throw new Error("Workflow proposal composition requires a commit transition")
    return transition
  }
  const pending = transition.state.context.pending
  if (!pending || pending.proposalId !== transition.command.proposal.proposalId) {
    throw new Error("Workflow proposal composition requires matching pending control")
  }
  if (companions.some(({ type }) => controlFactTypes.has(type))) {
    throw new Error("Workflow proposal composition rejected a control fact as a companion")
  }
  const terminal = transition.command.proposal.facts.at(-1)
  if (terminal?.type !== "workflow.control.committed" || terminal.payload.proposalId !== pending.proposalId) {
    throw new Error("Workflow proposal composition requires a terminal control commit fact")
  }
  const facts = [...companions, ...transition.command.proposal.facts]
  const proposedCommitted = {
    ...pending.proposedCommitted,
    aggregateSeq: pending.expectedSeq + facts.length,
  }
  return {
    state: {
      ...transition.state,
      context: {
        ...transition.state.context,
        pending: { ...pending, proposedCommitted, facts },
      },
    },
    command: {
      kind: "commit",
      proposal: { ...transition.command.proposal, facts },
    },
  }
}
