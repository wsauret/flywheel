// Shared fixtures of the attempt-runner suites: the bound skill one attempt
// runs, the committed control the runner reads, and the invocation itself.
import { createContextAccumulator } from "../../../../src/workflows/context-bundle/context.js";
import { moduleDisabledReason } from "../../../../src/protocol/module-ids.js";
import type { AgentOutput } from "../../../../src/workflows/vm/agent-outcome.js";
import type { ResolvedAgent } from "../../../../src/workflows/agent-resolution.js";
import {
  createAttemptExecutor,
  type AttemptExecutorDeps,
  type AttemptRunOutcome,
} from "../../../../src/workflows/vm/attempt-runner.js";
import type { AttemptExecutionInput } from "../../../../src/workflows/vm/commands.js";
import { testResolvedAgent, testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js";
import { EVERY_CAPABILITY } from "../../../helpers/attempt-brief.js";
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js";

interface HandoffContent {
  [key: string]: unknown;
}
export const workSkill = testSkill("work", {
  name: "Work",
  trigger: "Implement the feature.",
  body: "Perform the work.",
});
export const skills = testSkillRevision([workSkill]);
export const binding: ResolvedAgent = testResolvedAgent("work", workSkill, {
  writes: [{ id: "artifact", lifetime: "transient" }],
});
const bindings: ReadonlyMap<string, ResolvedAgent> = new Map([[binding.definitionId, binding]]);

export const attempt: AttemptExecutionInput = {
  attemptId: "attempt-1",
  logicalNodeId: "node-1",
  definitionId: "work",
  workflowDefinitionId: "workflow",
  conversationId: "conversation-1",
  iteration: 2,
  provenance: { _tag: "retry" },
  priorRetryFeedback: "Fix the failing assertion.",
  item: { id: "phase-2" },
  scope: { _tag: "workflow" },
};

export function completed(content: HandoffContent | null = {
  summary: "Completed the requested workflow test operation.",
  outcome: { state: "completed" },
  artifacts: { files_modified: ["src/test-fixture.ts"] },
}): AgentOutput {
  return { output: "completed", handoffContent: content, durationMs: 1 };
}

/** A worker that composes its brief for an agent that can call every tool, then returns `output`. */
export function workerReturning(output: AgentOutput): AttemptExecutorDeps["worker"] {
  return async (_attempt, brief) => {
    await brief(EVERY_CAPABILITY);
    return output;
  };
}

export function deps(overrides: Partial<AttemptExecutorDeps> = {}): AttemptExecutorDeps {
  const context = createContextAccumulator();
  context.seedInput({ workflowDefinitionId: "workflow", userRequest: "Implement secure login.", timestamp: 1 });
  return {
    unavailableToolReason: (term) => moduleDisabledReason([term]),
    earlierCheckpoint: async () => null,
    resolvedAgents: bindings,
    skills,
    context: { getContext: async (recipient) => context.getContext(recipient) },
    worker: workerReturning(completed()),
    recordInvocation: async () => {},
    ...overrides,
  };
}

export async function run(
  overrides: Partial<AttemptExecutorDeps> = {},
  input: AttemptExecutionInput = attempt,
  control: () => Pick<CommittedWorkflowControl, "attempts" | "graph"> = committedControl,
): Promise<AttemptRunOutcome> {
  return createAttemptExecutor(deps(overrides)).run(input, {
    workflowSessionId: "workflow-session",
    conversationId: "conversation-1",
    signal: new AbortController().signal,
    committedControl: control,
    conversationsOf: async () => [],
  });
}

export function committedControl(): Pick<CommittedWorkflowControl, "attempts" | "graph"> {
  const ownership = { _tag: "workflow", workflowDefinitionId: "workflow" } as const;
  return {
    graph: {
      nodes: [
        {
          kind: "agent", id: "node-1", workflowDefinitionId: "workflow", order: 0, ownership,
          state: { _tag: "running" }, definitionId: "work", name: "Reassess", retry: null, condition: null,
        },
        {
          kind: "for", id: "phase-node", workflowDefinitionId: "workflow", order: 1, ownership,
          state: { _tag: "running" }, source: { step: "work", field: "phases" }, body: [{ step: "work" }],
        },
      ],
      dependencies: [], joins: [], budgets: [],
    },
    attempts: [{
      id: "phase-attempt", logicalNodeId: "phase-node", workflowDefinitionId: "workflow", definitionId: "work",
      sequence: 1, iteration: 1, resumeRevertCount: 0, provenance: { _tag: "round", index: 1 }, ownership,
      state: { _tag: "pending" }, parentAttemptId: null, conversationId: null, handoff: null,
      priorRetryFeedback: null, item: { id: "phase-2" },
    }],
  };
}
