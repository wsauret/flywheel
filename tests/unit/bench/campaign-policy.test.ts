import { expect, test } from "bun:test";
import { campaignDesignAnswer, campaignWorkflowApproval, recordCampaignAnswer } from "../../../bench/chat-ab/campaign-policy.js";
import { acpQuestionForm } from "../../../src/protocol/rpc/acp.js";
import type { PendingQuestionView } from "../../../src/protocol/session/question-protocol-types.js";
import { workflowLaunchDecision } from "../../../src/orchestration/agent-runtime/tools/definitions/workflow-launch.js";

type Entry = PendingQuestionView["questions"][number];
// Headless chat asks each open question as this form (protocol/rpc/acp.ts), which the adapter decodes as is.
const form = (...questions: Entry[]) => acpQuestionForm({ kind: "question", toolUseId: "tool", timestamp: 0, questions }, "root");
const { decision } = workflowLaunchDecision({ source: { kind: "path", path: "/scratch/coding.workflow.yaml", definitionSha256: "a".repeat(64) }, name: "Coding" });
// The bound launch question's text, header, and choices, as the decision states them.
const launch = (approveId: string = decision.approve.choiceId, question: string = decision.question): Entry => ({ question, header: "Workflow", multiSelect: false, choices: [
  { kind: "option", choiceId: approveId, label: decision.approve.label },
  { kind: "option", choiceId: decision.reject.choiceId, label: decision.reject.label },
  { kind: "freeform", label: "Other" },
] });
const design: Entry = { question: "Proceed?", multiSelect: false, choices: [
  { kind: "option", choiceId: "choice-1", label: "Approve and continue" },
  { kind: "option", choiceId: "choice-2", label: "Revise design", requiresText: true },
  { kind: "freeform", label: "Other" },
] };

test("approves a single design question once and counts only approvals", () => {
  expect(campaignDesignAnswer(form(design), new Set())).toEqual({ q1: "choice-1" });
  expect(campaignDesignAnswer(form(design), new Set(["tool"]))).toBeUndefined();
  expect(campaignDesignAnswer(form({ ...design, choices: design.choices.map((choice) => choice.kind === "option" ? { ...choice, requiresText: false } : choice) }), new Set())).toBeUndefined();
  expect(campaignDesignAnswer(form({ ...design, multiSelect: true }), new Set())).toBeUndefined();
  expect(campaignDesignAnswer(form(design, { ...design, question: "Also?" }), new Set())).toBeUndefined();
  expect(campaignDesignAnswer(form(launch()), new Set())).toBeUndefined();
  const capture = { answered: new Set<string>(), approvals: 0 };
  recordCampaignAnswer(capture, "tool", "revise-design");
  recordCampaignAnswer(capture, "revised", "approve");
  expect(capture).toEqual({ answered: new Set(["tool", "revised"]), approvals: 1 });
});

test("approves only a typed workflow launch question", () => {
  expect(campaignWorkflowApproval(form(launch()), new Set())).toEqual({ q1: "approve" });
  expect(campaignWorkflowApproval(form(launch()), new Set(["tool"]))).toBeUndefined();
  // A model-written question numbers its choices, so it cannot name the approve choice.
  expect(campaignWorkflowApproval(form(launch("choice-1")), new Set())).toBeUndefined();
  expect(campaignWorkflowApproval(form(launch(undefined, "Launch the Review workflow?")), new Set())).toBeUndefined();
  const override = { question: "Apply this definition override resolution?\n\nsummary", header: "Override", multiSelect: false, choices: [
    { kind: "option" as const, choiceId: "approve", label: "Approve the override resolution" },
    { kind: "option" as const, choiceId: "reject", label: "Reject the override resolution" },
    { kind: "freeform" as const, label: "Other" },
  ] };
  expect(campaignWorkflowApproval(form(override), new Set())).toBeUndefined();
  expect(campaignWorkflowApproval(form(design), new Set())).toBeUndefined();
});
