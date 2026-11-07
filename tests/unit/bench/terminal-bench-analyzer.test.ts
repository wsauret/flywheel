import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { ProviderRequestAuditFact } from "../../../src/orchestration/session/provider-request-audit-facts.js";
import type { RecordedInteractionProfileId } from "../../../src/orchestration/session/provider-request-audit-types.js";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeToolOutcomes, TOOL_OUTCOME_ANALYZER_CONTRACT_VERSION } from "../../../bench/terminal_bench/analyze-tool-outcomes.js";
import { finalizeTerminalBenchRun } from "../../../bench/terminal_bench/run-terminal-bench.js";
import { analyzeTrialStore, TRIAL_STORE_ANALYSIS_NAME, type TrialStoreAnalysis } from "../../../bench/terminal_bench/trial-store-analysis.js";
import { identity, manifest, requestIds, rewrite, sourceDigest, surface, trialEvidence, type AuditRow, type EvidenceOptions } from "../../helpers/terminal-bench-trial-evidence.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();
const evidence = (options?: EvidenceOptions) => trialEvidence(temporaryDirectory("tb-analyzer-"), options);
/** A profile that an earlier build recorded and the serving-model resolver no longer selects. */
const retiredProfile = "luna-shell-v1" satisfies RecordedInteractionProfileId;

describe("terminal bench tool outcome analyzer", () => {
  const analyze = (root: string) => analyzeToolOutcomes(root, { ...manifest(), source_archive_sha256: sourceDigest });

  test("accepts current recorder evidence whose later request shares the first tool surface, on every route", async () => {
    for (const route of ["openai", "claude"] as const) {
      const valid = await evidence({ route });
      const store = new Database(valid.storePath, { readonly: true });
      try {
        // The coverage rests on these two writer behaviors, so the fixture states them.
        expect(store.query("select payload ->> '$.requestId' as requestId from event where type = 'tool_surface.selected'").all()).toEqual([{ requestId: requestIds[0] }]);
        expect(store.query("select version, count(*) as count from event where type = 'tool.result.recorded' group by version order by version").all()).toEqual([{ version: 1, count: 1 }, { version: 2, count: 1 }]);
      } finally { store.close(); }
      expect(await analyzeTrialStore(valid.storePath)).toMatchObject({ requestAuditComplete: true, executableToolInputs: { bash: 2 }, toolSettlement: { identityConflicts: 0 }, finalRequestOutcome: "ok", estimatedCostUsd: null });
      const analysis = await analyze(valid.root);
      expect(analysis.infrastructureValid).toBeTrue();
      expect(analysis.rows[0]).toMatchObject({ requestAuditValid: true, commandObserved: true, toolSettlement: { inputs: 2, results: 2, missing: 0, orphan: 0, identityConflicts: 0 }, failure: null });
    }
  });

  test("records how the trial's model work ended and what its priced usage is estimated to cost", async () => {
    const stopped = await evidence({ finalOutcome: "context_overflow", pricedUsageUsd: [0.25, 0.125] });
    expect(await analyzeTrialStore(stopped.storePath)).toMatchObject({ finalRequestOutcome: "context_overflow", estimatedCostUsd: 0.375 });
    // A dispatched request that never got its response leaves the earlier response as the final one.
    expect(await analyzeTrialStore((await evidence({ responded: false })).storePath)).toMatchObject({ finalRequestOutcome: "ok" });
    // A stream error that the provider's content refusal ended is a refusal; any other stream error stays a fault.
    const refused = await evidence({ finalOutcome: "stream_error", finalError: { tag: "ContentRefused", message: "This content was flagged for possible cybersecurity risk." } });
    expect(await analyzeTrialStore(refused.storePath)).toMatchObject({ finalRequestOutcome: "refused" });
    const dropped = await evidence({ finalOutcome: "stream_error", finalError: { tag: "TransientDisconnect", message: "websocket closed" } });
    expect(await analyzeTrialStore(dropped.storePath)).toMatchObject({ finalRequestOutcome: "stream_error" });
    const answered = await evidence({ route: "claude", stopReasons: ["content_filter", "end_turn"] });
    expect(await analyzeTrialStore(answered.storePath)).toMatchObject({ finalRequestOutcome: "ok" });
  });

  test("records no refusal for a content-filter stop on which the loop still owed a retry", async () => {
    const outcome = async (options: EvidenceOptions) => (await analyzeTrialStore((await evidence({ route: "claude", ...options })).storePath)).finalRequestOutcome;
    // A trial that Harbor cancels while a retry is still owed ends on a served response, which its exception scores.
    expect(await outcome({ toolCalls: false, reward: 0, stopReasons: ["content_filter"] })).toBe("ok");
    expect(await outcome({ toolCalls: false, reward: 0, stopReasons: ["end_turn", "content_filter", "content_filter"] })).toBe("ok");
    // A stop with a tool call runs its tools, so it ends no turn.
    expect(await outcome({ stopReasons: ["content_filter", "content_filter", "content_filter"] })).toBe("ok");
  });

  test.each([
    ["the ChatGPT backend's policy refusal", { route: "openai", finalOutcome: "stream_error", finalError: { tag: "ContentRefused", message: "This content was flagged for possible cybersecurity risk." } }],
    ["the Anthropic content filter's stop that outlasted every retry", { route: "claude", stopReasons: ["content_filter", "content_filter", "content_filter"] }],
  ] as const satisfies readonly (readonly [string, EvidenceOptions])[])("finalizes a refusal before any tool call as a scored refusal: %s", async (_name, final) => {
    const refused = await evidence({ singleRequest: true, toolCalls: false, reward: 0, ...final });
    expect(await analyzeTrialStore(refused.storePath)).toMatchObject({ requestAuditComplete: true, executableToolInputs: {}, finalRequestOutcome: "refused" });
    expect((await analyze(refused.root)).rows[0]).toMatchObject({ requestAuditValid: true, commandObserved: false, failure: "provider_refusal" });
    const ledger = await finalizeTerminalBenchRun(refused.manifestPath, refused.root, 0);
    expect(ledger).toMatchObject({ reconciled: true, outcome: "completed", scoredTrials: 1, counts: { provider_refusal: 1, provider_infra: 0 } });
    expect(JSON.parse(await readFile(refused.manifestPath, "utf8"))).toMatchObject({ state: "finalized", analyzer_result: { summary: { failure_counts: { provider_refusal: 1 } } } });
  });

  test("still needs the whole audit chain of a refused request, and refuses a silent trial as infrastructure", async () => {
    const unaudited = await evidence({ singleRequest: true, toolCalls: false, reward: 0, finalOutcome: "stream_error", finalError: { tag: "ContentRefused", message: "flagged" }, includeMessages: false });
    expect((await analyze(unaudited.root)).rows[0]).toMatchObject({ requestAuditValid: false, failure: "request_audit_invalid" });
    // Without a refusal, a trial with no tool call keeps the ordinary checks and is still refused as infrastructure.
    const silent = await evidence({ singleRequest: true, toolCalls: false, reward: 0 });
    expect((await analyze(silent.root)).rows[0]).toMatchObject({ failure: "request_audit_invalid" });
  });

  test("settles tool results that the current writer records at later fact versions", async () => {
    for (const resultVersion of [3, 4]) {
      const analysis = await analyze((await evidence({ resultVersion })).root);
      expect(analysis.rows[0]).toMatchObject({ toolSettlement: { inputs: 2, results: 2, missing: 0 }, failure: null });
    }
  });

  test("rejects a request profile, a refused audit chain, and unsettled tool evidence", async () => {
    for (const [invalid, failure] of [
      [{ requestProfile: retiredProfile }, "request_audit_invalid"],
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
      // A call that the dispatcher repaired: the model wrote a name that the surface does not offer.
      { toolCall: { name: "bash", repairedFrom: "shell" } },
      { toolCall: { name: "shell" } },
      // The wire name is the presentation of a tool, not its canonical identity.
      { route: "claude", toolCall: { name: "mcp__runtime__bash" } },
    ] as const) {
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
      rewrite("tool_surface.selected", (payload) => ({ ...payload, tools: surface("openai").map((tool) => ({ ...tool, description: "tampered" })) })),
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

    const invalid = await evidence({ requestProfile: retiredProfile });
    const rejected = await finalizeTerminalBenchRun(invalid.manifestPath, invalid.root, 0);
    const refused = JSON.parse(await readFile(invalid.manifestPath, "utf8"));
    expect(rejected.reconciled).toBeFalse();
    expect(refused.state).toBe("refused");
    expect(refused.analyzer_result).toBeNull();
  });

  test("finalization records an agent timeout without a summary as cancelled and refuses every other missing or malformed summary", async () => {
    const finalize = async (summary: string | undefined, exception = "AgentTimeoutError") => {
      const root = temporaryDirectory("tb-agent-timeout-");
      await mkdir(join(root, "trials", "trial", "agent"), { recursive: true });
      await writeFile(join(root, "trials", "trial", "result.json"), JSON.stringify({ task_name: "terminal-bench/task", trial_name: "trial-1", verifier_result: { rewards: { reward: 0 } }, exception_info: { exception_type: exception } }));
      if (summary !== undefined) await writeFile(join(root, "trials", "trial", "agent", "flywheel-run-summary.json"), summary);
      const manifestPath = join(root, "run_manifest.json");
      await writeFile(manifestPath, JSON.stringify({ ...manifest(), source_archive_sha256: sourceDigest }));
      const ledger = await finalizeTerminalBenchRun(manifestPath, join(root, "trials"), 0);
      return { ledger, manifest: JSON.parse(await readFile(manifestPath, "utf8")) };
    };
    const timedOut = await finalize(undefined);
    expect(timedOut.ledger).toMatchObject({ reconciled: true, outcome: "completed", counts: { cancelled: 1 } });
    expect(timedOut.manifest).toMatchObject({ state: "finalized", source_archive_sha256: sourceDigest });
    expect(timedOut.manifest.analyzer_result.analysis.rows[0]).toMatchObject({ failure: "agent_timeout" });
    for (const refused of [await finalize("{not json"), await finalize(undefined, "RuntimeError")]) {
      expect(refused.ledger).toMatchObject({ reconciled: false, outcome: "trials_unverified" });
      expect(refused.manifest.state).toBe("refused");
    }
  });

  test("reads a trial's recorded store analysis, never a store, and refuses an analysis of another version", async () => {
    // A record of another version keeps the current shape, so only its version decides the refusal.
    const recorded = async (record: (analysis: TrialStoreAnalysis) => Omit<TrialStoreAnalysis, "version"> & { version: number }) => {
      const fixture = await evidence();
      await writeFile(join(fixture.root, "trial", "agent", TRIAL_STORE_ANALYSIS_NAME), JSON.stringify(record(await analyzeTrialStore(fixture.storePath))));
      return (await analyze(fixture.root)).rows[0];
    };
    expect(await recorded((analysis) => analysis)).toMatchObject({ storeValid: true, requestAuditValid: true, commandObserved: true, failure: null });
    expect(await recorded((analysis) => ({ ...analysis, version: 1 }))).toMatchObject({ storeValid: false, failure: "unreadable_store" });

    // A store in the trial's logs in place of the analysis is not evidence.
    const withStore = await evidence();
    const agent = join(withStore.root, "trial", "agent");
    await rm(join(agent, TRIAL_STORE_ANALYSIS_NAME));
    await mkdir(join(agent, "state", ".flywheel"), { recursive: true });
    await writeFile(join(agent, "state", ".flywheel", "flywheel.sqlite"), await readFile(withStore.storePath));
    expect((await analyze(withStore.root)).rows[0]).toMatchObject({ storeValid: false, failure: "unreadable_store" });
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

  test("classifies a missing store analysis and an exported digest mismatch as an unreadable store", async () => {
    const missing = await evidence();
    await rm(join(missing.root, "trial", "agent", TRIAL_STORE_ANALYSIS_NAME));
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
