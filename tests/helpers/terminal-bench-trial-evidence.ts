/** One Terminal-Bench trial's evidence, built through the production
 *  recorders, shared by the analyzer unit tests and the standalone analyzer
 *  integration test. */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeTrialStore, TRIAL_STORE_ANALYSIS_NAME } from "../../bench/terminal_bench/trial-store-analysis.js";
import type { RuntimeEvent } from "../../src/infra/runtime-event-types.js";
import { mapRuntimeEventToSessionRuntimeFacts } from "../../src/infra/runtime-fact-mapper.js";
import { createSqliteEventStore } from "../../src/infra/sqlite-event-store.js";
import { extractToolContentFact } from "../../src/infra/tool-content-extraction.js";
import { emitToolInputComplete } from "../../src/orchestration/agent-runtime/emit.js";
import type { ProviderRequestAuditFact } from "../../src/orchestration/session/provider-request-audit-facts.js";
import { recordProviderRequest, recordProviderRequestDispatched, recordProviderResponse, type ConversationDedup } from "../../src/orchestration/session/provider-request-audit-recorder.js";
import type { ProviderRequestAuditTool, ProviderRequestOutcome, RecordedInteractionProfileId } from "../../src/orchestration/session/provider-request-audit-types.js";

const profile = "default" satisfies RecordedInteractionProfileId;
export const sourceDigest = "a".repeat(64);
const profileDigest = "b".repeat(64);
const systemPrompt = "benchmark prompt";
/** How each route presents the one shell tool, serves the request, and frames
 *  its history. The Claude engine names a tool by its MCP wire name, and its
 *  adapter maps a call back to the canonical name before Flywheel records it.
 *  It also writes system reminders into the conversation, which the prompt
 *  reconstruction labels through the installed module catalog. */
const routes = {
  openai: { wireName: "bash", serving: { model: "gpt-6-luna", accessProvider: "openai", modelFamily: "gpt" }, reminders: [] },
  claude: {
    wireName: "mcp__runtime__bash",
    serving: { model: "claude-sonnet-5.5", accessProvider: "claude_agent_sdk", modelFamily: "anthropic" },
    reminders: [{ kind: "user", content: "<system-reminder>\nThe model that answers is Sonnet 5.5, with the model ID claude-sonnet-5-5[1m].\n</system-reminder>", origin: "system", framing: "claude" }],
  },
} as const;
type Route = keyof typeof routes;
export const surface = (route: Route): ProviderRequestAuditTool[] => [{ name: routes[route].wireName, registrationId: "bash", executableId: "bash", description: "Run a command", input_schema: { type: "object" }, kind: "function", inputFormatSha256: "c".repeat(64) }];
const sessionId = "session-1";
const conversationId = "conversation-1";
export const identity = { providerSessionKey: "provider-session-1", conversationId };
export const requestIds = ["request-1", "request-2"] as const;

interface TestEventPayload {
  readonly [key: string]: unknown
}

/** A stored audit row. A rewrite can leave the writer's schema on purpose. */
export interface AuditRow {
  readonly type: string
  readonly version: number
  readonly actor: string
  readonly payload: TestEventPayload
}

export interface EvidenceOptions {
  route?: Route
  /** Rewrites or drops one audit fact the real recorder built; undefined drops it. */
  auditFact?: (fact: ProviderRequestAuditFact) => AuditRow | undefined
  /** A profile that an earlier build recorded, in place of the expected one. */
  requestProfile?: RecordedInteractionProfileId
  /** The tool call as the dispatcher hands it to the recorder: the canonical
   *  name, and the name the model wrote when the dispatcher repaired it. */
  toolCall?: { name: string; repairedFrom?: string }
  toolVersion?: number
  settled?: boolean
  resultModelRequestId?: string | null
  resultVersion?: number
  includeMessages?: boolean
  dispatched?: boolean
  responded?: boolean
  /** The outcome of the last provider response. */
  finalOutcome?: ProviderRequestOutcome
  /** The estimated cost of each priced usage entry the run measured. */
  pricedUsageUsd?: readonly number[]
  conflictingAuditSession?: boolean
}

/** One measured attempt as the current writer records it, priced at `estimatedUsd`. */
function usageMeasured(index: number, estimatedUsd: number): TestEventPayload {
  return {
    attemptId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, occurredAt: "2026-11-07T00:00:00.000Z", profileId: "benchmark",
    attribution: { kind: "candidate", providerId: "openai_api", instanceId: "00000000-0000-4000-8000-000000000000" }, spendMode: "direct_api",
    credentialLineage: "00000000-0000-4000-8000-000000000000", model: "gpt-6-luna", classification: "real_spend", coverage: "complete", currency: "USD",
    tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    price: { kind: "priced", estimatedUsd, rateCard: { "standard.input": 1 }, provenance: "fixture" }, budgetStreamId: "budget-stream-1",
  };
}

export function manifest() {
  return {
    version: 1,
    state: "prepared",
    expected_trials: 1,
    requested_tasks: ["terminal-bench/task"],
    attempts: 1,
    expected_rows: [{ task: "terminal-bench/task", attempt: 1 }],
    command_expectation: { version: 1, executable_tool_names: ["bash"], minimum_cardinality: 1 },
    expected_interaction_profile: profile,
    profile_sha256: profileDigest,
  };
}

/** One reward-1 trial with two provider requests, each followed by one shell
 *  call, in a trial directory under `root`. As the shim does, it writes the
 *  analysis of the trial store into the agent logs; the store itself stays
 *  outside them, at the returned `storePath`. The audit facts and the tool
 *  inputs come from the live recorder, emitter, and fact mapper, so the
 *  fixture follows the current fact versions and identity shape. The recorder
 *  writes the tool surface only for the first request; the second request
 *  shares it by hash. The second tool result is large, so it is stored in the
 *  version 2 content-reference shape. */
export async function trialEvidence(root: string, options: EvidenceOptions = {}): Promise<{ root: string; manifestPath: string; storePath: string }> {
  const trial = join(root, "trial");
  const agent = join(trial, "agent");
  const store = join(trial, "store", "flywheel.sqlite");
  await mkdir(agent, { recursive: true });
  await mkdir(join(trial, "store"));
  await writeFile(join(trial, "result.json"), JSON.stringify({ task_name: "terminal-bench/task", trial_name: "trial-1", verifier_result: { rewards: { reward: 1 } }, agent_result: { cost_usd: 1 } }));
  const db = createSqliteEventStore(store);
  const aggregateId = `session:${sessionId}`;
  const append = (eventAggregateId: string, type: string, version: number, actor: string, payload: TestEventPayload, eventSessionId = sessionId) => db.append({ aggregateId: eventAggregateId, sessionId: eventSessionId, type, version, actor, payload, timestamp: Date.now() });
  const appendAudit = (fact: ProviderRequestAuditFact) => {
    const profiled = options.requestProfile !== undefined && fact.type === "model.requested" && fact.version === 6 ? { ...fact, payload: { ...fact.payload, interactionProfileId: options.requestProfile } } : fact;
    const recorded: AuditRow | undefined = options.auditFact ? options.auditFact(profiled) : profiled;
    if (recorded) append(aggregateId, recorded.type, recorded.version, recorded.actor, recorded.payload);
  };
  const route = options.route ?? "openai";
  const messages = [{ kind: "user", content: "benchmark request" }, ...routes[route].reminders] as const;
  const entries = messages.map((message, index) => ({ id: `entry-${index + 1}`, parentId: index === 0 ? null : `entry-${index}`, timestamp: new Date().toISOString(), kind: "message", message }));
  const treeLeafEntryId = `entry-${entries.length}`;
  append(`conversation:${conversationId}`, "chat.tree.created", 1, "flywheel", { conversationId, createdAt: new Date().toISOString() });
  if (options.includeMessages !== false) append(`conversation:${conversationId}`, "chat.entries.appended", 1, "flywheel", { conversationId, entries });
  const dedup: ConversationDedup = {};
  for (const [index, requestId] of requestIds.entries()) {
    const last = index === requestIds.length - 1;
    const audit = { observe: appendAudit };
    await recordProviderRequest(audit, { requestId, identity, turn: 1, promptKind: "headless", systemPrompt, messages, messageCount: messages.length, estimatedContextTokens: 1, attemptStaticTokens: 1, contextWindow: 100, tools: surface(route), omittedTools: [], interactionProfileId: profile, ...routes[route].serving, treeLeafEntryId }, dedup);
    if (!last || options.dispatched !== false) await recordProviderRequestDispatched(audit, { requestId, identity, turn: 1 });
    if (!last || options.responded !== false) await recordProviderResponse(audit, { requestId, identity, turn: 1, outcome: last ? options.finalOutcome ?? "ok" : "ok", durationMs: 1 });
    const toolUseId = `tool-${index + 1}`;
    const inputs: RuntimeEvent[] = [];
    emitToolInputComplete((event) => inputs.push(event), { id: toolUseId, providerCallId: `call-${index + 1}`, modelRequestId: requestId, input: { command: "true" }, execution: { mode: "foreground", trace_kind: "tool" }, ...(options.toolCall ?? { name: "bash" }) });
    for (const input of inputs.flatMap(mapRuntimeEventToSessionRuntimeFacts)) append(aggregateId, input.type, options.toolVersion ?? input.version, input.actor, input.payload);
    if (last && options.settled === false) continue;
    const result = extractToolContentFact({ type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId, outcome: "ok", content: last ? "x".repeat(4096) : "done", ...(options.resultModelRequestId === null ? {} : { modelRequestId: options.resultModelRequestId ?? requestId }) } }).fact;
    append(aggregateId, result.type, options.resultVersion ?? result.version, result.actor, result.payload);
  }
  for (const [index, estimatedUsd] of (options.pricedUsageUsd ?? []).entries()) append(aggregateId, "model.usage.measured", 6, "provider", usageMeasured(index, estimatedUsd));
  if (options.conflictingAuditSession) await recordProviderResponse({ observe: (fact) => { append("session:session-2", fact.type, fact.version, fact.actor, fact.payload, "session-2"); } }, { requestId: requestIds[0], identity, turn: 1, outcome: "ok", durationMs: 1 });
  db.close();
  await chmod(store, 0o600);
  const bytes = await readFile(store);
  const storeStat = await stat(store);
  await writeFile(join(agent, "flywheel-run-summary.json"), JSON.stringify({
    version: 2,
    adapter_settlement: "normal",
    evidence_exported: true,
    project_root: "task_workspace",
    execution_cwd: "task_workspace",
    profile_sha256: profileDigest,
    source_archive_sha256: sourceDigest,
    evidence_sha256: createHash("sha256").update(bytes).digest("hex"),
    evidence_size: storeStat.size,
  }));
  await writeFile(join(agent, TRIAL_STORE_ANALYSIS_NAME), JSON.stringify(await analyzeTrialStore(store)));
  const runManifest = { ...manifest(), source_archive_sha256: sourceDigest };
  const manifestPath = join(root, "run_manifest.json");
  await writeFile(manifestPath, JSON.stringify(runManifest));
  return { root, manifestPath, storePath: store };
}

/** Rewrites the payload of one audit fact type and keeps every other fact. */
export function rewrite(type: ProviderRequestAuditFact["type"], change: (payload: TestEventPayload) => TestEventPayload, requestId: string = requestIds[0]) {
  return (fact: ProviderRequestAuditFact): AuditRow => fact.type === type && fact.payload.requestId === requestId ? { ...fact, payload: change(fact.payload) } : fact;
}
