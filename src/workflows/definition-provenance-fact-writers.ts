import { Schema } from "effect"
import type { ResolvedAgent } from "./agent-resolution.js"
import { hashContent, hashDefinition, type ContentHash } from "./definition-hash.js"
import { canonicalAgentPolicy, canonicalWorkflowRecord } from "./definition-records.js"
import { USER_REQUEST_ARTIFACT_ID } from "./definition-validation.js"
import type { DefinitionIdentityMismatch } from "./vm/definition-identity.js"
import { AttemptRowSchema } from "./view/schemas.js"
import type { AttemptRow } from "./view/types.js"
import { renderSkillContext } from "./skill-context.js"
import type { SkillDefinition } from "./skill-schema.js"
import { DefinitionProvenanceSchema } from "./definition-provenance.js"
import {
  parseDefinitionProvenanceFact,
  WORKFLOW_COMPILED_VERSION,
  type DefinitionDriftRejectedFact,
  type DefinitionKind,
  type DefinitionProvenanceFact,
  type AgentRecord,
  type SkillRecord,
} from "./definition-provenance-facts.js"
import { agentRecords, type WorkflowDefinition } from "./workflow-schema.js"
import { canonicalStepWorkflowRecord } from "./retired-step-grammar/records.js"
import type { WorkflowVerificationResult } from "./vm/verify-types.js"

interface WorkflowCompilationInput {
  workflow: WorkflowDefinition
  /** Agents in run order, as the launch resolved them. */
  agents: readonly ResolvedAgent[]
  /** Dependency closure of the composed skills, in composition order. */
  skills: readonly SkillDefinition[]
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

export function buildWorkflowCompilationFacts(input: WorkflowCompilationInput): readonly DefinitionProvenanceFact[] {
  const facts: DefinitionProvenanceFact[] = []
  const workflow = canonicalWorkflowRecord(input.workflow)
  const records = agentRecords(workflow)
  const agents = input.agents.map((agent) => {
    const definition = agentRecord(agent, records.get(agent.definitionId), workflow.id)
    return { definition, hash: hashDefinition(definition) }
  })
  const skills = input.skills.map((skill) => ({
    definition: skillRecord(skill),
    // The package's content identity is the composed context, which is what a
    // worker prompt reads and what definition identity pins.
    hash: hashContent(renderSkillContext(skill)),
  }))
  const rows = input.attempts.map((attempt) => Schema.decodeUnknownSync(AttemptRowSchema, { onExcessProperty: "error" })(attempt))
  const workflowHash = hashDefinition(workflow)
  const provenance = input.workflow.provenance
    ? Schema.decodeUnknownSync(DefinitionProvenanceSchema, { onExcessProperty: "error" })(input.workflow.provenance)
    : undefined

  // A file in the retired step grammar also records its step-grammar
  // record, which a Resume converts again to read the same briefs.
  const retired = input.workflow.retiredStepGrammar?.workflow
  facts.push(loadedFact("workflow", workflow.id, workflow, provenance, retired === undefined ? undefined : canonicalStepWorkflowRecord(retired)))
  facts.push(parseDefinitionProvenanceFact(hashRecordedFact("workflow", workflow.id, workflowHash)))

  for (const { definition, hash } of agents) {
    // An agent record is authored inside the workflow file, so it carries
    // the workflow's provenance rather than one of its own.
    facts.push(loadedFact("agent", definition.definitionId, definition, provenance))
    facts.push(parseDefinitionProvenanceFact(hashRecordedFact("agent", definition.definitionId, hash)))
  }

  for (const { definition, hash } of skills) {
    facts.push(loadedFact("skill", definition.id, definition))
    facts.push(parseDefinitionProvenanceFact(hashRecordedFact("skill", definition.id, hash)))
  }

  facts.push(parseDefinitionProvenanceFact({
    type: "workflow.compiled",
    version: WORKFLOW_COMPILED_VERSION,
    actor: "flywheel",
    payload: {
      workflowDefinitionId: workflow.id,
      workflowName: workflow.name,
      userRequestArtifactId: USER_REQUEST_ARTIFACT_ID,
      userRequestSha256: input.userRequestSha256,
      definitionIds: agents.map(({ definition }) => definition.definitionId),
      skillIds: skills.map(({ definition }) => definition.id),
      attempts: rows,
      worstCaseAttempts: input.worstCaseAttempts,
      verification: input.verification,
      warnings: input.warnings,
    },
  }))
  return facts
}

/** The durable record of one agent. The policy record is taken from the
 *  workflow the record was authored in: it records what the workflow
 *  declared, never a value the resolver defaulted, such as the default
 *  transient write. */
function agentRecord(agent: ResolvedAgent, record: Parameters<typeof canonicalAgentPolicy>[0] | undefined, workflowId: string): AgentRecord {
  if (!record) throw new Error(`Workflow "${workflowId}" has no agent record "${agent.definitionId}" to record`)
  return {
    definitionId: agent.definitionId,
    briefId: agent.briefId,
    policy: canonicalAgentPolicy(record),
    output: agent.output.canonical,
  }
}

function skillRecord(skill: SkillDefinition): SkillRecord {
  return {
    id: skill.id,
    name: skill.name,
    trigger: skill.trigger,
    ...(skill.version === undefined ? {} : { version: skill.version }),
    dependencies: skill.dependencies,
    agents: skill.agents,
  }
}

function loadedFact(
  kind: DefinitionKind,
  id: string,
  definition: unknown,
  provenance?: typeof DefinitionProvenanceSchema.Type,
  retiredStepGrammar?: unknown,
): DefinitionProvenanceFact {
  return parseDefinitionProvenanceFact({
    type: "definition.loaded",
    version: 9,
    actor: "flywheel",
    payload: { kind, id, definition, ...(retiredStepGrammar === undefined ? {} : { retiredStepGrammar }), ...(provenance ? { provenance } : {}) },
  })
}

export function buildDefinitionDriftRejectedFact(input: {
  readonly workflowId: string
  readonly changes: readonly [DefinitionIdentityMismatch, ...DefinitionIdentityMismatch[]]
  readonly latestSeq: number
}): DefinitionDriftRejectedFact {
  const fact = parseDefinitionProvenanceFact({
    type: "definition.drift_rejected",
    version: 1,
    actor: "flywheel",
    payload: input,
  })
  if (fact.type !== "definition.drift_rejected") throw new Error("Definition drift fact parser returned the wrong type")
  return fact
}
function hashRecordedFact(
  kind: DefinitionKind,
  id: string,
  hash: ContentHash,
): Extract<DefinitionProvenanceFact, { type: "definition.hash_recorded" }> {
  const payload = {
    kind,
    id,
    sha256: hash.sha256,
    bytes: hash.bytes,
    format: "canonical-json-v1" as const,
  }
  return { type: "definition.hash_recorded", version: 3, actor: "flywheel", payload }
}
