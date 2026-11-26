import type { QuestionEntry } from "../../../infra/substrate/events/output-blocks.js";
import type { AgentInputAnswers } from "../../../protocol/session/question-protocol-types.js";
import type { AgentInputDecision } from "../agent-input/agent-input-facts.js";

/** Render one answer set as the model reads it, one line for each question
 *  the call asked. A question without an answer is one the person skipped. */
function formatAskUserAnswers(request: readonly QuestionEntry[], answers: AgentInputAnswers): string {
  const lines = request.map(({ question }) => `- ${question}: ${answers[question]?.text ?? "(cancelled by the user)"}`);
  return `User answered:\n${lines.join("\n")}`;
}

export type AnsweredAskUserResult =
  | { readonly content: string; readonly outcome: "ok" }
  | { readonly content: string; readonly outcome: "cancelled" };

/** The result of a launch approval that an earlier build asked for a workflow
 *  named by id. No answer grants a launch: the named workflow is retired.
 *  Remove after 2027-04-30. */
export function retiredWorkflowLaunchText(definitionId: string): string {
  return `The ${definitionId} workflow is retired. Flywheel no longer launches it.`;
}

/** Build the model-visible result from the durable answer authority. Only the
 *  decision's one exact approving choice returns a usable confirmation id. */
export function answeredAskUserResult(
  request: readonly QuestionEntry[],
  answers: AgentInputAnswers,
  decision: AgentInputDecision | undefined,
  confirmationId: string,
): AnsweredAskUserResult {
  const content = formatAskUserAnswers(request, answers);
  if (!decision) return { content, outcome: "ok" };
  if (decision.kind === "workflow_launch" && decision.source.kind === "registered") {
    return { content: `${content}\n\n${retiredWorkflowLaunchText(decision.source.definitionId)}`, outcome: "cancelled" };
  }
  const answer = answers[decision.question];
  const approved = answer?.kind === "choice"
    && answer.selections.length === 1
    && answer.selections[0]?.choiceId === decision.approve.choiceId;
  return approved
    ? { content: `${content}\n\nConfirmation id for this decision: ${confirmationId}`, outcome: "ok" }
    : { content: `${content}\n\nThe user did not approve this decision.`, outcome: "cancelled" };
}
