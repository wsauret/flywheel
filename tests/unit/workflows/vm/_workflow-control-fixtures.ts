import type { EventStoreAppend } from "../../../../src/infra/event-store-types.js"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import type { ResolvedAgent } from "../../../../src/workflows/agent-resolution.js"
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js"
import { testResolvedAgent, testResolvedAgents, testSkill, testSkillRevision } from "../../../helpers/skill-fixtures.js"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import { buildWorkflowControlInitializedFact } from "../../../../src/workflows/vm/session-facts.js"
import { flattenWorkflowView } from "../../../../src/workflows/vm/view-flatten.js"
import { queueFactsForState } from "../../../../src/workflows/view/view-diff.js"
import { buildContextInputSeededFact } from "../../../../src/workflows/context-bundle/context-facts.js"

const workflow: WorkflowDefinition = {
  id: "fixture-workflow",
  name: "Fixture workflow",
  phases: [{ phase: "fixture-step", brief: "Do the fixture-step work.", name: "fixture-step", writes: [] }],
}
const skill = testSkill("fixture-step", { name: "Fixture step" })
const bindings = testResolvedAgents([testResolvedAgent("fixture-step", skill, { name: "Fixture step" })])
const control = compileWorkflowControl(workflow, bindings, { skills: testSkillRevision([skill]) })

export function workflowControlInitializedEvent(sessionId: string, timestamp: number): EventStoreAppend {
  const fact = buildWorkflowControlInitializedFact({ ...control, aggregateSeq: 1 })
  return {
    aggregateId: `workflow:${sessionId}`,
    type: fact.type,
    version: fact.version,
    timestamp,
    actor: fact.actor,
    sessionId,
    payload: fact.payload,
  }
}

/** The facts a run of the fixture workflow, or of `committed` with its
 *  `agents`, commits: its control root, its request seed, and the attempt
 *  rows that match its control, so the run reads as executable. */
export function workflowLaunchEvents(sessionId: string, timestamp: number, committed: { readonly control: CommittedWorkflowControl; readonly agents: ReadonlyMap<string, ResolvedAgent> } = { control, agents: bindings }): EventStoreAppend[] {
  const root = buildWorkflowControlInitializedFact({ ...committed.control, aggregateSeq: 1 })
  const facts = [root, buildContextInputSeededFact(committed.control.workflowName, "Do the fixture work"), ...queueFactsForState(null, flattenWorkflowView(committed.control, committed.agents))]
  return facts.map((fact) => ({ aggregateId: `workflow:${sessionId}`, type: fact.type, version: fact.version, timestamp, actor: fact.actor, sessionId, payload: fact.payload }))
}
