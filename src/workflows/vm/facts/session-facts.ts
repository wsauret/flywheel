import { Schema } from "effect";
import { createFactParser, factDescriptors } from "../../../infra/substrate/facts/event-registry.js";
import { DefinitionProvenanceFactSchemas } from "../../provenance/definition-provenance-facts.js";
import { HandoffFactSchemas } from "../../output-contract/facts.js";
import { MemoryFactSchemas } from "../../learning/memory/memory-facts.js";
import { WorkflowContextFactSchemas } from "../../context-bundle/context-facts.js";
import { WorkflowQueueFactSchemas } from "../../view/view-facts.js";
import { WorkflowRunFactSchemas } from "../../run/run-facts.js";
import { SessionRuntimeFactSchemas } from "../../../infra/substrate/runtime-facts/runtime-fact-parser.js";
import { SESSION_RUNTIME_FACT_DEFINITIONS } from "../../../infra/substrate/runtime-facts/runtime-fact-types.js";
import { ImprovementFactSchemas } from "../../learning/improvements/improvement-facts.js";
import { committedWorkflowEvent, WorkflowControlFactSchemas } from "../../control-facts/family.js";
import { holdsCurrentEvent, type DecodedWorkflowProposalEvent } from "../../control-facts/events.js";

const WorkflowSessionFactSchemas = [
  ...SessionRuntimeFactSchemas.filter((_schema, index) => {
    const type = SESSION_RUNTIME_FACT_DEFINITIONS[index]?.type
    return type?.startsWith("budget.") || type === "model.usage.measured"
  }),
  ...WorkflowRunFactSchemas,
  ...ImprovementFactSchemas,
  ...WorkflowControlFactSchemas,
  ...DefinitionProvenanceFactSchemas,
  ...WorkflowQueueFactSchemas,
  ...WorkflowContextFactSchemas,
  ...HandoffFactSchemas,
  ...MemoryFactSchemas,
] as const;
export const WorkflowSessionFactSchema = Schema.Union(WorkflowSessionFactSchemas);
export const WORKFLOW_SESSION_FACT_DESCRIPTORS = factDescriptors(WorkflowSessionFactSchemas);
const parseWorkflowSessionFactFromRegistry = createFactParser(WorkflowSessionFactSchemas);
export type WorkflowSessionFact = typeof WorkflowSessionFactSchema.Type;

export function parseWorkflowSessionFact(value: unknown): WorkflowSessionFact {
  return parseWorkflowSessionFactFromRegistry<WorkflowSessionFact>(value);
}

/** The one shape strict replay compares. Every fact keeps its exact type and
 *  version, and a current fact compares exactly. A fact of a historical version
 *  and its re-derivation at that version map to equal values when they record
 *  the same act: the inert evidence of a version 1 success drops out, and a
 *  historical terminal fact compares its canonical event. */
type ReplayComparableFact =
  | { readonly type: "attempt.succeeded"; readonly version: 1; readonly actor: string; readonly attemptId: string }
  | {
    readonly type: "workflow.control.committed";
    readonly version: number;
    readonly actor: string;
    readonly proposalId: string;
    readonly event: DecodedWorkflowProposalEvent;
  }
  | WorkflowSessionFact;

export function replayComparableFact(fact: WorkflowSessionFact): ReplayComparableFact {
  switch (fact.type) {
    case "attempt.succeeded": return fact.version === 1
      ? { type: fact.type, version: fact.version, actor: fact.actor, attemptId: fact.payload.attemptId }
      : fact;
    case "workflow.control.committed": return holdsCurrentEvent(fact.version) ? fact : {
      type: fact.type,
      version: fact.version,
      actor: fact.actor,
      proposalId: fact.payload.proposalId,
      event: committedWorkflowEvent(fact),
    };
    default: return fact;
  }
}
