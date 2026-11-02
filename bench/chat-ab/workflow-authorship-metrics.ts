import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { bytesIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import type { HeadlessBenchmarkExecution } from "../../src/orchestration/modules/development/benchmark/headless-execution-contract.js";
import { writeArtifactFile } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import { parseDefinitionProvenanceFact } from "../../src/workflows/definition-provenance-facts.js";
import { hashDefinition } from "../../src/workflows/definition-hash.js";
import { canonicalWorkflowRecord } from "../../src/workflows/definition-records.js";
import { decodeWorkflowFile } from "../../src/workflows/workflow-file.js";
import { allPhases, namedAgents, WorkflowDefinitionSchema } from "../../src/workflows/workflow-schema.js";
import { replayWorkflowControl } from "../../src/workflows/vm/fact-fold.js";
import { roundOfNodeId } from "../../src/workflows/vm/graph-types.js";
import { REPO_ROOT } from "./harness-paths.js";

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const WorkflowAuthorshipMetricsSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("unavailable"), reason: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("observed"), workflows: Schema.Array(Schema.Struct({
    workflowId: Schema.String, definitionId: Schema.String, name: Schema.String,
    definitionSha256: Schema.String,
    sourceSha256: Schema.NullOr(Schema.String), frozenFile: Schema.NullOr(Schema.String),
    sourceKind: Schema.Literals(["frozen", "authored", "unavailable"]),
    phases: Schema.Array(Schema.String),
    labels: Schema.Array(Schema.String),
    agents: Schema.Array(Schema.Struct({ attemptId: Schema.String, definitionId: Schema.String, sessionId: Schema.String, state: Schema.String })),
    repeatRounds: Schema.Array(Schema.Struct({ repeatNodeId: Schema.String, rounds: Count })),
  })) }),
]);
export type WorkflowAuthorshipMetrics = typeof WorkflowAuthorshipMetricsSchema.Type;

const Row = Schema.Struct({
  source: Schema.String, sessionId: Schema.optionalKey(Schema.String), type: Schema.String,
  timestamp: Schema.Number,
  version: Schema.optionalKey(Schema.Int), actor: Schema.optionalKey(Schema.String),
  payload: Schema.Record(Schema.String, Schema.Unknown),
});
const definitionFact = (row: typeof Row.Type) => parseDefinitionProvenanceFact({ type: row.type, version: row.version, actor: row.actor, payload: row.payload });

/** Keep the original envelopes for the canonical workflow fact parser and replay. */
function workflowEvidenceRows(text: string) {
  return text.split("\n").filter((line) => line.trim()).map((line) => {
    const raw: unknown = JSON.parse(line);
    return { raw, row: Schema.decodeUnknownSync(Row)(raw) };
  });
}

/** Match the launched raw bytes, not a workflow's chosen name. The canonical hash proves that a saved file still
 * describes this launch: source files can be replaced or deleted after launch (path-workflow.ts). */
export function extractWorkflowAuthorship(workflowId: string, facts: string, source: string | null, frozen: ReadonlyMap<string, string>) {
  const rows = workflowEvidenceRows(facts).filter(({ row }) => row.source === "store" && row.sessionId === workflowId);
  const definitions = rows.filter(({ row }) => row.type === "definition.loaded").map(({ row }) => definitionFact(row));
  const loaded = definitions.find((fact) => fact.type === "definition.loaded" && fact.payload.kind === "workflow");
  if (!loaded || loaded.type !== "definition.loaded" || loaded.payload.kind !== "workflow") throw new Error(`Workflow ${workflowId} lacks its recorded definition`);
  const definition = Schema.decodeUnknownSync(WorkflowDefinitionSchema, { onExcessProperty: "error" })(loaded.payload.definition);
  const definitionSha256 = hashDefinition(canonicalWorkflowRecord(definition)).sha256;
  const decoded = source === null ? null : decodeWorkflowFile({ file: workflowId, content: source });
  const sourceSha256 = decoded?.ok && hashDefinition(canonicalWorkflowRecord(decoded.definition)).sha256 === definitionSha256 ? bytesIdentity(source!) : null;
  const frozenFile = sourceSha256 === null ? null : frozen.get(sourceSha256) ?? null;
  const control = replayWorkflowControl(rows.map(({ raw }) => raw));
  const started = control.attempts.filter((attempt) => attempt.conversationId !== null);
  const rounds = new Map<string, Set<number>>();
  for (const attempt of started) {
    const round = roundOfNodeId(attempt.logicalNodeId);
    if (round) {
      if (!rounds.has(round.repeatNodeId)) rounds.set(round.repeatNodeId, new Set());
      rounds.get(round.repeatNodeId)!.add(round.round);
    }
  }
  return {
    workflowId, definitionId: definition.id, name: definition.name, definitionSha256, sourceSha256, frozenFile,
    sourceKind: sourceSha256 === null ? "unavailable" as const : frozenFile ? "frozen" as const : "authored" as const,
    phases: allPhases(definition).map(({ phase }) => phase.phase),
    labels: allPhases(definition).flatMap(({ phase }) => [
      phase.phase, ...(phase.name ? [phase.name] : []),
      ...namedAgents(phase).flatMap((agent) => [agent.agent, ...(agent.name ? [agent.name] : [])]),
    ]),
    agents: started.map((attempt) => ({ attemptId: attempt.id, definitionId: attempt.definitionId, sessionId: attempt.conversationId!, state: attempt.state._tag })),
    repeatRounds: [...rounds].map(([repeatNodeId, indexes]) => ({ repeatNodeId, rounds: indexes.size })),
  };
}

/** The benchmark-owned directory is the complete frozen-source authority. */
async function frozenWorkflowHashes() {
  const directory = join(REPO_ROOT, "bench/chat-ab/workflow-authorship/handcrafted");
  return new Map(await Promise.all((await readdir(directory)).filter((name) => name.endsWith(".workflow.yaml")).sort().map(async (name) =>
    [bytesIdentity(await readFile(join(directory, name))), `bench/chat-ab/workflow-authorship/handcrafted/${name}`] as const)));
}

/** Supplement canonical request evidence with the launched runs' durable control and immutable definition facts.
 * Missing accounting never becomes an empty workflow list. Saved files that changed after launch stay unknown. */
export async function captureWorkflowAuthorship(result: HeadlessBenchmarkExecution, directory: string,
  search: (sessionId: string | undefined, type: string, path: string) => Promise<{ stdout: HeadlessBenchmarkExecution["artifacts"][string]; stderr: HeadlessBenchmarkExecution["artifacts"][string] }>,
): Promise<WorkflowAuthorshipMetrics> {
  if (result.evidence.kind !== "observed") return { kind: "unavailable", reason: "Canonical descendant evidence unavailable" };
  const registrations = await search(undefined, "workflow.run.registered", join(directory, "workflow-launches.jsonl"));
  Object.assign(result.artifacts, { workflowLaunches: registrations.stdout, workflowLaunchesStderr: registrations.stderr });
  const parents = new Set(result.evidence.value.sessions.map(({ sessionId }) => sessionId));
  const launched = workflowEvidenceRows(await readFile(registrations.stdout.path, "utf8"))
    .filter(({ row }) => row.source === "store" && typeof row.payload.launchedFrom === "object" && row.payload.launchedFrom !== null &&
      "parentSessionId" in row.payload.launchedFrom && parents.has(String(row.payload.launchedFrom.parentSessionId)));
  const frozen = await frozenWorkflowHashes();
  const workflows = [];
  for (const { row } of launched) {
    const workflowId = row.sessionId;
    if (!workflowId) throw new Error("Workflow registration has no workflow id");
    const captured = await search(workflowId, "*", join(directory, `workflow-${workflowId}.jsonl`));
    Object.assign(result.artifacts, { [`workflow-${workflowId}`]: captured.stdout, [`workflow-${workflowId}-stderr`]: captured.stderr });
    const facts = await readFile(captured.stdout.path, "utf8");
    const loaded = workflowEvidenceRows(facts).find(({ row: fact }) => fact.source === "store" && fact.type === "definition.loaded" && fact.payload.kind === "workflow");
    const definition = loaded && definitionFact(loaded.row);
    let source: string | null = null;
    if (definition?.type === "definition.loaded" && definition.payload.kind === "workflow" && definition.payload.provenance) {
      try {
        const path = definition.payload.provenance.filePath;
        const [content, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
        // A session can reuse a saved path, including an edit that changes only YAML formatting.
        if (metadata.mtimeMs <= loaded!.row.timestamp) source = content;
      }
      catch (error) {
        if (typeof error !== "object" || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
      }
    }
    const extracted = extractWorkflowAuthorship(workflowId, facts, source, frozen);
    if (source !== null) {
      const path = join(directory, `workflow-${workflowId}.yaml`);
      await writeArtifactFile(path, source);
      Object.assign(result.artifacts, { [`workflow-source-${workflowId}`]: { path, sha256: bytesIdentity(source), bytes: Buffer.byteLength(source) } });
    }
    workflows.push(extracted);
  }
  return { kind: "observed", workflows };
}
