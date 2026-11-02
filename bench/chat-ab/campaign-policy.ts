import type { FrontendMutation } from "../../src/protocol/app-service-types.js";
import { Schema } from "effect";
import { parseAgentInputFact, type AgentInputFact } from "../../src/orchestration/session/agent-input-facts.js";
import { formatQuestionChoiceAnswer } from "../../src/protocol/question-protocol-types.js";

const Row = Schema.Struct({
  source: Schema.String, sessionId: Schema.String, type: Schema.String,
  version: Schema.Int, actor: Schema.String, payload: Schema.Record(Schema.String, Schema.Unknown),
});
const Source = Schema.Struct({ source: Schema.String, sessionId: Schema.optionalKey(Schema.String) });

/** Record an answered question for deduplication. Only an approving answer increases the approval count. */
export function recordCampaignAnswer(
  capture: { readonly answered: Set<string>; approvals: number },
  answer: Extract<FrontendMutation, { type: "question.answer" }>,
  kind: "approve" | "revise-design",
) {
  capture.answered.add(answer.toolUseId);
  if (kind === "approve") capture.approvals++;
}

function pendingRootQuestion(jsonl: string, sessionId: string) {
  const pending = new Map<string, Extract<AgentInputFact, { type: "agent_input.requested" }>["payload"]>();
  try {
    for (const line of jsonl.split("\n").filter((value) => value.trim())) {
      const value: unknown = JSON.parse(line);
      const source = Schema.decodeUnknownSync(Source)(value);
      if (source.source !== "store" || source.sessionId !== sessionId) continue;
      const row = Schema.decodeUnknownSync(Row)(value);
      const fact = parseAgentInputFact({ type: row.type, version: row.version, actor: row.actor, payload: row.payload });
      if (fact.type === "agent_input.requested") pending.set(fact.payload.interactionId, fact.payload);
      else pending.delete(fact.payload.interactionId);
    }
  } catch {
    // Decode errors include subject content, retained only in the questions artifact.
    throw new Error("subject question evidence failed validation");
  }
  if (pending.size !== 1) return undefined;
  return [...pending.values()][0]!;
}

/** Approve only the root session's single pending typed workflow launch. */
export function campaignWorkflowApproval(jsonl: string, sessionId: string, answered: ReadonlySet<string>): Extract<FrontendMutation, { type: "question.answer" }> | undefined {
  const request = pendingRootQuestion(jsonl, sessionId);
  if (!request) return undefined;
  const decision = request.decision;
  if (answered.has(request.toolUseId) || decision?.kind !== "workflow_launch" || decision.approve.choiceId !== "approve") return undefined;
  const question = request.request.length === 1 ? request.request[0] : undefined;
  const option = question?.choices.find((choice) => choice.kind === "option" && choice.choiceId === "approve");
  if (!question || question.question !== decision.question || question.multiSelect || option?.label !== decision.approve.label) return undefined;
  return {
    type: "question.answer", sessionId, toolUseId: request.toolUseId,
    answers: { [decision.question]: { kind: "choice", selections: [{ choiceId: "approve" }], text: option.label } },
  };
}

/** Revise a single design-approval question with the challenge, or approve its revised design. */
export function campaignDesignAnswer(jsonl: string, sessionId: string, answered: ReadonlySet<string>, challenge?: string): Extract<FrontendMutation, { type: "question.answer" }> | undefined {
  const request = pendingRootQuestion(jsonl, sessionId);
  if (!request || answered.has(request.toolUseId) || request.request.length !== 1) return undefined;
  const question = request.request[0]!;
  if (question.multiSelect) return undefined;
  const approve = question.choices.find(choice => choice.kind === "option" && choice.label === "Approve and continue");
  const revise = question.choices.find(choice => choice.kind === "option" && choice.label === "Revise design" && choice.requiresText === true);
  if (approve?.kind !== "option" || revise?.kind !== "option") return undefined;
  const selections = challenge === undefined ? [{ choiceId: approve.choiceId }] : [{ choiceId: revise.choiceId, text: challenge }];
  return {
    type: "question.answer", sessionId, toolUseId: request.toolUseId,
    answers: { [question.question]: { kind: "choice", selections, text: formatQuestionChoiceAnswer(question, selections) } },
  };
}
