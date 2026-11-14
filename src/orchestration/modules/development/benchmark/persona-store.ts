import { join } from "node:path";
import { Schema } from "effect";
import { openCampaignLedger } from "./campaign-ledger.js";
import { structuredIdentity } from "./content-identity.js";
import { readJsonFile, writeArtifactFile } from "./json-lines.js";
import { ensuredDirectoryUnder, realDirectoryUnder } from "./paths.js";
import { PersonaRecordSchemas, type RunConfig, type RunStore, type RunStoreLocation } from "./run-store.js";
import { validateAttempts, validateJudgeAttempts, validateRuns, validateScoreCells } from "./persona-evidence-validation.js";
import { renderCampaignRoleChanges, type CampaignRoleComparison } from "./campaign-role-changes.js";

const RolesSchema = Schema.Record(Schema.String, Schema.Struct({ model: Schema.String, effort: Schema.String }));
const RoleRecordSchema = Schema.Struct({
  kind: Schema.Literal("cell-roles"),
  variant: Schema.String, task: Schema.String, repeat: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  directory: Schema.String, profileId: Schema.String, authorityIncarnation: Schema.String,
  roles: Schema.NullOr(RolesSchema),
});
const ManifestSchema = Schema.Struct({
  kind: Schema.Literal("persona-benchmark"), version: Schema.Literal(1),
  config: PersonaRecordSchemas.config, taskIds: Schema.Array(Schema.String),
});
const EventSchema = Schema.Union([
  RoleRecordSchema, PersonaRecordSchemas.run, PersonaRecordSchemas.attempt, PersonaRecordSchemas.judgeAttempt, PersonaRecordSchemas.score,
]);
type Manifest = typeof ManifestSchema.Type;
type Event = typeof EventSchema.Type;
type PersonaRoleRecord = typeof RoleRecordSchema.Type;

export interface PersonaStore extends RunStore {
  readonly taskIds: readonly string[];
  appendRoles(record: PersonaRoleRecord): Promise<void>;
  roleReport(): Promise<string>;
}

/** Historical split-ledger results have no writable persona campaign contract. They remain readable through the report command. */
async function readPersonaManifest(location: RunStoreLocation): Promise<Manifest> {
  const directory = await realDirectoryUnder(location.resultsRoot, location.directory, "The benchmark results directory");
  const text = await readJsonFile(join(directory, "campaign.json"));
  if (text === undefined) {
    if (await readJsonFile(join(directory, "run-config.json")) !== undefined) {
      throw new Error("Historical persona results are read-only; use --report or start a new results directory");
    }
    throw new Error(`No persona campaign at ${directory}`);
  }
  return Schema.decodeUnknownSync(ManifestSchema, { onExcessProperty: "error" })(JSON.parse(text));
}

function validate(manifest: Manifest, events: readonly Event[]): void {
  const plan = { ...manifest.config, tasks: manifest.taskIds.map(id => ({ id })) };
  const tasks = new Set(manifest.taskIds);
  if (tasks.size === 0 || tasks.size !== manifest.taskIds.length) throw new Error("Persona campaign task IDs must be nonempty and unique");
  if (new Set(plan.variants.map(({ id }) => id)).size !== plan.variants.length) throw new Error("Persona campaign variant IDs must be unique");
  validateRuns(plan, tasks, events.filter(event => event.kind === "agent-run"));
  validateAttempts(plan, tasks, events.filter(event => event.kind === "agent-run-attempt"));
  validateJudgeAttempts(plan, tasks, events.filter(event => event.kind === "judge-attempt"));
  validateScoreCells(plan, tasks, events.filter(event => event.kind === "pair-score" || event.kind === "review-score" || event.kind === "trap-score" || event.kind === "research-score"));
  for (const event of events) {
    if (event.kind === "cell-roles" && (!tasks.has(event.task) || !plan.variants.some(({ id }) => id === event.variant) || event.repeat >= plan.repeats)) {
      throw new Error("Role evidence names an unscheduled persona cell");
    }
  }
}

/** The shared versioned manifest and reject-tail ledger own all new persona evidence. Profile identity is per cell, not a resume restriction. */
export async function createPersonaStore(location: RunStoreLocation, config?: RunConfig, taskIds?: readonly string[]): Promise<PersonaStore> {
  const directory = config
    ? await ensuredDirectoryUnder(location.resultsRoot, location.directory, "The benchmark results directory")
    : await realDirectoryUnder(location.resultsRoot, location.directory, "The benchmark results directory");
  const expected = config ? { kind: "persona-benchmark" as const, version: 1 as const, config, taskIds: [...taskIds ?? []] } : undefined;
  if (!expected) await readPersonaManifest(location);
  const ledger = await openCampaignLedger(directory, {
    manifest: ManifestSchema, events: EventSchema, validate,
    resolvePath: async name => join(await realDirectoryUnder(location.resultsRoot, directory, "The benchmark results directory"), name),
    identity: manifest => structuredIdentity({ content: manifest.config.identity.contentIdentity, tasks: manifest.taskIds }),
    requireWritable: () => {},
  }, expected);
  return {
    directory, taskIds: ledger.manifest.taskIds,
    async loadConfig() { return ledger.manifest.config; },
    async loadRuns() { return (await ledger.load()).filter(event => event.kind === "agent-run"); },
    async loadAttempts() { return (await ledger.load()).filter(event => event.kind === "agent-run-attempt"); },
    async loadJudgeAttempts() { return (await ledger.load()).filter(event => event.kind === "judge-attempt"); },
    async loadScores() { return (await ledger.load()).filter(event => event.kind === "pair-score" || event.kind === "review-score" || event.kind === "trap-score" || event.kind === "research-score"); },
    appendRun: ledger.append, appendAttempt: ledger.append, appendJudgeAttempt: ledger.append, appendScore: ledger.append, appendRoles: ledger.append,
    async writeArtifact(name, text) {
      await writeArtifactFile(join(await realDirectoryUnder(location.resultsRoot, directory, "The benchmark results directory"), name), text);
    },
    async roleReport() {
      const records = (await ledger.load()).filter(event => event.kind === "cell-roles");
      const baseline = records[0];
      const comparisons: CampaignRoleComparison[] = [];
      if (baseline) for (const candidate of records.slice(1)) {
        const roles = new Set([...Object.keys(baseline.roles ?? {}), ...Object.keys(candidate.roles ?? {})]);
        comparisons.push({
          baseline: { directory: baseline.directory, cell: `${baseline.variant}/${baseline.task}/${baseline.repeat}` },
          candidate: { directory: candidate.directory, cell: `${candidate.variant}/${candidate.task}/${candidate.repeat}` },
          unavailable: [
            ...(baseline.roles === null ? [{ side: "baseline" as const, kind: "normal" as const }] : []),
            ...(candidate.roles === null ? [{ side: "candidate" as const, kind: "normal" as const }] : []),
          ],
          changes: baseline.roles && candidate.roles ? [...roles].sort().flatMap(role => {
            const before = baseline.roles?.[role] ?? null;
            const after = candidate.roles?.[role] ?? null;
            return before?.model === after?.model && before?.effort === after?.effort ? [] : [{ kind: "normal" as const, role, before, after }];
          }) : [],
        });
      }
      return `${renderCampaignRoleChanges(comparisons)}\nRole snapshots and profile identities are retained for each cell attempt in events.jsonl.\n`;
    },
  };
}
