import { expect, test } from "bun:test"
import { retainedExecutionDiagnostics } from "../../../src/orchestration/module-diagnostics.js"
import { composeFirstPartyModules, type FirstPartyModule } from "../../../src/orchestration/modules.js"

const diagnosticModule: FirstPartyModule = {
  id: "development", dependencies: [], availability: { kind: "available" },
  contributions: [], observers: [], transformers: [], gates: [],
  retainedDiagnostics: {
    attempts: () => ({ attempts: [{ id: "step", name: "Task", definitionId: "task", workflowDefinitionId: "flow", status: "completed", startedAt: 10, completedAt: 20 }], conversationToAttempt: new Map([["conversation", "step"]]) }),
    children: () => [{ runId: "child", status: "completed", modelRequestId: "parent", totalCostUsd: 0.03, completedAt: 18 }],
  },
}

test("reads installed step and child measurements after selection withdraws the module", () => {
  const installed = [diagnosticModule]
  expect(composeFirstPartyModules(installed, ["development"]).enabledModuleIds).not.toContain("development")
  const history = retainedExecutionDiagnostics([], installed)
  expect(history.attempts?.attempts[0]).toMatchObject({ startedAt: 10, completedAt: 20 })
  expect(history.attempts?.conversationToAttempt.get("conversation")).toBe("step")
  expect(history.children).toEqual([{ runId: "child", status: "completed", modelRequestId: "parent", totalCostUsd: 0.03, completedAt: 18 }])
  expect(retainedExecutionDiagnostics([], [])).toEqual({ attempts: undefined, children: [] })
})

test("refuses competing step histories instead of choosing an owner silently", () => {
  expect(() => retainedExecutionDiagnostics([], [diagnosticModule, { ...diagnosticModule, id: "workflows" }])).toThrow("Multiple modules")
})
