import type { ContextAccumulator } from "../../../../src/workflows/context-bundle/context";

type HandoffEntryInput = Parameters<ContextAccumulator["accumulate"]>[0];

interface HandoffData {
  [key: string]: unknown;
}

export function makeHandoffData(overrides: HandoffData = {}): HandoffData {
  return {
    summary: "step completed",
    decisions: ["decision-A"],
    artifacts: ["src/foo.ts"],
    issues: ["warning-1"],
    ...overrides,
  };
}

export function makeEntry(overrides: Partial<HandoffEntryInput> & Pick<HandoffEntryInput, "entryId" | "agentName" | "handoff">): HandoffEntryInput {
  return {
    definitionId: "test-step",
    workflowDefinitionId: "test-workflow",
    recipientAttemptId: null,
    writes: [],
    timestamp: Date.now(),
    ...overrides,
  };
}

export function accumulateN(
  acc: ContextAccumulator,
  n: number,
  prefix = "step",
): void {
  for (let i = 1; i <= n; i++) {
    acc.accumulate({
      entryId: `${prefix}-${i}`,
      agentName: `Step ${i}`,
      definitionId: "test-step",
      workflowDefinitionId: "test-workflow",
      recipientAttemptId: null,
      writes: [],
      timestamp: Date.now(),
      handoff: makeHandoffData({
        decisions: [`decision-${i}`],
        artifacts: [`file-${i}.ts`],
        issues: [`issue-${i}`],
      }),
    });
  }
}
