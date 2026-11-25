import { expect, test } from "bun:test"
import { retainedExecutionDiagnostics, type ModuleRetainedDiagnostics } from "../../../../src/orchestration/module-contract/module-diagnostics.js"

const diagnostics: ModuleRetainedDiagnostics = {
  attempts: () => ({ attempts: [{ id: "step", name: "Task", definitionId: "task", workflowDefinitionId: "flow", status: "completed", startedAt: 10, completedAt: 20 }], conversationAttempts: new Map([["conversation", [{ attemptId: "step", startedAt: 10 }]]]) }),
  children: () => [{ runId: "child", status: "completed", modelRequestId: "parent", totalCostUsd: 0.03, completedAt: 18 }],
}

test("folds the step and child measurements of the contributions it is given", () => {
  const history = retainedExecutionDiagnostics([], [diagnostics])
  expect(history.attempts?.attempts[0]).toMatchObject({ startedAt: 10, completedAt: 20 })
  expect(history.attempts?.conversationAttempts.get("conversation")).toEqual([{ attemptId: "step", startedAt: 10 }])
  expect(history.children).toEqual([{ runId: "child", status: "completed", modelRequestId: "parent", totalCostUsd: 0.03, completedAt: 18 }])
  expect(retainedExecutionDiagnostics([], [])).toEqual({ attempts: undefined, children: [] })
})

test("refuses competing step histories instead of choosing an owner silently", () => {
  expect(() => retainedExecutionDiagnostics([], [diagnostics, diagnostics])).toThrow("Multiple modules")
})
