import { readFileSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";
import { Schema } from "effect";
import { parseFrontmatter } from "../../src/infra/frontmatter.js";
import { loadBriefs, loadWorkflowInputContract, type LoadedBrief } from "../../src/workflows/brief.js";
import { definitionAssets, resolveAssetRef, type AssetLocation } from "../../src/workflows/definition-assets.js";
import { decodeWorkflowFile } from "../../src/workflows/workflow-file.js";
import { agentRecords, isRepeat, type WorkflowDefinition, type WorkflowPhase } from "../../src/workflows/workflow-schema.js";
import type { ProjectDefinitionRegistryRevision } from "../../src/workflows/definition-registry.js";
import { nonEmpty } from "./non-empty.js";

const historicalBrief = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  dependencies: Schema.optionalKey(Schema.Array(Schema.String)),
  subagents: Schema.optionalKey(Schema.Array(Schema.String)),
  agents: Schema.optionalKey(Schema.Array(Schema.String)),
  output: Schema.optionalKey(Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)])),
});

/** Hydrate the byte-frozen retained fixtures for history and identity tests only.
 * Live file loading never reads these briefs. */
export function retiredFixtureWorkflow(revision: Pick<ProjectDefinitionRegistryRevision, "skills">, id: string, projectRoot: string): WorkflowDefinition {
  const dir = join(projectRoot, ".flywheel", "workflows");
  const file = join(dir, `${id}.yaml`);
  const decoded = decodeWorkflowFile({ file, content: readFileSync(file, "utf8"), skills: revision.skills });
  if (!decoded.ok) throw new Error(JSON.stringify(decoded.diagnostics));
  const workflow: WorkflowDefinition = {
    ...decoded.definition,
    provenance: { layer: "project", id, filePath: file },
    ...(decoded.stepGrammar ? { retiredStepGrammar: decoded.stepGrammar.view } : {}),
  };
  const metadata = new Map<string, { id: string; description?: string }>();
  const records = agentRecords(workflow);
  const stated = new Set(workflow.phases.flatMap((entry) => isRepeat(entry) ? entry.phases : [entry]).filter(({ brief }) => brief !== undefined).map(({ phase }) => phase));
  const inline = (phase: WorkflowPhase): WorkflowPhase => {
    const record = records.get(phase.phase);
    if (!record) throw new Error(`Historical fixture has no record ${phase.phase}`);
    // A step that held its instructions is already an inline brief.
    if (stated.has(record.briefName)) return phase;
    const stepId = workflow.retiredStepGrammar?.stepIds.get(record.definitionId);
    const step = stepId === undefined ? undefined : workflow.retiredStepGrammar?.workflow.steps[stepId];
    const path = step?.file?.replace(/^bundled:steps\//u, "briefs/")
      ?? `briefs/${record.briefName.includes(".") ? record.briefName : `${id}.${record.briefName}`}.md`;
    const parsed = parseFrontmatter(readFileSync(join(dir, path), "utf8"));
    if (!parsed) throw new Error(`Historical fixture brief ${path} has no frontmatter`);
    const content = Schema.decodeUnknownSync(historicalBrief)(parsed.frontmatter);
    const output = step?.output ?? content.output;
    const location: AssetLocation = { root: { kind: "directory", dir }, path };
    const declared = typeof output === "string"
      ? JSON.parse(definitionAssets.read(resolveAssetRef(location, output)))
      : output;
    metadata.set(record.definitionId, { id: posix.basename(path, ".md"), ...(content.description === undefined ? {} : { description: content.description }) });
    const { runs: _runs, ...keys } = phase;
    return {
      ...keys,
      name: record.keys.name ?? content.name,
      brief: parsed.body,
      dependencies: step?.dependencies ?? content.dependencies ?? [],
      subagents: step?.agents ?? content.subagents ?? content.agents ?? [],
      ...(declared === undefined ? {} : { output: declared }),
    };
  };
  const temporary: WorkflowDefinition = {
    ...workflow,
    phases: nonEmpty(workflow.phases.map((entry) => isRepeat(entry) ? { ...entry, phases: nonEmpty(entry.phases.map(inline)) } : inline(entry))),
  };
  const origin: AssetLocation = { root: { kind: "directory", dir: dirname(file) }, path: basename(file) };
  const inputContract = loadWorkflowInputContract(workflow, origin);
  const loaded = loadBriefs(temporary, origin, definitionAssets, inputContract).briefs;
  const briefs = new Map<string, LoadedBrief>();
  for (const [definitionId, brief] of loaded) {
    const kept = metadata.get(definitionId);
    if (!kept) {
      briefs.set(definitionId, brief);
      continue;
    }
    briefs.set(definitionId, { ...brief, briefId: kept.id, procedure: { ...brief.procedure, ...(kept.description === undefined ? {} : { description: kept.description }) } });
  }
  return { ...workflow, inputContract, briefs };
}
