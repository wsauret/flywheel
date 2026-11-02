import type { StoredFact } from "../../src/infra/event-store-types.js"
import { Schema } from "effect"
import { WorkflowDefinitionSchema } from "../../src/workflows/workflow-schema.js"
import { compileWorkflowControl } from "../../src/workflows/vm/compile.js"
import type { CommittedWorkflowControl } from "../../src/workflows/vm/committed-control.js"
import { buildContextInputSeededFact } from "../../src/workflows/context-bundle/context-facts.js"
import { queueFactsForState } from "../../src/workflows/view/view-diff.js"
import { flattenWorkflowView } from "../../src/workflows/vm/view-flatten.js"
import { buildWorkflowControlInitializedFact, buildWorkflowControlRecoveredFact, type WorkflowSessionFact } from "../../src/workflows/vm/session-facts.js"
import { testResolvedAgent, testResolvedAgents, testSkill, testSkillRevision } from "./skill-fixtures.js"

const skill = testSkill("work", { name: "Work" })
const bindings = testResolvedAgents([testResolvedAgent("work", skill)])
const initialized = buildWorkflowControlInitializedFact(compileWorkflowControl(Schema.decodeUnknownSync(WorkflowDefinitionSchema)({
  id: "workflow",
  name: "Workflow",
  phases: [{ phase: "work", brief: "Do the work work.", name: "work", writes: [] }],
}), bindings, {
  skills: testSkillRevision([skill]),
}))
if (initialized.type !== "workflow.control.initialized") throw new Error("Expected initialized root")
export const initializedWorkflowRoot = initialized

/** A canonical launch batch before test-specific view snapshots. */
export function initializedWorkflowFacts(userRequest: string): WorkflowSessionFact[] {
  const control = initializedWorkflowRoot.payload.control
  const queue = flattenWorkflowView(control, bindings)
  const queueFacts = queueFactsForState(null, queue)
  return [
    buildContextInputSeededFact("workflow", userRequest),
    buildWorkflowControlInitializedFact({ ...control, aggregateSeq: queueFacts.length + 1 }),
    ...queueFacts,
  ]
}

export function recoveredWorkflowRoot(control: CommittedWorkflowControl, aggregateSeq: number) {
  const recovered = buildWorkflowControlRecoveredFact({
    supersededThroughSeq: aggregateSeq - 2,
    degradationReasons: [{ kind: "invalid_suffix", seq: aggregateSeq - 2 }],
    runtimeIdentity: { version: "0.0.8", buildId: "test" },
    identities: {
      workflow: { source: "recovered", value: "workflow" },
      step: null,
      attempt: null,
      conversation: null,
    },
    control: { ...control, status: "paused", frontier: [], aggregateSeq },
  })
  if (recovered.type !== "workflow.control.recovered") throw new Error("Expected recovered root")
  return recovered
}

export function storedWorkflowFacts(facts: readonly WorkflowSessionFact[], fromSeq = 0): StoredFact[] {
  return facts.map((fact, index) => ({
    ...fact,
    aggregateId: "workflow:session",
    sessionId: "session",
    timestamp: fromSeq + index + 1,
    id: `event-${fromSeq + index}`,
    position: (fromSeq + index + 1) * 10,
    seq: fromSeq + index,
  }))
}
