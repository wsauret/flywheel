import { join } from "node:path";
import { Schema } from "effect";
import { BenchmarkAccountingSchema, BenchmarkCampaignIdentitySchema } from "./accounting/evidence.js";
import { createJsonFile, createJsonLinesLedger, readJsonFile, writeArtifactFile } from "./campaign/json-lines.js";
import { ensuredDirectoryUnder, realDirectoryUnder } from "./campaign/paths.js";
import type { RunStoreLocation } from "./scoring/run-store.js";

const DIRECTORY_LABEL = "The benchmark results directory";
const RepeatSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const RoutingFixtureSchema = Schema.Struct({ id: Schema.String, expected: Schema.Literals(["advisor", "no-advisor"]), prompt: Schema.String });
const RoutingConfigSchema = Schema.Struct({
  kind: Schema.Literal("chat-routing-config"),
  fixtures: Schema.Array(RoutingFixtureSchema),
  promptIdentity: Schema.String,
  routingGuidanceIdentity: Schema.String,
  routingGuidance: Schema.String,
  scoringVersion: Schema.String,
  variants: Schema.Array(Schema.Struct({ id: Schema.String, model: Schema.String, effort: Schema.String })),
  repeats: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  sourceIdentity: Schema.String,
  activeProfileCandidatePlan: Schema.Array(Schema.String),
  deadlineMs: Schema.Int.check(Schema.isGreaterThan(0)),
  identity: BenchmarkCampaignIdentitySchema,
});
const RoutingOutcomeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("dispatch"), persona: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("no-valid-dispatch") }),
  Schema.Struct({ kind: Schema.Literal("invalid-dispatch"), evidence: Schema.String }),
]);
const RoutingRunRecordSchema = Schema.Struct({
  kind: Schema.Literal("chat-routing-run"), variant: Schema.String, fixture: Schema.String, repeat: RepeatSchema,
  model: Schema.String, effort: Schema.String, durationMs: Schema.Int, accounting: BenchmarkAccountingSchema,
  outcome: RoutingOutcomeSchema,
});
const RoutingAttemptRecordSchema = Schema.Struct({
  kind: Schema.Literal("chat-routing-attempt"), attemptId: Schema.String, at: Schema.String,
  variant: Schema.String, fixture: Schema.String, repeat: RepeatSchema, model: Schema.String, effort: Schema.String,
  durationMs: Schema.Int,
  accounting: BenchmarkAccountingSchema,
  terminal: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("failed"), code: Schema.Literals(["runner-failed", "unexpected-error"]) }),
    Schema.Struct({ kind: Schema.Literal("provider-error"), code: Schema.Literals(["api-error", "api-overloaded", "transient-disconnect", "stream-stalled"]) }),
    Schema.Struct({ kind: Schema.Literal("timed-out"), timeoutMs: Schema.Int }),
    Schema.Struct({ kind: Schema.Literal("cancelled") }),
  ]),
});

export type RoutingConfig = typeof RoutingConfigSchema.Type;
export type RoutingRunRecord = typeof RoutingRunRecordSchema.Type;
export type RoutingAttemptRecord = typeof RoutingAttemptRecordSchema.Type;
const decodeRoutingConfig = Schema.decodeUnknownSync(RoutingConfigSchema, { onExcessProperty: "error" });

export interface RoutingRunStore {
  readonly directory: string;
  loadConfig(): Promise<RoutingConfig>;
  loadRuns(): Promise<RoutingRunRecord[]>;
  loadAttempts(): Promise<RoutingAttemptRecord[]>;
  appendRun(record: RoutingRunRecord): Promise<void>;
  appendAttempt(record: RoutingAttemptRecord): Promise<void>;
  writeArtifact(name: string, text: string): Promise<void>;
}

/** Opens or creates the strict Chat routing ledger. Completed rows alone authorize resume skips. */
export async function createRoutingRunStore(location: RunStoreLocation, config?: RoutingConfig): Promise<RoutingRunStore> {
  const directory = config
    ? await ensuredDirectoryUnder(location.resultsRoot, location.directory, DIRECTORY_LABEL)
    : await realDirectoryUnder(location.resultsRoot, location.directory, DIRECTORY_LABEL);
  const resolvedPath = async (name: string): Promise<string> => join(await realDirectoryUnder(location.resultsRoot, location.directory, DIRECTORY_LABEL), name);
  if (config) {
    const decodedConfig = decodeRoutingConfig(config);
    await createJsonFile(await resolvedPath("run-config.json"), `${JSON.stringify(decodedConfig, null, 2)}\n`).catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error(`Results directory already has a run config: ${directory}`);
      throw error;
    });
  }
  const runs = createJsonLinesLedger(resolvedPath.bind(undefined, "runs.jsonl"), RoutingRunRecordSchema, "repair");
  const attempts = createJsonLinesLedger(resolvedPath.bind(undefined, "attempts.jsonl"), RoutingAttemptRecordSchema, "reject");
  return {
    directory,
    async loadConfig() {
      const path = await resolvedPath("run-config.json");
      const text = await readJsonFile(path);
      if (text === undefined) throw new Error(`Missing run config: ${path}`);
      const decoded = decodeRoutingConfig(JSON.parse(text));
      const ids = decoded.variants.map(({ id }) => id);
      if (new Set(ids).size !== ids.length) throw new Error("Duplicate Chat routing variant IDs in persisted config");
      return decoded;
    },
    async loadRuns() {
      const rows = await runs.load();
      const keys = new Set<string>();
      for (const row of rows) {
        const key = `${row.variant}\u0000${row.fixture}\u0000${row.repeat}`;
        if (keys.has(key)) throw new Error(`Duplicate completed Chat routing cell: ${key}`);
        keys.add(key);
      }
      return rows;
    },
    async loadAttempts() {
      const rows = await attempts.load();
      const ids = new Set<string>();
      for (const row of rows) {
        if (ids.has(row.attemptId)) throw new Error(`Duplicate Chat routing attempt: ${row.attemptId}`);
        ids.add(row.attemptId);
      }
      return rows;
    },
    async appendRun(record) { await runs.append(record); },
    async appendAttempt(record) { await attempts.append(record); },
    async writeArtifact(name, text) { await writeArtifactFile(await resolvedPath(name), text); },
  };
}
