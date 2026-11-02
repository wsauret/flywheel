/** Workflow control as the last build before the step-content cutover
 *  compiled it, for the identity passes that adopt only a pre-cutover
 *  identity. The graph and attempts are the current compile of one phase
 *  with an inline brief for each authored binding. The identity has the shape that build recorded:
 *  a hash for each binding, and each handoff type that a binding named at its
 *  last pre-cutover revision. Remove after 2027-04-30, together with the
 *  passes that this fixture serves. */

import type { AgentDefinition } from "../../../../src/infra/agent-definition.js"
import { LEGACY_HANDOFF_CONTRACTS } from "../../../../src/orchestration/modules/workflows/migrations/workflow-definition-identity-step-content-pins.js"
import { retiredBindingSha256, type RetiredBinding } from "../../../../src/workflows/retired-bindings.js"
import type { SkillRegistryRevision } from "../../../../src/workflows/skill-schema.js"
import { compileWorkflowControl } from "../../../../src/workflows/vm/compile.js"
import type { CommittedWorkflowControl } from "../../../../src/workflows/vm/committed-control.js"
import { isLegacyDefinitionIdentity, type LegacyDefinitionIdentity } from "../../../../src/workflows/vm/definition-identity.js"
import type { WorkflowDefinition } from "../../../../src/workflows/workflow-schema.js"
import { testResolvedAgent, testResolvedAgents } from "../../../helpers/skill-fixtures.js"
import { nonEmpty } from "../../../helpers/non-empty.js"

/** The canonical record a pre-cutover build snapshotted and hashed for one
 *  binding: the authored binding with its `writes` default filled, plus its
 *  id. */
export function preCutoverBindingRecord(bindingId: string, binding: RetiredBinding) {
  return { ...binding, writes: binding.writes ?? [], bindingId }
}

export type PreCutoverControl = Omit<CommittedWorkflowControl, "definitionIdentity"> & {
  readonly definitionIdentity: LegacyDefinitionIdentity
}

export function compilePreCutover(
  bindings: { readonly [bindingId: string]: RetiredBinding },
  skills: SkillRegistryRevision,
  personas: ReadonlyMap<string, AgentDefinition>,
): PreCutoverControl {
  const ids = Object.keys(bindings)
  if (ids.length === 0) throw new Error("Test fixture needs at least one binding")
  const workflow: WorkflowDefinition = {
    id: "flow",
    name: "Flow",
    phases: nonEmpty(ids.map((id) => ({ phase: id, brief: `Do the ${id} work.`, name: id, writes: [] }))),
  }
  const resolved = testResolvedAgents(Object.entries(bindings).map(([id, binding]) => {
    const skill = skills.skills.get(binding.skill)
    if (!skill) throw new Error(`Test fixture needs skill ${binding.skill}`)
    return testResolvedAgent(id, skill)
  }))
  const compiled = compileWorkflowControl(workflow, resolved, { skills, personas })
  const identity = compiled.definitionIdentity
  if (isLegacyDefinitionIdentity(identity)) throw new Error("A compile records the step identity")
  const contracts = new Map(LEGACY_HANDOFF_CONTRACTS.map((pin) => [pin.name, pin]))
  const handoffs = [...new Set(Object.values(bindings).flatMap(({ handoff }) => handoff === undefined ? [] : [handoff]))].sort()
  return {
    ...compiled,
    definitionIdentity: {
      workflowDefinitionId: identity.workflowDefinitionId,
      graphSha256: identity.graphSha256,
      vmVersion: identity.vmVersion,
      bindings: Object.entries(bindings).toSorted(([left], [right]) => left.localeCompare(right))
        .map(([bindingId, binding]) => ({ bindingId, sha256: retiredBindingSha256(bindingId, binding) })),
      handoffRegistry: handoffs.map((name) => {
        const pin = contracts.get(name)
        if (!pin) throw new Error(`Test fixture needs the pinned contract of ${name}`)
        return { ...pin }
      }),
      skills: identity.skills,
      personas: identity.personas,
    },
  }
}
