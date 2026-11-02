import type { ArtifactContractsFrontmatterSchema } from "./artifact-contracts.js";
import { workflowBriefs, type BriefOutputRole, type LoadedBrief } from "./brief.js";
import { retiredStepReads, type RetiredReadSource } from "./retired-step-grammar/reads.js";
import { agentReads, agentRecords, type AgentRead, type AgentRecordRef, type WorkflowDefinition } from "./workflow-schema.js";

export type ArtifactContracts = typeof ArtifactContractsFrontmatterSchema.Type;

/** One agent record of a workflow joined to its brief and its compiled
 *  output. Everything an attempt of the record needs comes from here, so no
 *  consumer reads the authored record. `reassesses` is true
 *  only for the record of a repeat's `reassess` phase, whose output is the
 *  VM's reassessment contract. */
export type ResolvedAgent = ResolvedAgentBrief & BriefOutputRole;

interface ResolvedAgentBrief {
  /** The record id. Nodes and attempts name the record by it. */
  readonly definitionId: string;
  /** The brief id, which names the brief's model seat. */
  readonly briefId: string;
  /** Display name after precedence: the record's `name`, else the brief's. */
  readonly name: string;
  readonly description?: string;
  /** Skill ids composed into the agent's prompt before the brief, in order. */
  readonly dependencies: readonly string[];
  /** Persona names the agent may dispatch as subagents. */
  readonly subagents: readonly string[];
  /** The persona that runs the brief, when the record names one. */
  readonly persona?: string;
  /** Brief text with every `{{ref:...}}` expanded. */
  readonly body: string;
  readonly writes: ArtifactContracts;
  /** The outputs that the record reads, in authored order. */
  readonly reads: readonly AgentRead[];
}

/** Resolve each agent record against the inline briefs of its file.
 *  Throws when a record names a brief that the file does not hold. */
export function resolveWorkflowAgents(
  workflow: WorkflowDefinition,
): ReadonlyMap<string, ResolvedAgent> {
  const briefs = workflowBriefs(workflow);
  const resolved = new Map<string, ResolvedAgent>();
  for (const record of agentRecords(workflow).values()) {
    const brief = briefs.get(record.definitionId);
    if (!brief) throw new Error(`Workflow "${workflow.id}" agent "${record.definitionId}" has no loaded brief`);
    resolved.set(record.definitionId, resolveAgent(workflow, record, brief));
  }
  return resolved;
}

/** Where the retired step grammar found each read of a record that the
 *  loader converted from it: the reads of the retired record that the agent
 *  record replaces, which the converter rewrote in the same order. Remove
 *  after 2027-04-30. */
function retiredReads(workflow: WorkflowDefinition, definitionId: string): readonly (RetiredReadSource | undefined)[] {
  const view = workflow.retiredStepGrammar;
  const retiredId = view?.stepIds.get(definitionId); // key of the retired step-grammar view
  return view === undefined || retiredId === undefined ? [] : retiredStepReads(view.workflow, retiredId);
}

/** The writes of a record that declares none: one transient artifact named
 *  after the record, so the next phase still receives its output. */
function defaultWrites(definitionId: string): ArtifactContracts {
  return [{ id: definitionId, lifetime: "transient" }];
}

function resolveAgent(
  workflow: WorkflowDefinition,
  record: AgentRecordRef,
  brief: LoadedBrief,
): ResolvedAgent {
  const role: BriefOutputRole = brief.reassesses
    ? { reassesses: true, output: brief.output, retiredOutput: brief.retiredOutput }
    : { reassesses: false, output: brief.output };
  const { keys } = record;
  return {
    definitionId: record.definitionId,
    briefId: brief.briefId,
    ...brief.procedure,
    ...role,
    ...(keys.persona === undefined ? {} : { persona: keys.persona }),
    writes: keys.writes ?? defaultWrites(record.definitionId),
    reads: agentReads(workflow, keys.reads, retiredReads(workflow, record.definitionId)),
  };
}

