import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { reconcileDisclosureLedger as reconcile } from "../../../bench/harbor/disclosure-ledger.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { trialEvidence } from "../../helpers/harbor-trial-evidence.js";

const temporaryDirectory = temporaryDirectories();

interface TrialSummary { readonly [key: string]: unknown }
/** Reconciles a Terminal-Bench run, whose grader downloads its tools from GitHub, over valid infrastructure. */
const reconcileDisclosureLedger = (options: Omit<Parameters<typeof reconcile>[0], "infrastructureValid" | "verifierDownloadsFromGithub">) => reconcile({ ...options, infrastructureValid: true, verifierDownloadsFromGithub: true });

/** The store analysis a trial records, with the evidence the ledger reads from it. */
function analysis(finalRequestOutcome: string | null, estimatedUsd = 0, unpricedUsage: { unmeasured?: number; unpriced?: number; undecoded?: number } = {}) {
  return { version: 5, store: { sha256: "a".repeat(64), size: 1 }, toolSettlement: { inputs: 0, results: 0, missing: 0, orphan: 0, duplicateInputs: 0, duplicateResults: 0, identityConflicts: 0 }, requestAuditComplete: true, interactionProfiles: [], executableToolInputs: {}, finalRequestOutcome, usage: { estimatedUsd, entries: 1, partial: 0, unmeasured: 0, unpriced: 0, undecoded: 0, ...unpricedUsage } };
}

async function trial(root: string, directory: string, task: string, trialName: string, summary: TrialSummary, reward: number | null, exception?: string, cost?: number, storeAnalysis?: ReturnType<typeof analysis>): Promise<void> {
  const path = join(root, directory);
  await mkdir(join(path, "agent"), { recursive: true });
  await writeFile(join(path, "agent", "flywheel-run-summary.json"), JSON.stringify(summary));
  if (storeAnalysis !== undefined) await writeFile(join(path, "agent", "flywheel-store-analysis.json"), JSON.stringify(storeAnalysis));
  await writeFile(join(path, "result.json"), JSON.stringify({
    task_name: task,
    trial_name: trialName,
    verifier_result: { rewards: { reward } },
    exception_info: exception === undefined ? null : { exception_type: exception },
    agent_result: cost === undefined ? {} : { cost_usd: cost },
  }));
}

describe("Harbor disclosure ledger", () => {
  test("reconciles Harbor result identities and exposes complete aggregates", async () => {
    const root = temporaryDirectory("tb-ledger-");
    // The store's usage summary is the cost; Harbor's reported cost is not read.
    await trial(root, "a__hash1", "terminal-bench/a", "a__hash1", {}, 1, undefined, undefined, analysis("ok", 1.25));
    await trial(root, "a__hash2", "terminal-bench/a", "a__hash2", {}, 0, undefined, 9, analysis("ok", 0.75));
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, taskNames: ["terminal-bench/a"], attempts: 2, harborExitCode: 0 });
    expect(ledger.counts).toEqual({ provider_refusal: 0, provider_infra: 0, verifier_infra: 0, cancelled: 0, cost_truncated: 0, genuine: 1, other: 0 });
    expect(ledger.rewardDistribution).toEqual({ "0": 1, "1": 1 });
    expect(ledger.exceptionHistogram).toEqual({});
    expect(ledger.taskPassRates["terminal-bench/a"]).toEqual({ passed: 1, total: 2, rate: 0.5 });
    expect(ledger.totalCost).toBe(2);
    expect(ledger.costLowerBound).toBeFalse();
    expect(ledger.rows.map((row) => [row.cost, row.costBasis])).toEqual([[1.25, "settled"], [0.75, "settled"]]);
    expect(ledger.rows[0]?.category).toBeUndefined();
    expect(ledger.outcome).toBe("completed");
  });

  test("zero Harbor trials are unverified when evidence cannot reconcile", async () => {
    const root = temporaryDirectory("tb-ledger-empty-");
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, expectedTrials: 2, harborExitCode: 0 });
    expect(ledger.counts).toEqual({ provider_refusal: 0, provider_infra: 0, verifier_infra: 0, cancelled: 0, cost_truncated: 0, genuine: 0, other: 0 });
    expect(ledger.outcome).toBe("trials_unverified");
  });

  test("does not reconcile artifact presence without valid infrastructure analysis", async () => {
    const root = temporaryDirectory("ledger-analyzer-");
    await trial(root, "trial", "task", "trial-1", {}, 1);
    const ledger = await reconcile({ trialsDirectory: root, taskNames: ["task"], attempts: 1, harborExitCode: 0, infrastructureValid: false, verifierDownloadsFromGithub: true });
    expect(ledger.reconciled).toBeFalse();
    expect(ledger.outcome).toBe("trials_unverified");
  });

  test("Harbor nonzero remains the exact process exit code", async () => {
    const root = temporaryDirectory("tb-ledger-fail-");
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, expectedTrials: 0, harborExitCode: 23 });
    expect(ledger.exitCode).toBe(23);
    expect(ledger.outcome).toBe("harness_nonzero_exit");
  });

  test("scores a verifier timeout without a reward as a fail, as the board does", async () => {
    const root = temporaryDirectory("tb-ledger-verifier-timeout-");
    await mkdir(join(root, "a__hash", "agent"), { recursive: true });
    await writeFile(join(root, "a__hash", "agent", "flywheel-run-summary.json"), "{}");
    await writeFile(join(root, "a__hash", "result.json"), JSON.stringify({ task_name: "a", trial_name: "a__hash", verifier_result: null, exception_info: { exception_type: "VerifierTimeoutError" } }));
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, taskNames: ["a"], attempts: 1, harborExitCode: 0 });
    expect(ledger.rows).toEqual([{ id: "a__hash", task: "a", reward: 0, category: "cancelled", cost: null, costBasis: "unavailable" }]);
    expect(ledger.outcome).toBe("completed");
  });

  test("prices a timed-out trial from its last snapshot and a trial without a current analysis from its published store, and marks the total a lower bound", async () => {
    const root = temporaryDirectory("tb-ledger-snapshot-");
    const bytes = await readFile((await trialEvidence(temporaryDirectory("tb-ledger-store-"), { usageUsd: [0.5, null] })).storePath);
    const publish = async (directory: string, store: Buffer) => {
      await mkdir(join(root, directory, "agent", "flywheel-evidence", ".flywheel"), { recursive: true });
      await writeFile(join(root, directory, "agent", "flywheel-evidence", ".flywheel", "flywheel.sqlite"), store);
    };
    const timedOut = async (directory: string) => {
      await mkdir(join(root, directory, "agent"), { recursive: true });
      await writeFile(join(root, directory, "result.json"), JSON.stringify({ task_name: "a", trial_name: directory, verifier_result: { rewards: { reward: 0 } }, exception_info: { exception_type: "AgentTimeoutError" }, agent_result: { cost_usd: 0.25 } }));
    };
    // A snapshot of a round recorded before the snapshot copy claimed rollback journaling keeps the WAL file format in its header.
    const snapshot = Buffer.from(bytes);
    snapshot[18] = 2; snapshot[19] = 2;
    await timedOut("a__snapshot");
    await publish("a__snapshot", snapshot);
    await timedOut("a__unavailable");
    // A settled trial whose analysis an earlier version recorded: its published store carries the run summary's identity.
    await trial(root, "a__recorded", "a", "a__recorded", { evidence_sha256: createHash("sha256").update(bytes).digest("hex") }, 1, undefined, undefined, { ...analysis("ok", 9), version: 4 });
    await publish("a__recorded", bytes);
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, taskNames: ["a"], attempts: 3, harborExitCode: 0 });
    expect(Object.fromEntries(ledger.rows.map((row) => [row.id, [row.cost, row.costBasis]]))).toEqual({ a__snapshot: [0.5, "snapshot"], a__unavailable: [null, "unavailable"], a__recorded: [0.5, "settled"] });
    expect(ledger.totalCost).toBe(1);
    expect(ledger.costLowerBound).toBeTrue();
    // The store is read in memory: its file keeps its bytes and gains no journal beside it.
    expect(await readFile(join(root, "a__snapshot", "agent", "flywheel-evidence", ".flywheel", "flywheel.sqlite"))).toEqual(snapshot);
    expect(await readdir(join(root, "a__snapshot", "agent", "flywheel-evidence", ".flywheel"))).toEqual(["flywheel.sqlite"]);
  });

  test("prices a trial that admission refuses, whose cost the run still spent", async () => {
    const root = temporaryDirectory("tb-ledger-refused-cost-");
    await trial(root, "a__admitted", "a", "a__admitted", {}, 1, undefined, undefined, analysis("ok", 0.5));
    // The analysis was exported, but the run summary was never written and Harbor reported no reward.
    await mkdir(join(root, "a__refused", "agent"), { recursive: true });
    await writeFile(join(root, "a__refused", "agent", "flywheel-store-analysis.json"), JSON.stringify(analysis("stream_error", 0.25)));
    await writeFile(join(root, "a__refused", "result.json"), JSON.stringify({ task_name: "a", trial_name: "a__refused", verifier_result: { rewards: { reward: null } }, exception_info: { exception_type: "RuntimeError" } }));
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, taskNames: ["a"], attempts: 2, harborExitCode: 0 });
    expect(ledger.rows.map((row) => row.id)).toEqual(["a__admitted"]);
    expect(ledger.reconciled).toBeFalse();
    expect(ledger.totalCost).toBe(0.75);
    expect(ledger.costLowerBound).toBeFalse();
  });

  test("a total of settled trials is a lower bound when a trial has unmeasured, unpriced, or undecoded usage", async () => {
    const root = temporaryDirectory("tb-ledger-incomplete-usage-");
    await trial(root, "a__clean", "a", "a__clean", {}, 1, undefined, undefined, analysis("ok", 0.5));
    const clean = await reconcileDisclosureLedger({ trialsDirectory: root, taskNames: ["a"], attempts: 1, harborExitCode: 0 });
    expect(clean.costLowerBound).toBeFalse();
    for (const [index, usage] of [{ unmeasured: 1 }, { unpriced: 1 }, { undecoded: 1 }].entries()) {
      const directory = temporaryDirectory("tb-ledger-incomplete-usage-");
      await trial(directory, "a__clean", "a", "a__clean", {}, 1, undefined, undefined, analysis("ok", 0.5));
      await trial(directory, "a__incomplete", "a", "a__incomplete", {}, 1, undefined, undefined, analysis("ok", 0.25, usage));
      const ledger = await reconcileDisclosureLedger({ trialsDirectory: directory, taskNames: ["a"], attempts: 2, harborExitCode: 0 });
      expect([index, ledger.rows.map((row) => row.costBasis), ledger.totalCost, ledger.costLowerBound]).toEqual([index, ["settled", "settled"], 0.75, true]);
    }
  });

  test("reconciled null-only trials have no scored trials", async () => {
    const root = temporaryDirectory("tb-ledger-unscored-");
    await trial(root, "a__hash", "a", "a__hash", {}, null);
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, taskNames: ["a"], attempts: 1, harborExitCode: 0 });
    expect(ledger.counts.other).toBe(1);
    expect(ledger.outcome).toBe("no_scored_trials");
    expect(ledger.exitCode).toBe(1);
  });

  test("applies typed failure precedence from Harbor's exception, the shim's settlement, and the final request outcome", async () => {
    const root = temporaryDirectory("tb-ledger-taxonomy-");
    await trial(root, "a__one", "a", "a__one", { captured_after_cancellation: true }, 0, "RuntimeError", undefined, analysis("aborted"));
    await trial(root, "a__two", "a", "a__two", { captured_after_cancellation: true }, null, "AgentTimeoutError", undefined, analysis("context_overflow"));
    await trial(root, "a__three", "a", "a__three", {}, 0, undefined, undefined, analysis("output_overflow"));
    await trial(root, "a__four", "a", "a__four", {}, 0, undefined, undefined, analysis("stream_error"));
    await trial(root, "a__five", "a", "a__five", {}, 0, undefined, undefined, analysis("aborted"));
    await trial(root, "a__six", "a", "a__six", {}, 0, undefined, undefined, analysis("ok"));
    // A provider refusal is a scored failure of its own, also when Harbor reports an exception after it.
    await trial(root, "a__seven", "a", "a__seven", {}, 0, "RuntimeError", undefined, analysis("refused"));
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, taskNames: ["a"], attempts: 7, harborExitCode: 0 });
    expect(Object.fromEntries(ledger.rows.map((row) => [row.id, row.category]))).toEqual({ a__one: "provider_infra", a__two: "cancelled", a__three: "cost_truncated", a__four: "provider_infra", a__five: "cancelled", a__six: "genuine", a__seven: "provider_refusal" });
    expect(ledger.counts.provider_refusal).toBe(1);
    // Every trial but the one that timed out without a reward is scored, the refusal included.
    expect(ledger.scoredTrials).toBe(6);
    expect(ledger.exceptionHistogram).toEqual({ AgentTimeoutError: 1, RuntimeError: 2 });
  });

  test("a grader whose GitHub downloads failed before any test ran is verifier infrastructure", async () => {
    const root = temporaryDirectory("tb-ledger-verifier-");
    const pythonDownloadFailure = "error: Request failed after 3 retries\n  Caused by: Failed to download https://github.com/astral-sh/python-build-standalone/releases/download/20251014/cpython-3.13.9.tar.gz\n  Caused by: HTTP status server error (504 Gateway Timeout)\n";
    const uvDownloadFailure = "curl: (22) The requested URL returned error: 504\nfailed to download https://github.com/astral-sh/uv/releases/download/0.9.5/uv-x86_64-unknown-linux-gnu.tar.gz\n/tests/test.sh: line 19: uvx: command not found\n";
    const verifierOutput = (directory: string, text: string) => mkdir(join(root, directory, "verifier"), { recursive: true }).then(() => writeFile(join(root, directory, "verifier", "test-stdout.txt"), text));
    await trial(root, "a__ungraded", "a", "a__ungraded", {}, 0, undefined, undefined, analysis("ok"));
    await verifierOutput("a__ungraded", pythonDownloadFailure);
    // A download that failed once and then succeeded on retry still ran the tests.
    await trial(root, "a__graded", "a", "a__graded", {}, 0, undefined, undefined, analysis("ok"));
    await verifierOutput("a__graded", `${pythonDownloadFailure}============================== 2 failed in 0.31s ===============================\n`);
    // A timed-out agent can have left its deliverable, so the grade is unknown when the grader could not start.
    await trial(root, "a__timeout", "a", "a__timeout", {}, 0, "AgentTimeoutError", undefined, analysis("aborted"));
    await verifierOutput("a__timeout", uvDownloadFailure);
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, taskNames: ["a"], attempts: 3, harborExitCode: 0 });
    expect(Object.fromEntries(ledger.rows.map((row) => [row.id, row.category]))).toEqual({ a__ungraded: "verifier_infra", a__graded: "genuine", a__timeout: "verifier_infra" });
    expect(ledger.counts).toEqual({ provider_refusal: 0, provider_infra: 0, verifier_infra: 2, cancelled: 0, cost_truncated: 0, genuine: 1, other: 0 });
    expect(ledger.outcome).toBe("completed");
    // A benchmark whose grader downloads nothing from GitHub keeps the grade of the same log.
    const offline = await reconcile({ trialsDirectory: root, taskNames: ["a"], attempts: 3, harborExitCode: 0, infrastructureValid: true, verifierDownloadsFromGithub: false });
    expect(Object.fromEntries(offline.rows.map((row) => [row.id, row.category]))).toEqual({ a__ungraded: "genuine", a__graded: "genuine", a__timeout: "cancelled" });
  });

  test("a reward below 0, which a grader writes when it crashed, is verifier infrastructure on every benchmark", async () => {
    const root = temporaryDirectory("tb-ledger-negative-");
    await trial(root, "a__crashed", "a", "a__crashed", {}, -1, undefined, undefined, analysis("ok"));
    await trial(root, "a__failed", "a", "a__failed", {}, 0, undefined, undefined, analysis("ok"));
    for (const verifierDownloadsFromGithub of [true, false]) {
      const ledger = await reconcile({ trialsDirectory: root, taskNames: ["a"], attempts: 2, harborExitCode: 0, infrastructureValid: true, verifierDownloadsFromGithub });
      expect(Object.fromEntries(ledger.rows.map((row) => [row.id, row.category]))).toEqual({ a__crashed: "verifier_infra", a__failed: "genuine" });
      expect(ledger.taskPassRates.a).toEqual({ passed: 0, total: 2, rate: 0 });
    }
  });

  test("ignores Harbor's job-level result.json and nested artifact results", async () => {
    const root = temporaryDirectory("tb-ledger-joblevel-");
    await trial(root, "a__hash", "terminal-bench/a", "a__hash", {}, 1);
    // Harbor writes a job-level result.json beside the trial directories; it has no trial identity.
    await writeFile(join(root, "result.json"), JSON.stringify({ stats: { mean: 1 } }));
    // Trial artifacts may nest their own result.json files; those are not trial evidence either.
    await mkdir(join(root, "a__hash", "artifacts", "logs"), { recursive: true });
    await writeFile(join(root, "a__hash", "artifacts", "logs", "result.json"), JSON.stringify({ unrelated: true }));
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, taskNames: ["terminal-bench/a"], attempts: 1, harborExitCode: 0 });
    expect(ledger.reconciled).toBeTrue();
    expect(ledger.outcome).toBe("completed");
    expect(ledger.exitCode).toBe(0);
  });

  test("excludes symlinked trial directories and symlinked trial results", async () => {
    const root = temporaryDirectory("tb-ledger-symlink-");
    const outside = temporaryDirectory("tb-ledger-outside-");
    await trial(outside, "a__real", "terminal-bench/a", "a__real", {}, 1);
    await symlink(join(outside, "a__real"), join(root, "a__linked-dir"));
    await mkdir(join(root, "a__linked-file", "agent"), { recursive: true });
    await writeFile(join(root, "a__linked-file", "agent", "flywheel-run-summary.json"), JSON.stringify({}));
    await symlink(join(outside, "a__real", "result.json"), join(root, "a__linked-file", "result.json"));
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, taskNames: ["terminal-bench/a"], attempts: 1, harborExitCode: 0 });
    expect(ledger.rows).toEqual([]);
    expect(ledger.reconciled).toBeFalse();
    expect(ledger.outcome).toBe("trials_unverified");
  });

  test("an absent trials root fails closed instead of reconciling empty evidence", async () => {
    const root = temporaryDirectory("tb-ledger-absent-");
    const missing = join(root, "never-created");
    expect(reconcileDisclosureLedger({ trialsDirectory: missing, expectedTrials: 0, harborExitCode: 0 })).rejects.toThrow();
  });

  test("rejects duplicate, unexpected, missing, and malformed Harbor trial evidence", async () => {
    const root = temporaryDirectory("tb-ledger-identities-");
    await trial(root, "first", "a", "duplicate", {}, 1);
    await trial(root, "second", "a", "duplicate", {}, 1);
    await trial(root, "unexpected", "b", "b__hash", {}, 1);
    const ledger = await reconcileDisclosureLedger({ trialsDirectory: root, taskNames: ["a"], attempts: 2, harborExitCode: 0 });
    expect(ledger.reconciled).toBeFalse();
    expect(ledger.outcome).toBe("trials_unverified");
  });
});
