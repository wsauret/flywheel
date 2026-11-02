import { expect, test } from "bun:test";
import type { WorkflowProposalEvent } from "../../../../src/workflows/vm/events.js";
import type { createWorkflowHostCommitController } from "../../../../src/workflows/vm/host-commit-controller.js";

/** The event a running workflow host can commit. */
type CommittableEvent = Parameters<ReturnType<typeof createWorkflowHostCommitController>["commit"]>[0]["event"];

const storedBlock: Extract<WorkflowProposalEvent, { type: "ATTEMPT_BLOCKED" }> = {
  type: "ATTEMPT_BLOCKED",
  blocked: { attemptId: "attempt", conversationId: "conversation", handoff: { outcome: { state: "blocked", reason: "reason", evidence: "evidence" } } },
  correctiveDefinitionId: null,
};

/** A current writer never proposes ATTEMPT_BLOCKED; only replay reads a stored one. */
const blockedIsNotCommittable: [Extract<CommittableEvent, { type: "ATTEMPT_BLOCKED" }>] extends [never] ? true : false = true;

const succeeded: CommittableEvent = {
  type: "ATTEMPT_SUCCEEDED",
  outcome: { attemptId: "attempt", conversationId: "conversation", handoff: {}, reassessment: null },
};

test("replay still decodes ATTEMPT_BLOCKED while the host commits only current events", () => {
  expect(storedBlock.type).toBe("ATTEMPT_BLOCKED");
  expect(blockedIsNotCommittable).toBe(true);
  expect(succeeded.type).toBe("ATTEMPT_SUCCEEDED");
});
