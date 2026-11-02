import { expect, test } from "bun:test";
import { campaignDesignAnswer, campaignWorkflowApproval, recordCampaignAnswer } from "../../../bench/chat-ab/campaign-policy.js";
import { workflowLaunchDecision } from "../../../src/orchestration/workflow-host/launch-origin.js";

// ask-user.ts records this exact payload from workflowLaunchDecision's bound request.
const bound = workflowLaunchDecision({ source: { kind: "path", path: "/scratch/coding.workflow.yaml", definitionSha256: "a".repeat(64) }, name: "Coding" });
const requested = {
  source: "store", sessionId: "root", type: "agent_input.requested", version: 3, actor: "agent",
  payload: { interactionId: "tool", conversationId: "conversation", toolUseId: "tool", request: [bound.question], decision: bound.decision },
};
const json = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");

test("delivers a challenge through the design revision and approves the next design once", () => {
  const question = { question: "Proceed?", multiSelect: false, choices: [
    { kind: "option", choiceId: "yes", label: "Approve and continue" },
    { kind: "option", choiceId: "edit", label: "Revise design", requiresText: true },
  ] };
  const design = { ...requested, payload: { ...requested.payload, decision: undefined, request: [question] } };
  expect(campaignDesignAnswer(json(design), "root", new Set(), "Try the smaller fix.")).toEqual({
    type: "question.answer", sessionId: "root", toolUseId: "tool",
    answers: { "Proceed?": { kind: "choice", selections: [{ choiceId: "edit", text: "Try the smaller fix." }], text: "Revise design: Try the smaller fix." } },
  });
  expect(campaignDesignAnswer(json(design), "root", new Set())).toMatchObject({
    answers: { "Proceed?": { selections: [{ choiceId: "yes" }], text: "Approve and continue" } },
  });
  const capture = { answered: new Set<string>(), approvals: 0 };
  recordCampaignAnswer(capture, campaignDesignAnswer(json(design), "root", capture.answered, "Try the smaller fix.")!, "revise-design");
  const revised = { ...design, payload: { ...design.payload, interactionId: "revised", toolUseId: "revised" } };
  recordCampaignAnswer(capture, campaignDesignAnswer(json(revised), "root", capture.answered)!, "approve");
  expect(capture.answered).toEqual(new Set(["tool", "revised"]));
  expect(capture.approvals).toBe(1);
  expect(campaignDesignAnswer(json(design), "root", new Set(["tool"]))).toBeUndefined();
  expect(campaignDesignAnswer(json(design), "child", new Set())).toBeUndefined();
  expect(campaignDesignAnswer(json(requested), "root", new Set())).toBeUndefined();
  expect(campaignDesignAnswer(json(design, { ...design, payload: { ...design.payload, interactionId: "other" } }), "root", new Set())).toBeUndefined();
  expect(campaignDesignAnswer(json({ ...design, payload: { ...design.payload, request: [{ ...question, choices: question.choices.map(choice => ({ ...choice, requiresText: false })) }] } }), "root", new Set())).toBeUndefined();
});

test("approves only a pending typed root workflow launch using the protocol's question key and option label", () => {
  expect(campaignWorkflowApproval(json(requested), "root", new Set())).toEqual({
    type: "question.answer", sessionId: "root", toolUseId: "tool",
    answers: { [bound.decision.question]: { kind: "choice", selections: [{ choiceId: "approve" }], text: bound.decision.approve.label } },
  });
  const { decision: _, ...ordinary } = requested.payload;
  expect(campaignWorkflowApproval(json({ ...requested, payload: ordinary }), "root", new Set())).toBeUndefined();
  expect(campaignWorkflowApproval(json({ ...requested, sessionId: "child" }), "root", new Set())).toBeUndefined();
  expect(campaignWorkflowApproval(json(requested), "root", new Set(["tool"]))).toBeUndefined();
  expect(campaignWorkflowApproval(json({ source: "log", sessionId: "root", type: "agent_input.requested", payload: {} }), "root", new Set())).toBeUndefined();
  expect(campaignWorkflowApproval(json({
    ...requested, payload: { ...requested.payload, decision: { ...bound.decision, approve: { ...bound.decision.approve, choiceId: "option-1" } } },
  }), "root", new Set())).toBeUndefined();
  expect(campaignWorkflowApproval(json(requested, {
    source: "store", sessionId: "root", type: "agent_input.answered", version: 3, actor: "user",
    payload: { interactionId: "tool", answers: { [bound.decision.question]: { kind: "choice", selections: [{ choiceId: "approve" }], text: bound.decision.approve.label } } },
  }), "root", new Set())).toBeUndefined();
  expect(campaignWorkflowApproval(json(requested, {
    source: "store", sessionId: "root", type: "agent_input.cancelled", version: 1, actor: "user",
    payload: { interactionId: "tool", reason: "declined" },
  }), "root", new Set())).toBeUndefined();
  expect(campaignWorkflowApproval(json({
    ...requested, payload: { ...requested.payload, decision: { kind: "definition_override", preparationId: "proposal", question: bound.decision.question, approve: bound.decision.approve, reject: bound.decision.reject } },
  }), "root", new Set())).toBeUndefined();
});

test("does not expose malformed subject question content in validation failures", () => {
  const sentinel = "private-subject-sentinel";
  for (const malformed of [sentinel, json({ ...requested, payload: { interactionId: sentinel } })]) {
    try {
      campaignWorkflowApproval(malformed, "root", new Set());
      throw new Error("Expected validation failure");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message).toBe("subject question evidence failed validation");
      expect(error.message).not.toContain(sentinel);
    }
  }
});
