import type { ResolvedAgent } from "../../workflows/agent-resolution.js"
import { buildWorkflowCompilationFacts } from "../../workflows/definition-provenance-fact-writers.js"
import type { DefinitionProvenanceFact } from "../../workflows/definition-provenance-facts.js"
import type { WorkflowVerificationResult } from "../../workflows/vm/verify-types.js"
import type { AttemptRow } from "../../workflows/view/types.js"
import { resolveSkillClosure } from "../../workflows/skill-closure.js"
import type { SkillRegistryRevision } from "../../workflows/skill-schema.js"
import type { WorkflowDefinition } from "../../workflows/workflow-schema.js"

export interface WorkflowDefinitionLineageInput {
  workflow: WorkflowDefinition
  /** Agents the launch resolved, in run order. */
  agents: readonly ResolvedAgent[]
  /** Revision the launch pinned. The recorded skills are the dependency closure
   *  of every inline brief, which is exactly what workers
   *  compose and what definition identity hashes. */
  skills: SkillRegistryRevision
  /** The attempt rows that the launch queues. */
  attempts: readonly AttemptRow[]
  userRequestSha256: string
  /** The most attempts the launched control can queue. */
  worstCaseAttempts: number
  /** The verifier result of the launch, or null for a launch that ran no
   *  verifier. */
  verification: WorkflowVerificationResult | null
  /** What the launch warned about, one short located line each. */
  warnings: readonly string[]
}

export function buildWorkflowDefinitionLineageFacts(input: WorkflowDefinitionLineageInput): readonly DefinitionProvenanceFact[] {
  return buildWorkflowCompilationFacts({
    workflow: input.workflow,
    agents: input.agents,
    skills: resolveSkillClosure(
      input.agents.flatMap(({ dependencies }) => dependencies),
      input.skills,
      `Workflow "${input.workflow.id}"`,
    ),
    attempts: input.attempts,
    userRequestSha256: input.userRequestSha256,
    worstCaseAttempts: input.worstCaseAttempts,
    verification: input.verification,
    warnings: input.warnings,
  })
}
