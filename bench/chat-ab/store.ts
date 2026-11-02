import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { BenchmarkAccountingSchema } from "../../src/orchestration/modules/development/benchmark/evidence.js";
import { createJsonFile, createJsonLinesLedger, readJsonFile, writeArtifactFile } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import { AcceptanceRecordSchema } from "./acceptance.js";

const Usd = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Seat = Schema.Struct({ role: Schema.String, model: Schema.String, effort: Schema.optional(Schema.String) });
const ProviderPlan = Schema.Struct({ model: Schema.String, providers: Schema.Array(Schema.String) });
const TaskIdentity = Schema.Struct({ id: Schema.String, stratum: Schema.String, contentIdentity: Schema.String, timeoutMs: Count });

/** Historical private-runner workflow and model-profile identities. Absent for a historical Chat cell. */
const WorkflowCellSchema = Schema.Struct({ kind: Schema.Literal("workflow"), workflow: Schema.String, modelProfileIdentity: Schema.String });

const TokenRowsSchema = Schema.Struct({ input: Count, cacheWrite: Count, cacheRead: Count, output: Count, reasoning: Count });
const ToolCallSchema = Schema.Struct({
  name: Schema.String,
  inputSha256: Schema.String,
  /** Hash of the input field that names what the call acts on (a path, a command, a pattern); null when the input has none. */
  mainArgumentSha256: Schema.NullOr(Schema.String),
});
/** Evidence only the SDK bridge arm records (section 9.3 item 5). The
 *  native arm leaves it absent; the bridge fills it when it exists. */
const BridgeEvidenceSchema = Schema.Struct({
  cliStartedRequests: Count,
  rotationsByTrigger: Schema.Record(Schema.String, Count),
  cliEffort: Schema.optional(Schema.String),
  cliThinking: Schema.optional(Schema.String),
  rateLimitUtilization: Schema.Array(Schema.Number),
});
/** One request of a conversation, recorded as ids,
 *  hashes, kinds, counts, and times only. A request that the CLI started
 *  itself (arm S) follows the Flywheel request after which the bridge saw it,
 *  and carries only its tag. */
const RequestRowSchema = Schema.Struct({
  index: Count,
  startedBy: Schema.Literals(["flywheel", "cli"]),
  /** Flywheel's prompt kind, `compaction`, or the tag of a request the CLI started. */
  purpose: Schema.String,
  /** The trigger of the bridge query this request started (arm S); null when it started none. */
  queryStart: Schema.NullOr(Schema.String),
  /** The hashes of the system text and of the tool descriptions and schemas, with the cell's paths and the tool prefix removed. */
  system: Schema.NullOr(Schema.String),
  tools: Schema.NullOr(Schema.String),
  stopReason: Schema.NullOr(Schema.String),
  /** The tool calls the response asked for: the size of its parallel batch. */
  toolCalls: Count,
  tokens: Schema.NullOr(Schema.Struct({ input: Count, cacheWrite: Count, cacheRead: Count, output: Count })),
  /** Epoch ms when provider I/O began. */
  dispatchedAt: Schema.NullOr(Count),
  durationMs: Schema.NullOr(Count),
  /** The highest rate-limit utilization the bridge read during the request (arm S). */
  utilization: Schema.NullOr(Schema.Number),
  /** The model that the response's `message_start` named. */
  responseModel: Schema.NullOr(Schema.String),
  /** The error tag, or the outcome of a request that did not end ok. */
  errorClass: Schema.NullOr(Schema.String),
});

/** The turns of one workflow step or one child session, in request order. */
const ConversationTurnsSchema = Schema.Struct({
  scope: Schema.Literals(["step", "child", "session"]),
  /** The step's binding id, the child's agent type, or `session` for requests outside any step. */
  label: Schema.String,
  /** The attempt id of a step's conversation. Absent for a child or session conversation, and in runs recorded before 2026-10-08. */
  stepId: Schema.optional(Schema.String),
  sessionId: Schema.String,
  requests: Count,
  stopReasons: Schema.Array(Schema.String),
  toolCalls: Schema.Array(ToolCallSchema),
  tokens: TokenRowsSchema,
  servingProviders: Schema.Array(Schema.String),
  models: Schema.Array(Schema.String),
  bridge: Schema.optional(BridgeEvidenceSchema),
  /** Each request in order. Absent in runs recorded before 2026-10-08. */
  requestRows: Schema.optional(Schema.Array(RequestRowSchema)),
});

const ConfigSchema = Schema.Struct({
  kind: Schema.Literal("chat-ab-config"),
  scoringVersion: Schema.String,
  /** The arm this campaign runs. `identity` hashes the whole arm directory;
   *  the baseline has none. A provider arm also names its provider and the
   *  auth profile that holds its one candidate. */
  arm: Schema.Struct({ id: Schema.String, identity: Schema.NullOr(Schema.String), provider: Schema.optional(Schema.String), profileId: Schema.optional(Schema.String) }),
  cell: Schema.optional(WorkflowCellSchema),
  /** What the chat agent is, apart from its seats: the Flywheel source the
   *  cell imports, the module composition, and the account skill packages. */
  agent: Schema.Struct({
    revision: Schema.String,
    sourceIdentity: Schema.String,
    accountSkillsIdentity: Schema.String,
    composedModules: Schema.Array(Schema.String),
    composedTools: Schema.Array(Schema.String),
    /** The hash of every setting a workflow campaign's cells read (workflowConfigIdentity). Absent in chat campaigns and in workflow campaigns created before 2026-10-08. */
    configIdentity: Schema.optional(Schema.String),
  }),
  tasks: Schema.Array(TaskIdentity),
  repeats: Count,
  chat: Seat,
  roles: Schema.Array(Seat),
  authProfile: Schema.String,
  profileId: Schema.String,
  authorityIncarnation: Schema.String,
  providerPlans: Schema.Array(ProviderPlan),
  createdAt: Schema.String,
});
export type CampaignConfig = typeof ConfigSchema.Type;

/** The agent a campaign ran, apart from its arm. Two campaigns pair only
 *  when this is equal, so the arm is the one difference between them. A
 *  workflow campaign's arm carries its provider and profile, so there the
 *  profile is the arm's difference and the pinned roles are the agent's. */
function agentIdentity(config: CampaignConfig): string {
  const { agent, chat, roles, scoringVersion, profileId, cell } = config;
  return JSON.stringify(cell ? { agent, chat, roles, scoringVersion, cell } : { agent, chat, roles, scoringVersion, profileId });
}

/** Why two campaigns cannot pair, or undefined when they can. The arm must
 *  be the one difference: the same agent, and for one arm id the same
 *  provider and auth profile, so a campaign never pairs with a run of its own
 *  arm on another account or provider by accident. */
export function comparabilityProblem(baseline: CampaignConfig, candidate: CampaignConfig): string | undefined {
  if ((baseline.cell === undefined) !== (candidate.cell === undefined)) return "One campaign ran chat cells and the other ran workflow cells";
  const { arm: left } = baseline;
  const { arm: right } = candidate;
  if (left.id === right.id && (left.provider !== right.provider || left.profileId !== right.profileId)) return `Both campaigns ran arm ${left.id}, on ${left.provider ?? "no pinned provider"} with profile ${left.profileId ?? "unrecorded"} and on ${right.provider ?? "no pinned provider"} with profile ${right.profileId ?? "unrecorded"}`;
  if (agentIdentity(baseline) !== agentIdentity(candidate)) return "The campaigns ran different agents (Flywheel source, modules, account skills, settings, seats, model profile, or profile); run a new baseline on the candidate's revision";
  return undefined;
}

/** Why two workflow campaigns cannot pair as a comparison of models, or
 *  undefined when they can. The seats and the model profile are the one
 *  difference: the Flywheel source, modules, account skills, scoring, the
 *  workflow, and the arm with its provider and profile must all be equal. */
export function modelComparisonProblem(baseline: CampaignConfig, candidate: CampaignConfig): string | undefined {
  if (!baseline.cell || !candidate.cell) return "A model comparison pairs two workflow campaigns";
  if (baseline.cell.workflow !== candidate.cell.workflow) return `The campaigns ran the ${baseline.cell.workflow} and ${candidate.cell.workflow} workflows`;
  if (JSON.stringify(baseline.arm) !== JSON.stringify(candidate.arm)) return `The campaigns ran different arms: ${JSON.stringify(baseline.arm)} and ${JSON.stringify(candidate.arm)}`;
  const shared = ({ agent, scoringVersion }: CampaignConfig) => JSON.stringify({ agent, scoringVersion });
  if (shared(baseline) !== shared(candidate)) return "The campaigns ran different Flywheel source, modules, account skills, or scoring; run every model on one revision";
  return undefined;
}

/** How the tasks of campaigns that are compared line up. A task pairs only
 *  when every campaign ran it with the same content, so an edit to a task's
 *  message or acceptance tests between campaigns never mixes two versions
 *  of the task in one comparison. A task that some campaign did not run is
 *  in neither list. */
interface PairedTasks {
  /** Tasks that every campaign ran with the same content. */
  readonly shared: readonly string[];
  /** Tasks that every campaign ran, but not with the same content. */
  readonly changed: readonly string[];
}

export function pairedTasks(configs: readonly CampaignConfig[]): PairedTasks {
  const [first, ...others] = configs;
  const inEvery = (first?.tasks ?? []).filter((task) => others.every((config) => config.tasks.some((other) => other.id === task.id)));
  const same = (task: CampaignConfig["tasks"][number]) => others.every((config) => config.tasks.find((other) => other.id === task.id)?.contentIdentity === task.contentIdentity);
  return { shared: inEvery.filter(same).map((task) => task.id), changed: inEvery.filter((task) => !same(task)).map((task) => task.id) };
}

const RunSchema = Schema.Struct({
  kind: Schema.Literal("chat-ab-run"),
  task: Schema.String,
  repeat: Count,
  at: Schema.String,
  terminal: Schema.String,
  /** The outcome of each of the task's baseline acceptance tests; scoreAcceptance derives the score. */
  acceptance: AcceptanceRecordSchema,
  costUsd: Schema.NullOr(Usd),
  billedUsd: Schema.NullOr(Usd),
  parentCostUsd: Schema.NullOr(Usd),
  accounting: BenchmarkAccountingSchema,
  parentAccounting: BenchmarkAccountingSchema,
  agentMs: Count,
  wallMs: Count,
  requests: Schema.Struct({ parent: Count, total: Count }),
  /** "Approved" replies the cell sent after a turn that ended with an untouched checkout. */
  approvalReplies: Count,
  childDispatches: Count,
  /** Dispatches from the subagent tool's log lines, an independent count beside `childDispatches`. */
  loggedDispatches: Schema.Array(Schema.Struct({ agentType: Schema.String, model: Schema.String })),
  children: Schema.Array(Schema.Struct({ agentType: Schema.String, model: Schema.String, effort: Schema.optional(Schema.String), status: Schema.String })),
  byModel: Schema.Array(Schema.Struct({ model: Schema.String, provider: Schema.String, spendMode: Schema.String, classification: Schema.String, entries: Count, estimatedUsd: Usd })),
  diffStats: Schema.Struct({ linesAdded: Count, linesRemoved: Count, filesTouched: Count }),
  tools: Schema.Array(Schema.String),
  globalWrites: Schema.Array(Schema.String),
  artifactDir: Schema.String,
  /** Every spelling (as created, and the real path) of the cell's temporary
   *  directories: its sandbox project and its homes. The judge's inputs hide
   *  them (judge-inputs.ts). */
  cellDirectories: Schema.Struct({ project: Schema.Array(Schema.String), home: Schema.Array(Schema.String) }),
  /** A workflow cell's turns. A cell that failed its postflight is an attempt, never a run. */
  workflow: Schema.optional(Schema.Struct({ turns: Schema.Array(ConversationTurnsSchema) })),
});
export type RunRecord = typeof RunSchema.Type;

/** The estimated-equivalent USD of an accounting, or null when a price is missing. */
export function observedUsd(observation: RunRecord["accounting"]["estimatedUsd"]): number | null {
  return observation.kind === "observed" ? observation.value : null;
}

const AttemptSchema = Schema.Struct({
  kind: Schema.Literal("chat-ab-attempt"),
  attemptId: Schema.String,
  at: Schema.String,
  task: Schema.String,
  repeat: Count,
  reason: Schema.Literals(["provider-error", "runner-error", "cell-crashed", "cell-killed", "provision-failed", "capture-failed", "preflight-failed", "postflight-failed"]),
  terminal: Schema.optional(Schema.String),
  /** A workflow cell's postflight (section 9.2 item 6): each request that named
   *  another model or reached another provider. One makes the cell invalid,
   *  whatever its ending, and stop rule 4 reads it. */
  mismatches: Schema.optional(Schema.Array(Schema.String)),
  costUsd: Schema.NullOr(Usd),
  wallMs: Count,
  artifactDir: Schema.String,
});
export type AttemptRecord = typeof AttemptSchema.Type;

export interface CampaignStore {
  readonly directory: string;
  loadConfig(): Promise<CampaignConfig | undefined>;
  createConfig(config: CampaignConfig): Promise<void>;
  readonly runs: ReturnType<typeof createJsonLinesLedger<RunRecord>>;
  readonly attempts: ReturnType<typeof createJsonLinesLedger<AttemptRecord>>;
  writeArtifact(name: string, text: string): Promise<void>;
}

/** Historical inspection rejects corrupt tails and exposes no publication or append operations. */
export function historicalCampaignStore(directory: string): Pick<CampaignStore, "directory" | "loadConfig"> & {
  readonly runs: Pick<CampaignStore["runs"], "load">;
  readonly attempts: Pick<CampaignStore["attempts"], "load">;
} {
  const at = (name: string) => async () => join(directory, name);
  return {
    directory,
    async loadConfig() {
      const text = await readJsonFile(join(directory, "run-config.json"));
      return text === undefined ? undefined : Schema.decodeUnknownSync(ConfigSchema, { onExcessProperty: "error" })(JSON.parse(text));
    },
    runs: { load: createJsonLinesLedger(at("runs.jsonl"), RunSchema, "reject").load },
    attempts: { load: createJsonLinesLedger(at("attempts.jsonl"), AttemptSchema, "reject").load },
  };
}

/** Append-only campaign directory with the same authorities as the persona
 *  faces: runs.jsonl completes a cell, and attempts.jsonl accounts every
 *  unsuccessful attempt, which resume retries. */
export async function openCampaignStore(directory: string): Promise<CampaignStore> {
  await mkdir(directory, { recursive: true });
  const at = (name: string) => async () => join(directory, name);
  const decodeConfig = Schema.decodeUnknownSync(ConfigSchema, { onExcessProperty: "error" });
  return {
    directory,
    async loadConfig() {
      const text = await readJsonFile(join(directory, "run-config.json"));
      return text === undefined ? undefined : decodeConfig(JSON.parse(text));
    },
    async createConfig(config) {
      await createJsonFile(join(directory, "run-config.json"), `${JSON.stringify(decodeConfig(config), null, 2)}\n`);
    },
    runs: createJsonLinesLedger(at("runs.jsonl"), RunSchema, "repair"),
    attempts: createJsonLinesLedger(at("attempts.jsonl"), AttemptSchema, "reject"),
    writeArtifact: (name, text) => writeArtifactFile(join(directory, name), text),
  };
}
