import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js";
import { extractToolContentFact } from "../../../src/infra/tool-content-extraction.js";
import type { ProviderRequestAuditFact } from "../../../src/orchestration/session/provider-request-audit-facts.js";
import { recordProviderRequest, recordProviderRequestDispatched, recordProviderResponse, type ConversationDedup } from "../../../src/orchestration/session/provider-request-audit-recorder.js";
import type { ProviderRequestAuditTool, RecordedInteractionProfileId } from "../../../src/orchestration/session/provider-request-audit-types.js";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeToolOutcomes, TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION } from "../../../bench/terminal_bench/analyze-tool-outcomes.js";
import { finalizeTerminalBenchRun } from "../../../bench/terminal_bench/run-terminal-bench.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

const profile = "default" satisfies RecordedInteractionProfileId;
const sourceDigest = "a".repeat(64);
const profileDigest = "b".repeat(64);
const systemPrompt = "benchmark prompt";
const tools: ProviderRequestAuditTool[] = [{ name: "shell", registrationId: "shell", executableId: "bash", description: "Run a command", input_schema: { type: "object" }, kind: "function", inputFormatSha256: "c".repeat(64) }];
const sessionId = "session-1";
const conversationId = "conversation-1";
const identity = { providerSessionKey: "provider-session-1", conversationId };
const requestIds = ["request-1", "request-2"] as const;

interface TestEventPayload {
  readonly [key: string]: unknown
}

/** A stored audit row. A rewrite can leave the writer's schema on purpose. */
interface AuditRow {
  readonly type: string
  readonly version: number
  readonly actor: string
  readonly payload: TestEventPayload
}

interface EvidenceOptions {
  /** Rewrites or drops one audit fact the real recorder built; undefined drops it. */
  auditFact?: (fact: ProviderRequestAuditFact) => AuditRow | undefined
  /** A profile that an earlier build recorded, in place of the expected one. */
  requestProfile?: RecordedInteractionProfileId
  providerToolName?: string
  toolName?: string
  toolVersion?: number
  settled?: boolean
  resultModelRequestId?: string | null
  includeMessages?: boolean
  dispatched?: boolean
  responded?: boolean
  conflictingAuditSession?: boolean
}

function manifest() {
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
 *  call. The audit facts come from the live recorder functions, so the
 *  fixture follows the current fact versions and identity shape. The recorder
 *  writes the tool surface only for the first request; the second request
 *  shares it by hash. The second tool result is large, so it is stored in the
 *  version 2 content-reference shape. */
async function evidence(options: EvidenceOptions = {}): Promise<{ root: string; manifestPath: string }> {
  const root = temporaryDirectory("tb-analyzer-");
  const trial = join(root, "trial");
  const agent = join(trial, "agent");
  const store = join(agent, "state", ".flywheel", "flywheel.sqlite");
  await mkdir(join(agent, "state", ".flywheel"), { recursive: true });
  await writeFile(join(trial, "result.json"), JSON.stringify({ task_name: "terminal-bench/task", trial_name: "trial-1", verifier_result: { rewards: { reward: 1 } }, agent_result: { cost_usd: 1 } }));
  const db = createSqliteEventStore(store);
  const aggregateId = `session:${sessionId}`;
  const append = (eventAggregateId: string, type: string, version: number, actor: string, payload: TestEventPayload, eventSessionId = sessionId) => db.append({ aggregateId: eventAggregateId, sessionId: eventSessionId, type, version, actor, payload, timestamp: Date.now() });
  const appendAudit = (fact: ProviderRequestAuditFact) => {
    const profiled = options.requestProfile !== undefined && fact.type === "model.requested" && fact.version === 6 ? { ...fact, payload: { ...fact.payload, interactionProfileId: options.requestProfile } } : fact;
    const recorded: AuditRow | undefined = options.auditFact ? options.auditFact(profiled) : profiled;
    if (recorded) append(aggregateId, recorded.type, recorded.version, recorded.actor, recorded.payload);
  };
  const messages = [{ kind: "user", content: "benchmark request" }] as const;
  append(`conversation:${conversationId}`, "chat.tree.created", 1, "flywheel", { conversationId, createdAt: new Date().toISOString() });
  if (options.includeMessages !== false) append(`conversation:${conversationId}`, "chat.entries.appended", 1, "flywheel", { conversationId, entries: [{ id: "entry-1", parentId: null, timestamp: new Date().toISOString(), kind: "message", message: messages[0] }] });
  const dedup: ConversationDedup = {};
  for (const [index, requestId] of requestIds.entries()) {
    const last = index === requestIds.length - 1;
    const audit = { observe: appendAudit };
    await recordProviderRequest(audit, { requestId, identity, turn: 1, promptKind: "headless", systemPrompt, messages, messageCount: messages.length, estimatedContextTokens: 1, attemptStaticTokens: 1, contextWindow: 100, tools, omittedTools: [], interactionProfileId: profile, model: "gpt-6-luna", accessProvider: "openai", modelFamily: "gpt", treeLeafEntryId: "entry-1" }, dedup);
    if (!last || options.dispatched !== false) await recordProviderRequestDispatched(audit, { requestId, identity, turn: 1 });
    if (!last || options.responded !== false) await recordProviderResponse(audit, { requestId, identity, turn: 1, outcome: "ok", durationMs: 1 });
    const toolUseId = `tool-${index + 1}`;
    append(aggregateId, "tool.input.completed", options.toolVersion ?? 2, "agent", { toolUseId, providerCallId: `call-${index + 1}`, providerToolName: options.providerToolName ?? "shell", toolName: options.toolName ?? "bash", modelRequestId: requestId });
    if (last && options.settled === false) continue;
    const result = extractToolContentFact({ type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId, outcome: "ok", content: last ? "x".repeat(4096) : "done", ...(options.resultModelRequestId === null ? {} : { modelRequestId: options.resultModelRequestId ?? requestId }) } }).fact;
    append(aggregateId, result.type, result.version, result.actor, result.payload);
  }
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
  const runManifest = { ...manifest(), source_archive_sha256: sourceDigest };
  const manifestPath = join(root, "run_manifest.json");
  await writeFile(manifestPath, JSON.stringify(runManifest));
  return { root, manifestPath };
}

/** Rewrites the payload of one audit fact type and keeps every other fact. */
function rewrite(type: ProviderRequestAuditFact["type"], change: (payload: TestEventPayload) => TestEventPayload, requestId: string = requestIds[0]) {
  return (fact: ProviderRequestAuditFact): AuditRow => fact.type === type && fact.payload.requestId === requestId ? { ...fact, payload: change(fact.payload) } : fact;
}

describe("terminal bench tool outcome analyzer", () => {
  const analyze = (root: string) => analyzeToolOutcomes(root, { ...manifest(), source_archive_sha256: sourceDigest });

  test("accepts current recorder evidence whose later request shares the first tool surface", async () => {
    const valid = await evidence();
    const store = new Database(join(valid.root, "trial", "agent", "state", ".flywheel", "flywheel.sqlite"), { readonly: true });
    try {
      // The coverage rests on these two writer behaviors, so the fixture states them.
      expect(store.query("select payload ->> '$.requestId' as requestId from event where type = 'tool_surface.selected'").all()).toEqual([{ requestId: requestIds[0] }]);
      expect(store.query("select version, count(*) as count from event where type = 'tool.result.recorded' group by version order by version").all()).toEqual([{ version: 1, count: 1 }, { version: 2, count: 1 }]);
    } finally { store.close(); }
    const analysis = await analyze(valid.root);
    expect(analysis.infrastructureValid).toBeTrue();
    expect(analysis.rows[0]).toMatchObject({ requestAuditValid: true, commandObserved: true, toolSettlement: { inputs: 2, results: 2, missing: 0, orphan: 0, identityConflicts: 0 }, failure: null });
  });

  test("rejects a request profile, a refused audit chain, and unsettled tool evidence", async () => {
    for (const [invalid, failure] of [
      [{ requestProfile: "luna-shell-v1" }, "request_audit_invalid"],
      [{ auditFact: (fact: ProviderRequestAuditFact): AuditRow => fact.type === "model.requested" && fact.payload.requestId === requestIds[0] ? { ...fact, version: 4 } : fact }, "request_audit_invalid"],
      [{ dispatched: false }, "request_audit_invalid"],
      [{ responded: false }, "request_audit_invalid"],
      [{ settled: false }, "tool_settlement_invalid"],
      [{ toolVersion: 1 }, "request_audit_invalid"],
    ] as const) {
      const fixture = await evidence(invalid);
      const analysis = await analyze(fixture.root);
      expect(analysis.infrastructureValid).toBeFalse();
      expect(analysis.rows[0]?.failure).toBe(failure);
    }
  });

  test("joins tool inputs to the audited provider and executable identities before counting command evidence", async () => {
    for (const invalid of [
      { providerToolName: "bash", toolName: "bash" },
      { providerToolName: "shell", toolName: "shell" },
      { providerToolName: "unknown", toolName: "bash" },
    ]) {
      const fixture = await evidence(invalid);
      const row = (await analyze(fixture.root)).rows[0];
      expect(row).toMatchObject({ commandObserved: false, failure: "tool_settlement_invalid" });
    }
  });

  test("rejects a request id whose audit facts cross sessions", async () => {
    const fixture = await evidence({ conflictingAuditSession: true });
    const row = (await analyze(fixture.root)).rows[0];
    expect(row).toMatchObject({ storeValid: true, requestAuditValid: false, failure: "request_audit_invalid" });
  });

  test("accepts a uniquely joined result without the optional model request id", async () => {
    const fixture = await evidence({ resultModelRequestId: null });
    const row = (await analyze(fixture.root)).rows[0];
    expect(row).toMatchObject({ requestAuditValid: true, toolSettlement: { missing: 0, orphan: 0, identityConflicts: 0 }, failure: null });
  });

  test("rejects missing, malformed, and mismatched body evidence", async () => {
    for (const auditFact of [
      rewrite("prompt.assembled", ({ systemPrompt: _, ...payload }) => payload),
      rewrite("prompt.assembled", (payload) => ({ ...payload, systemPrompt: "tampered" })),
      (fact: ProviderRequestAuditFact) => fact.type === "tool_surface.selected" ? undefined : fact,
      rewrite("tool_surface.selected", (payload) => ({ ...payload, tools: tools.map((tool) => ({ ...tool, description: "tampered" })) })),
      rewrite("tool_surface.selected", (payload) => ({ ...payload, identity: { ...identity, conversationId: "other-conversation" } })),
    ]) {
      const fixture = await evidence({ auditFact });
      expect((await analyze(fixture.root)).rows[0]).toMatchObject({ storeValid: true, requestAuditValid: false, failure: "request_audit_invalid" });
    }
  });

  test("rejects forged prompt hashes and missing durable messages", async () => {
    for (const invalid of [{ auditFact: rewrite("prompt.assembled", (payload) => ({ ...payload, promptSha256: "0".repeat(64) }), requestIds[1]) }, { includeMessages: false }]) {
      const fixture = await evidence(invalid);
      expect((await analyze(fixture.root)).rows[0]).toMatchObject({ requestAuditValid: false, failure: "request_audit_invalid" });
    }
  });

  test("finalization persists the current analyzer digest and refuses invalid evidence", async () => {
    const valid = await evidence();
    const ledger = await finalizeTerminalBenchRun(valid.manifestPath, valid.root, 0);
    const finalized = JSON.parse(await readFile(valid.manifestPath, "utf8"));
    expect(ledger.reconciled).toBeTrue();
    expect(finalized.state).toBe("finalized");
    expect(finalized.analyzer_result.summary).toMatchObject({ version: 1, contract_version: TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION, result_version: 2, infrastructure_valid: true, denominator: 1, failure_counts: {} });
    expect(finalized.analyzer_result.summary.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(finalized.analyzer_result.analysis).toEqual(await analyzeToolOutcomes(valid.root, finalized));

    const invalid = await evidence({ requestProfile: "luna-shell-v1" });
    const rejected = await finalizeTerminalBenchRun(invalid.manifestPath, invalid.root, 0);
    const refused = JSON.parse(await readFile(invalid.manifestPath, "utf8"));
    expect(rejected.reconciled).toBeFalse();
    expect(refused.state).toBe("refused");
    expect(refused.analyzer_result).toBeNull();
  });

  test("finalization records a hosted agent timeout without a summary as cancelled and refuses every other missing or malformed summary", async () => {
    const finalize = async (executionMode: "hosted" | "local", summary: string | undefined, exception = "AgentTimeoutError") => {
      const root = temporaryDirectory("tb-hosted-timeout-");
      await mkdir(join(root, "trials", "trial", "agent"), { recursive: true });
      await writeFile(join(root, "trials", "trial", "result.json"), JSON.stringify({ task_name: "terminal-bench/task", trial_name: "trial-1", verifier_result: { rewards: { reward: 0 } }, exception_info: { exception_type: exception } }));
      if (summary !== undefined) await writeFile(join(root, "trials", "trial", "agent", "flywheel-run-summary.json"), summary);
      const manifestPath = join(root, "run_manifest.json");
      await writeFile(manifestPath, JSON.stringify({ ...manifest(), execution_mode: executionMode, source_archive_sha256: sourceDigest }));
      const ledger = await finalizeTerminalBenchRun(manifestPath, join(root, "trials"), 0);
      return { ledger, manifest: JSON.parse(await readFile(manifestPath, "utf8")) };
    };
    const hosted = await finalize("hosted", undefined);
    expect(hosted.ledger).toMatchObject({ reconciled: true, outcome: "completed", counts: { cancelled: 1 } });
    expect(hosted.manifest).toMatchObject({ state: "finalized", source_archive_sha256: sourceDigest });
    expect(hosted.manifest.analyzer_result.analysis.rows[0]).toMatchObject({ failure: "hosted_agent_timeout" });
    for (const refused of [await finalize("local", undefined), await finalize("hosted", "{not json"), await finalize("hosted", undefined, "RuntimeError")]) {
      expect(refused.ledger).toMatchObject({ reconciled: false, outcome: "trials_unverified" });
      expect(refused.manifest.state).toBe("refused");
    }
  });

  test("represents every missing expected trial and disables comparison", async () => {
    const fixture = await evidence();
    const analysis = await analyzeToolOutcomes(fixture.root, {
      ...manifest(),
      source_archive_sha256: sourceDigest,
      expected_trials: 2,
      attempts: 2,
      expected_rows: [{ task: "terminal-bench/task", attempt: 1 }, { task: "terminal-bench/task", attempt: 2 }],
    });
    expect(analysis).toMatchObject({ denominator: 2, infrastructureValid: false, comparisonAvailable: false });
    expect(analysis.rows).toHaveLength(2);
    expect(analysis.rows).toContainEqual(expect.objectContaining({ discovered: false, failure: "missing_trial" }));
  });

  test("classifies a missing store and an exported digest mismatch as an unreadable store", async () => {
    const missing = await evidence();
    await rm(join(missing.root, "trial", "agent", "state", ".flywheel", "flywheel.sqlite"));
    const mismatched = await evidence();
    const summaryPath = join(mismatched.root, "trial", "agent", "flywheel-run-summary.json");
    await writeFile(summaryPath, JSON.stringify({ ...JSON.parse(await readFile(summaryPath, "utf8")), evidence_sha256: "0".repeat(64) }));

    for (const fixture of [missing, mismatched]) {
      const analysis = await analyze(fixture.root);
      expect(analysis.infrastructureValid).toBeFalse();
      expect(analysis.rows).toEqual([expect.objectContaining({ storeValid: false, failure: "unreadable_store" })]);
    }
  });

  test("fails closed on empty campaigns, replaced expected rows, and malformed manifests", async () => {
    const fixture = await evidence();
    const base = { ...manifest(), source_archive_sha256: sourceDigest };
    await expect(analyzeToolOutcomes(fixture.root, { ...base, expected_trials: 0, requested_tasks: [], expected_rows: [] })).rejects.toThrow("invalid expected trial denominator");
    await expect(analyzeToolOutcomes(fixture.root, { ...base, expected_rows: [{ task: "terminal-bench/replaced", attempt: 1 }] })).rejects.toThrow("missing exact expected rows");
    await expect(analyzeToolOutcomes(fixture.root, { expected_trials: 2, attempts: 1, requested_tasks: ["terminal-bench/task"] })).rejects.toThrow("invalid expected trial denominator");
  });
});
