import { Schema } from "effect"
import {
  AgentRecordKeys,
  isRepeat,
  namedAgents,
  WorkflowDefinitionSchema,
  type AgentRecordRef,
  type PhaseOrRepeat,
  type WorkflowDefinition,
} from "./workflow-schema.js"

/** Durable record of one agent record's policy: what only the workflow can
 *  mean for this agent. It holds the record's own keys, a named agent's on
 *  top of its phase's defaults, as authored: `writes` is the authored value,
 *  not the resolved default, so a file that states the default and one that
 *  omits it are different records. The brief's content (`brief`, `output`,
 *  `dependencies`, `subagents`) is content, which content identity covers.
 *  `retry` orders attempts, so the graph covers it. The agent's `model` and
 *  `effort` are not policy: the launch binds them in the run's role
 *  snapshot, and the workflow record keeps them as authored. Policy
 *  identity hashes this record and definition provenance persists it, so
 *  the recorded policy and its hash describe the same content. */
export const AgentPolicyRecordSchema = Schema.Struct({
  definitionId: Schema.String,
  name: AgentRecordKeys.name,
  runs: AgentRecordKeys.runs,
  persona: AgentRecordKeys.persona,
  writes: AgentRecordKeys.writes,
  reads: AgentRecordKeys.reads,
})
export type AgentPolicyRecord = typeof AgentPolicyRecordSchema.Type

/** The policy record of one agent record, decoded strictly, so an excess or
 *  malformed field is rejected before the record is hashed or persisted. */
export function canonicalAgentPolicy(record: Pick<AgentRecordRef, "definitionId" | "keys">): AgentPolicyRecord {
  const { keys } = record
  return Schema.decodeUnknownSync(AgentPolicyRecordSchema, { onExcessProperty: "error" })({
    definitionId: record.definitionId,
    ...Object.fromEntries((["name", "runs", "persona", "writes", "reads"] as const)
      .flatMap((key) => keys[key] === undefined ? [] : [[key, keys[key]]])),
  })
}

/** The order of a workflow as its graph identity reads it: each phase with
 *  the keys that decide what runs, when, and in what shape, and each repeat
 *  with its loop. Agent policy and brief content are their own records, and
 *  a display `name` is not structure. */
export function phaseStructure(phases: readonly PhaseOrRepeat[]): readonly unknown[] {
  return phases.map((entry) => {
    if (isRepeat(entry)) return { repeat: entry.repeat, phases: phaseStructure(entry.phases) }
    const { phase, if: condition, over, label, votes, join, retry } = entry
    return {
      phase,
      ...(condition === undefined ? {} : { if: condition }),
      ...(over === undefined ? {} : { over }),
      ...(label === undefined ? {} : { label }),
      ...(votes === undefined ? {} : { votes }),
      ...(join === undefined ? {} : { join }),
      ...(retry === undefined ? {} : { retry }),
      ...(entry.agents === undefined ? {} : {
        agents: namedAgents(entry).map((agent) => ({ agent: agent.agent, ...(agent.retry === undefined ? {} : { retry: agent.retry }) })),
      }),
    }
  })
}

/** The workflow as authored, without the loader's attachments. The schema
 *  type carries no provenance or loaded content, so the decoded value is the
 *  durable record shape. */
export function canonicalWorkflowRecord(workflow: WorkflowDefinition): typeof WorkflowDefinitionSchema.Type {
  const { provenance: _provenance, briefs: _briefs, inputContract: _inputContract, retiredStepGrammar: _retiredStepGrammar, ...source } = workflow
  return Schema.decodeUnknownSync(WorkflowDefinitionSchema, { onExcessProperty: "error" })(source)
}
