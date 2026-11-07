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
      const storePath = join(valid.root, "trial", "agent", "state", ".flywheel", "flywheel.sqlite");
      const store = new Database(storePath, { readonly: true });
      try {
        // The coverage rests on these two writer behaviors, so the fixture states them.
        expect(store.query("select payload ->> '$.requestId' as requestId from event where type = 'tool_surface.selected'").all()).toEqual([{ requestId: requestIds[0] }]);
        expect(store.query("select version, count(*) as count from event where type = 'tool.result.recorded' group by version order by version").all()).toEqual([{ version: 1, count: 1 }, { version: 2, count: 1 }]);
      } finally { store.close(); }
      expect(await analyzeTrialStore(storePath)).toMatchObject({ requestAuditComplete: true, executableToolInputs: { bash: 2 }, toolSettlement: { identityConflicts: 0 } });
      const analysis = await analyze(valid.root);
      expect(analysis.infrastructureValid).toBeTrue();
      expect(analysis.rows[0]).toMatchObject({ requestAuditValid: true, commandObserved: true, toolSettlement: { inputs: 2, results: 2, missing: 0, orphan: 0, identityConflicts: 0 }, failure: null });
    }
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

  test("reads a hosted trial's recorded store analysis in place of its store, and refuses a store or an analysis of another version", async () => {
    // A record of another version keeps the current shape, so only its version decides the refusal.
    const hosted = async (record: (analysis: TrialStoreAnalysis) => Omit<TrialStoreAnalysis, "version"> & { version: number }) => {
      const fixture = await evidence();
      const agent = join(fixture.root, "trial", "agent");
      const analysis = await analyzeTrialStore(join(agent, "state", ".flywheel", "flywheel.sqlite"));
      await rm(join(agent, "state"), { recursive: true });
      await writeFile(join(agent, TRIAL_STORE_ANALYSIS_NAME), JSON.stringify(record(analysis)));
      return (await analyzeToolOutcomes(fixture.root, { ...manifest(), execution_mode: "hosted", source_archive_sha256: sourceDigest })).rows[0];
    };
    expect(await hosted((analysis) => analysis)).toMatchObject({ storeValid: true, requestAuditValid: true, commandObserved: true, failure: null });
    expect(await hosted((analysis) => ({ ...analysis, version: 2 }))).toMatchObject({ storeValid: false, failure: "unreadable_store" });

    // A hosted run never reads a store from the trial's logs.
    const withStore = await evidence();
    expect((await analyzeToolOutcomes(withStore.root, { ...manifest(), execution_mode: "hosted", source_archive_sha256: sourceDigest })).rows[0]).toMatchObject({ storeValid: false, failure: "unreadable_store" });
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
