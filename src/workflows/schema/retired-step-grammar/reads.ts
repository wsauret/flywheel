/** Where the `reads` of a step found its outputs before phases, frozen as
 *  the last step-grammar build resolved them.
 *
 *  A run paused before phases holds the node ids of the step-grammar flow,
 *  and its context entries name a map's join by the map id. The phase
 *  grammar gives a converted record's reads other node ids and names a join
 *  by its last phase, so a resumed agent of such a run first looks for each
 *  read where the step grammar put it (refer to `readOutputs` in
 *  `context-bundle/context.ts`).
 *
 *  Remove after 2027-04-30. */
import { WORKFLOW_INPUT_SOURCE_ID } from "../workflow-schema.js";
import { walkFlow, whileMap, type StepGrammarWorkflow } from "./schema.js";

/** Where one `reads` id of a step found its output: the latest handoff of
 *  its step at the node of its step entry, or the join output of its map,
 *  which a loop over the map holds at the loop's node. */
export type RetiredReadSource =
  | { readonly kind: "step"; readonly nodeId: string; readonly stepId: string }
  | { readonly kind: "map"; readonly nodeId: string; readonly mapId: string };

/** The node id of the entry at one tree path: `<workflow>:node:<i+1>`, and
 *  `<container>:node:<i+1>` for a child. */
function nodeIdAt(workflowId: string, path: readonly number[]): string {
  return `${workflowId}${path.map((index) => `:node:${index + 1}`).join("")}`;
}

/** Every output of a step-grammar flow by its local id. An id that more
 *  than one entry takes names no output, as the step grammar refused it. */
function outputSources(workflow: StepGrammarWorkflow): ReadonlyMap<string, RetiredReadSource | null> {
  const byId = new Map<string, RetiredReadSource | null>();
  const claim = (id: string, source: RetiredReadSource): void => {
    byId.set(id, byId.has(id) ? null : source);
  };
  walkFlow(workflow.flow, (entry, { path }) => {
    const nodeId = nodeIdAt(workflow.id, path);
    if ("step" in entry) return claim(entry.id ?? entry.step, { kind: "step", nodeId, stepId: entry.step });
    const map = "map" in entry ? entry : whileMap(entry);
    if (map !== undefined) claim(map.id, { kind: "map", nodeId, mapId: map.id });
  });
  return byId;
}

/** Where each `reads` id of step `stepId` found its output, in authored
 *  order, undefined for an id that named no one output. */
export function retiredStepReads(workflow: StepGrammarWorkflow, stepId: string): readonly (RetiredReadSource | undefined)[] {
  const reads = workflow.steps[stepId]?.reads ?? [];
  if (reads.length === 0) return [];
  const sources = outputSources(workflow);
  return reads.map((id) => id === WORKFLOW_INPUT_SOURCE_ID ? undefined : sources.get(id) ?? undefined);
}
