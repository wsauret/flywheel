import { expect, test } from "bun:test"
import { createInitExperimentTool } from "../../../../../../src/orchestration/modules/experiments/tools/init-experiment.js"
import { ExperimentExecutionState } from "../../../../../../src/orchestration/modules/experiments/execution-state.js"
import type { ExperimentInitializedFact } from "../../../../../../src/orchestration/modules/experiments/facts.js"
import { testExperimentOperation } from "../../../agent-runtime/tools/_fixtures.js"

const charter = `# Experiment
\`\`\`toml
name="speed"
metric_name="latency"
metric_unit="ms"
direction="lower"
measure_command="./.experiment/measure.sh"
checks_command="./.experiment/checks.sh"
work_dir="."
protected_paths=["tests/**", "tests/**"]
sealed_paths=[]
\`\`\`
## Objective
x
## Metrics
x
## Hard gates
x
## Anti-gaming rules
x
## Files in scope
x
## Protected paths
x
## Sealed paths
None.
## Commands
x
## Baseline
METRIC latency=10
## Search strategy
x`

test("validates then records segment one with mandatory protections", async () => {
  const facts: ExperimentInitializedFact[] = []
  const tool = createInitExperimentTool({
    snapshot: async () => ({ mode: { active: true, workDir: "/repo" }, configuration: null, segments: [], runs: [] }),
    readCharter: async () => charter,
    validateWorktree: async () => "/repo",
    record: async (fact) => { facts.push(fact) },
    executionState: new ExperimentExecutionState(),
    operation: testExperimentOperation(),
  })
  const result = await tool.execute({
    name: "speed", metric_name: "latency", metric_unit: "ms", direction: "lower",
    measure_command: "./.experiment/measure.sh", checks_command: "./.experiment/checks.sh",
    work_dir: ".", protected_paths: ["tests/**", "tests/**"], sealed_paths: [],
  }, { executionCwd: "/repo", userDataRoot: "/repo/.test-account", projectRoot: "/repo", artifactScopeId: "a", retrievalSessionId: "r" })
  expect(result.outcome).toBe("ok")
  expect(facts).toHaveLength(1)
  expect(facts[0]?.payload.protectedPaths).toEqual(["tests/**", ".experiment/charter.md", ".experiment/measure.sh", ".experiment/checks.sh"])
})
