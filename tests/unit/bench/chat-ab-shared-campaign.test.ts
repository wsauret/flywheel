import { describe, expect, test } from "bun:test";
import { structuredIdentity } from "../../../src/orchestration/modules/development/benchmark/content-identity.js";
import { basename, join } from "node:path";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { chatLedger, type ChatCampaign } from "../../../bench/chat-ab/chat-store.js";
import { campaignHeadlessOutcome } from "../../../bench/chat-ab/campaign-execution.js";
import { campaignIdentity, campaignSchedule } from "../../../bench/chat-ab/campaign-store.js";
import { captureCampaignResult, runBounded, runCampaign } from "../../../bench/chat-ab/campaign-runner.js";
import type { HeadlessBenchmarkExecution } from "../../../src/orchestration/modules/development/benchmark/headless-execution-contract.js";
import { chatFamily, chatGrade } from "../../../bench/chat-ab/chat-family.js";
import { runChatCampaign } from "../../../bench/chat-ab/chat-campaign.js";
import { parseArgs } from "../../../bench/chat-ab/campaign-args.js";
import { renderReport } from "../../../bench/chat-ab/report.js";
import { scoreChatCampaign } from "../../../bench/chat-ab/chat-score.js";
import { compareChatCampaigns } from "../../../bench/chat-ab/chat-compare.js";
import { campaignRoleEvidence } from "../../../bench/chat-ab/campaign-role-evidence.js";
import { scoreAcceptance } from "../../../bench/chat-ab/acceptance.js";
import { openCampaignStore, type CampaignConfig } from "../../../bench/chat-ab/store.js";
import { unavailableBenchmarkAccounting } from "../../../src/orchestration/modules/development/benchmark/evidence.js";
import { CHAT_AB_JUDGE } from "../../../bench/chat-ab/judge-inputs.js";
import { requireChatJudgeFamily } from "../../../bench/chat-ab/chat-judge-inputs.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { fakeOwnedCommandRunner, ownedCommandResult } from "../../helpers/owned-command-fake.js";
import { loadBenchTasks } from "../../../bench/chat-ab/tasks.js";

const temporary = temporaryDirectories();
const hash = "a".repeat(64);
const manifest: ChatCampaign = {
  kind: "chat-ab", version: 2, name: "chat-trial", model: "claude-opus-5", effort: "high", authProfile: "Personal",
  answers: "approve-root-workflow-launch", infrastructureIdentity: hash, repeats: 2, createdAt: "now",
  treatments: ["a", "b"].map((id) => ({
    id, revision: "revision", sourceIdentity: hash, dependencyIdentity: hash, harnessIdentity: hash, settingsIdentity: hash,
    arm: { id: "baseline", identity: null, invokeSkill: null }, model: "claude-opus-5", effort: "high", authProfile: "Personal",
  })),
  tasks: [{ id: "task", stratum: "bug", contentIdentity: hash, timeoutMs: 1000 }],
};
const captured = { diff: "diff", linesAdded: 1, linesRemoved: 2, filesTouched: 1, acceptance: new Map([["fix", "pass"], ["guard", "fail"]] as const) };
const grade = chatGrade({ acceptanceBaseline: { failToPass: ["fix"], passToPass: ["guard"] } }, captured);

describe("Chat family shared campaign", () => {
  test.each(["failed", "complete"] as const)("settles %s subjects without grading failures or losing their evidence and retry", async (status) => {
    const directory = temporary("chat-settlement-");
    const artifactRoot = join(directory, "artifacts");
    await mkdir(artifactRoot);
    const artifactPath = join(artifactRoot, "stream.jsonl");
    await writeFile(artifactPath, "retained raw evidence");
    const accounting = { ...unavailableBenchmarkAccounting("not billed"), estimatedUsd: { kind: "observed" as const, value: 0.25 } };
    const execution: HeadlessBenchmarkExecution = {
      version: 1, outcome: status, exitCode: status === "failed" ? 1 : 0, wallMs: 1,
      evidence: { kind: "unavailable", reason: "No canonical evidence" },
      totalAccounting: accounting, parentAccounting: accounting,
      artifacts: { stdout: { path: artifactPath, sha256: hash, bytes: 21 } },
    };
    let captures = 0;
    const artifacts: Parameters<typeof captureCampaignResult<{ grade: typeof grade | null }>>[3] = { grade: null, report: null, diff: null };
    await captureCampaignResult(directory, artifactRoot, execution, artifacts, async () => {
      captures++;
      return { grade: { grade }, diff: "captured diff" };
    });
    expect(captures).toBe(status === "failed" ? 0 : 1);
    expect(artifacts.grade).toEqual(status === "failed" ? null : grade);
    const owned: typeof artifacts = { grade: null, report: null, diff: null };
    await captureCampaignResult(directory, artifactRoot, execution, owned, async () => ({ grade: { grade }, diff: "captured diff" }), true);
    expect(owned.grade).toEqual(grade);
    const store = await chatLedger.open(directory, manifest);
    const attempt = { kind: "attempt" as const, attemptId: "first", cell: { treatment: "a", task: "task", repeat: 0 }, at: "now", directory: "cells/first" };
    await store.append(attempt);
    const outcome = campaignHeadlessOutcome(directory, attempt, [execution], 0, artifacts);
    await store.append(outcome);
    expect(outcome.status).toBe(status === "failed" ? "failed" : "completed");
    expect(outcome.accounting).toEqual(accounting);
    expect(outcome.runs[0]!.artifacts).toEqual([{ path: "artifacts/stream.jsonl", sha256: hash }]);
    expect(await readFile(artifactPath, "utf8")).toBe("retained raw evidence");
    expect(chatLedger.pending(manifest, await store.load()).some((cell) => cell.treatment === "a" && cell.task === "task" && cell.repeat === 0)).toBe(status === "failed");
  });

  test("strictly decodes Chat grades, preserves failed guards, rotates paired cells, and reports missing usage honestly", async () => {
    const directory = temporary("chat-shared-");
    const store = await chatLedger.open(directory, manifest);
    const attempt = { kind: "attempt" as const, attemptId: "first", cell: { treatment: "a", task: "task", repeat: 0 }, at: "now", directory: "cells/first" };
    await store.append(attempt);
    const accounting = unavailableBenchmarkAccounting("No evidence");
    const outcome = campaignHeadlessOutcome(directory, attempt, [{
      version: 1, outcome: "input_required", exitCode: 2, wallMs: 1, evidence: { kind: "observed", value: {
        version: 2, projectRoot: directory, rootSessionId: "root", descendantDiscovery: "current-metadata", metadataGaps: [],
        sessions: [], accounting: { usage: "unavailable", price: "estimate", providerInvoicedCost: "unavailable" },
      }, requestCount: 1, parentRequestCount: 1, childSessionCount: 0 },
      totalAccounting: accounting, parentAccounting: accounting, artifacts: {},
    }, {
      version: 1, outcome: "complete", exitCode: 0, wallMs: 1, evidence: { kind: "unavailable", reason: "Claude Code session transcript not found" },
      totalAccounting: accounting, parentAccounting: accounting, artifacts: {},
    }], 0, { grade, report: null, diff: null });
    await store.append(outcome);
    expect((await chatLedger.open(directory)).manifest.kind).toBe("chat-ab");
    expect(scoreAcceptance(grade.acceptance)).toEqual({ fixed: 1, fixable: 1, brokenGuards: ["guard"], score: 0, resolved: false });
    expect(campaignSchedule(manifest).map(({ treatment, repeat }) => `${treatment}/${repeat}`)).toEqual(["a/0", "b/0", "b/1", "a/1"]);
    expect(chatLedger.pending(manifest, await store.load())).not.toContainEqual(attempt.cell);
    expect(() => chatLedger.decodeOutcome(manifest, { ...outcome, approvalReplies: 1 })).toThrow();
    expect(() => chatLedger.decodeOutcome(manifest, { ...outcome, grade: { ...grade, acceptance: { failToPass: { fix: "missing" }, passToPass: {} } } })).toThrow();
    const privateManifest = { ...manifest, roles: [] };
    await expect(chatLedger.open(temporary("chat-invalid-"), privateManifest)).rejects.toThrow();
    const report = await renderReport(directory);
    expect(report.markdown).toContain("| a/task/0 | complete | 0 | false | 1 | unavailable | unavailable | 0 | unavailable / unavailable |");
    expect(report.markdown).toContain("Evidence unavailable for a/task/0: Claude Code session transcript not found.");
    expect(report.markdown).toContain("| task | 0 | 0 | unavailable | unavailable |");
    expect((await scoreChatCampaign(directory, "Personal", true)).markdown).toContain("| a | task | 0 | unavailable |");
    expect((await readdir(directory)).sort()).toEqual(["campaign.json", "events.jsonl"]);
    const mixed = { ...manifest, treatments: [manifest.treatments[0]!, {
      id: "b", subject: "claude-code" as const, binaryPath: "/scratch/claude", binarySha256: hash, binaryVersion: "2.1.296",
      settingsIdentity: hash, model: "claude-sonnet-5-5", effort: "high" as const, authProfile: "Claude Code login",
      arm: { id: "baseline", identity: null, invokeSkill: null },
    }] };
    const externalDirectory = temporary("chat-external-");
    await chatLedger.open(externalDirectory, mixed);
    expect((await chatLedger.open(externalDirectory)).manifest).toEqual(mixed);
    expect((await renderReport(externalDirectory)).markdown).toContain(`Claude Code 2.1.296 (${hash})`);
  });

  test("supports one treatment and makes edited skill-arm identity part of campaign identity", async () => {
    const directory = temporary("chat-single-");
    const single = { ...manifest, treatments: manifest.treatments.slice(0, 1) };
    await chatLedger.open(directory, single);
    await expect(chatLedger.open(directory, { ...single, treatments: single.treatments.map((treatment) => ({ ...treatment, arm: { ...treatment.arm, identity: hash } })) })).rejects.toThrow("identity changed");
    const family = chatFamily({ name: "chat", tasks: [], repeats: 1, model: "claude-opus-5", effort: "high", authProfile: "Personal", treatments: { a: "HEAD" } }, new Map([["a", { id: "delegate", description: "Delegate", identity: hash, invokeSkill: "delegate" }]]));
    const task = { ...manifest.tasks[0]!, message: "Fix this", taskDir: "/scratch/task", acceptanceDir: "/scratch/acceptance", judgeContext: "Fix this", sandbox: { commit: "revision", paths: ["src"] }, acceptanceBaseline: { failToPass: ["fix"], passToPass: ["guard"] } };
    expect(family.message(task, "a", "flywheel")).toBe("Load the `delegate` skill with the skill tool, then apply it to this task:\n\nFix this");
    // A cell recorded when the task arrived as a typed skill invocation never matches the agent-load treatment.
    expect(family.treatmentIdentity?.("a")).not.toBe(structuredIdentity({ id: "delegate", identity: hash, invokeSkill: "delegate" }));
    const claudeDesign = { name: "claude", tasks: [], repeats: 1, model: "model", effort: "high" as const, authProfile: "Personal", treatments: { a: { subject: "claude-code" as const } } };
    expect(() => chatFamily(claudeDesign, new Map([["a", { id: "delegate", description: "Delegate", identity: hash, invokeSkill: "delegate" }]]))).toThrow("baseline");
    const claude = chatFamily(claudeDesign, new Map([["a", { id: "baseline", description: "Baseline", identity: null }]]));
    expect(claude.message(task, "a", "claude-code")).toBe("Fix this");
  });

  test("retains challenge identity and delivery in the Chat report without changing ordinary reports", async () => {
    const directory = temporary("chat-challenge-report-");
    const challenged = { ...manifest, challenge: true as const };
    expect(campaignIdentity(challenged)).not.toBe(campaignIdentity(manifest));
    const store = await chatLedger.open(directory, challenged);
    const accounting = unavailableBenchmarkAccounting("No evidence");
    for (const [index, delivery] of (["revise-design", "message", "none"] as const).entries()) {
      const attempt = { kind: "attempt" as const, attemptId: `attempt-${index}`, cell: { treatment: index === 2 ? "b" : "a", task: "task", repeat: index === 2 ? 0 : index }, at: "now", directory: `cells/${index}` };
      await store.append(attempt);
      await store.append(campaignHeadlessOutcome(directory, attempt, [{
        version: 1, outcome: "complete", exitCode: 0, wallMs: 1,
        evidence: { kind: "unavailable", reason: "No evidence" },
        totalAccounting: accounting, parentAccounting: accounting, artifacts: {},
      }], 1, { grade, report: null, diff: null, challenge: delivery === "none" ? { delivered: "none" as const, reason: "first run incomplete" } : { delivered: delivery } }));
    }
    const report = await renderReport(directory);
    expect(report.markdown).toContain("| Challenge delivery |");
    expect(report.markdown).toContain("| a/task/0 | complete | revise-design |");
    expect(report.markdown).toContain("| a/task/1 | complete | message |");
    expect(report.markdown).toContain("| b/task/0 | complete | none |");
  });

  test("reads a paired native ledger for comparison without inventing quality or price", async () => {
    const directory = temporary("chat-compare-");
    await chatLedger.open(directory, manifest);
    const result = await compareChatCampaigns({ baseline: directory, candidate: directory, authProfile: "Personal", differ: "arm", rule: { minWinRatio: 2, maxCostIncrease: 0.3 } });
    expect(result.json.sharedTasks).toEqual(["task"]);
    expect(result.json.costIncrease).toBeNull();
    expect(result.json.decision).toBeNull();
    expect(result.json.calls).toEqual([]);
    expect(result.markdown).toContain("Adoption: unavailable");
    const report = await scoreChatCampaign(directory, "Personal", false);
    expect(report.markdown).toContain("Pending calls: 0");
    const scoringDirectory = (await readdir(directory)).find((name) => name.startsWith("score-"))!;
    expect(JSON.parse(await readFile(join(directory, scoringDirectory, "run-config.json"), "utf8")).kind).toBe("chat-headless-scoring");
    expect(await readFile(join(directory, scoringDirectory, "report.md"), "utf8")).toBe(report.markdown);
  });

  test("does not adopt when only some compared pairs have prices", async () => {
    const directory = temporary("chat-partial-pricing-");
    const store = await chatLedger.open(directory, manifest);
    const unavailable = unavailableBenchmarkAccounting("missing prices");
    const passing = { ...grade, acceptance: { failToPass: { fix: "pass" as const }, passToPass: { guard: "pass" as const } } };
    for (const repeat of [0, 1]) for (const treatment of ["a", "b"]) {
      const attempt = { kind: "attempt" as const, attemptId: `${treatment}-${repeat}`, cell: { treatment, task: "task", repeat }, at: "now", directory: `cells/${treatment}-${repeat}` };
      await store.append(attempt);
      const accounting = repeat === 0 ? { ...unavailable, estimatedUsd: { kind: "observed" as const, value: 1 } } : unavailable;
      const path = `${attempt.directory}/roles.json`;
      const roles = JSON.stringify({ "workflow-agent": { model: treatment === "a" ? "before-model" : "after-model", effort: "medium" } });
      await mkdir(join(directory, attempt.directory), { recursive: true });
      await writeFile(join(directory, path), roles);
      await store.append({
        ...campaignHeadlessOutcome(directory, attempt, [], 0, { grade: passing, report: null, diff: null }),
        status: "completed", reason: null, accounting,
        runs: [{ outcome: "complete", exitCode: 0, wallMs: 1, sessionId: null, reason: null,
          evidence: { kind: "unavailable", reason: "No usage" },
          artifacts: [{ path: repeat === 0 ? path : `${attempt.directory}/missing/roles.json`, sha256: new Bun.CryptoHasher("sha256").update(roles).digest("hex") }] }],
      });
    }
    const root = join(directory, `compare-${basename(directory)}-${CHAT_AB_JUDGE.model}`);
    await mkdir(root);
    const calls = [0, 1].flatMap((repeat) => [0, 1].map((order) => ({
      task: "task", repeat, order, baselineFirst: true,
      verdict: { correctA: "yes", correctB: "yes", winner: "B", rationale: "candidate wins" }, error: null, usd: null,
    })));
    await writeFile(join(root, "judge-calls.jsonl"), calls.map((call) => JSON.stringify(call)).join("\n") + "\n");
    const result = await compareChatCampaigns({ baseline: directory, candidate: directory, authProfile: "Personal", differ: "arm", rule: { minWinRatio: 2, maxCostIncrease: 0.3 } });
    expect(result.json.tally).toEqual({ candidate: 2, baseline: 0, tie: 0, incomplete: 0 });
    expect(result.json.costIncrease).toBeNull();
    expect(result.json.decision?.adopt).toBe(false);
    expect(result.json.decision?.reasons).toContain("paired cost evidence is unavailable, so the cost rise is unknown");
    expect(result.json.roleComparisons[0]?.changes).toEqual([{ kind: "normal", role: "workflow-agent", before: { model: "before-model", effort: "medium" }, after: { model: "after-model", effort: "medium" } }]);
    expect(result.markdown).toContain("before-model / medium");
    expect(result.markdown).toContain("after-model / medium");
    expect(result.markdown).toContain("a/task/0");
    expect(result.markdown).toContain("b/task/0");
    expect(result.markdown).toContain("Role evidence unavailable");
  });

  test("refuses historical run and resume before execution while retaining report access", async () => {
    const directory = temporary("chat-historical-");
    const config: CampaignConfig = {
      kind: "chat-ab-config", scoringVersion: "chat-ab-v3", arm: { id: "baseline", identity: null },
      agent: { revision: "old", sourceIdentity: "old", accountSkillsIdentity: "old", composedModules: [], composedTools: [] },
      tasks: [], repeats: 1, chat: { role: "chat", model: "old" }, roles: [], authProfile: "Personal", profileId: "personal",
      authorityIncarnation: "old", providerPlans: [], createdAt: "now",
    };
    const store = await openCampaignStore(directory);
    await store.createConfig(config);
    const design = { name: "chat", tasks: [], repeats: 1, model: "model", effort: "high" as const, authProfile: "Personal", treatments: { baseline: "HEAD" } };
    const family = chatFamily(design, new Map([["baseline", { id: "baseline", identity: null, description: "Baseline" }]]));
    for (const action of ["run", "resume"] as const) {
      await expect(runCampaign({ action, results: directory, reservedEvaluation: false, dryRun: false, keepSandboxes: false }, async () => { throw new Error("Must refuse before loading design"); }, family)).rejects.toThrow("read-only; start a new results directory");
    }
    await expect(runChatCampaign(parseArgs(["--resume", directory, "--model", "claude-opus-5"]))).rejects.toThrow("read-only; start a new results directory");
    expect((await renderReport(directory)).markdown).toContain("# Chat A/B campaign: baseline");
    const torn = '{"kind":';
    await writeFile(join(directory, "runs.jsonl"), torn);
    await expect(renderReport(directory)).rejects.toThrow("not valid JSON");
    expect(await readFile(join(directory, "runs.jsonl"), "utf8")).toBe(torn);
    await writeFile(join(directory, "paired-config.json"), "{}");
    await expect(runChatCampaign(parseArgs(["--resume", directory]))).rejects.toThrow("read-only");
  });

  test("preserves existing manifests and compares changed or unavailable preflight roles", async () => {
    const baseline = temporary("workflow-base-");
    const candidate = temporary("workflow-candidate-");
    const fixtureDirectory = temporary("recorded-role-campaign-");
    await writeFile(join(fixtureDirectory, "campaign.json"), await Bun.file(new URL("../../fixtures/coding-ab-v2/role-aware-chat-campaign.json", import.meta.url)).text());
    const recorded = (await chatLedger.open(fixtureDirectory)).manifest;
    const treatment = recorded.treatments[0]!;
    if (treatment.subject === "claude-code") throw new Error("Expected Flywheel fixture");
    const base = { ...manifest, treatments: [treatment] };
    const family = structuredIdentity(treatment.arm);
    const inputs = { profileId: "Personal", model: "claude-sonnet-5.5", effort: "medium", family };
    const changedRoles = { "workflow-agent": { model: "changed", effort: "medium" } };
    const changed = { ...base, treatments: [{ ...treatment, resolvedRoles: changedRoles, settingsIdentity: structuredIdentity({ ...inputs, rolesIdentity: structuredIdentity(changedRoles) }) }] };
    await chatLedger.open(baseline, base);
    await chatLedger.open(candidate, changed);
    const options = { baseline, candidate, authProfile: "Personal", rule: { minWinRatio: 2, maxCostIncrease: 0.3 }, differ: "arm" as const };
    expect((await compareChatCampaigns(options)).json.sharedTasks).toEqual(["task"]);
    const missing = temporary("workflow-missing-");
    const { resolvedRoles: _, ...withoutRoles } = treatment;
    const unavailable = { ...withoutRoles, settingsIdentity: structuredIdentity(inputs) };
    await chatLedger.open(missing, { ...base, treatments: [unavailable] });
    expect((await compareChatCampaigns({ ...options, candidate: missing })).json.sharedTasks).toEqual(["task"]);
    const old = temporary("old-chat-manifest-");
    await chatLedger.open(old, manifest);
    expect((await chatLedger.open(old)).manifest).toEqual(manifest);
    expect(campaignIdentity(base)).toBe(campaignIdentity(changed));
    expect((await chatLedger.open(baseline, { ...base, treatments: [unavailable] })).manifest).toEqual(base);
    for (const field of ["sourceIdentity", "dependencyIdentity", "harnessIdentity"] as const) {
      await expect(chatLedger.open(baseline, { ...base, treatments: [{ ...unavailable, [field]: "b".repeat(64) }] })).rejects.toThrow("identity");
    }
    const pinned = { ...unavailable, roles: { "workflow-agent": { model: "pinned" } }, settingsIdentity: structuredIdentity({ ...inputs, roles: { "workflow-agent": { model: "pinned" } } }) };
    await expect(chatLedger.open(baseline, { ...base, treatments: [pinned] })).rejects.toThrow("identity");
    expect(() => campaignIdentity({ ...base, treatments: [{ ...treatment, settingsIdentity: hash }] })).toThrow("does not match");
    const malformed = temporary("workflow-malformed-");
    const store = await chatLedger.open(malformed, base);
    const attempt = { kind: "attempt" as const, attemptId: "malformed", cell: { treatment: treatment.id, task: "task", repeat: 0 }, at: "now", directory: "cells/malformed" };
    await store.append(attempt);
    const path = "cells/malformed/workflow-roles.json";
    const text = JSON.stringify("not resolved roles");
    await mkdir(join(malformed, attempt.directory), { recursive: true });
    await writeFile(join(malformed, path), text);
    await store.append({
      ...campaignHeadlessOutcome(malformed, attempt, [], 0, { grade, report: null, diff: null }),
      status: "completed", reason: null,
      runs: [{ outcome: "complete", exitCode: 0, wallMs: 1, sessionId: null, reason: null,
        evidence: { kind: "unavailable", reason: "No usage" },
        artifacts: [{ path, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") }] }],
    });
    const [outcome] = (await store.load()).filter((record) => record.kind === "outcome");
    if (!outcome || outcome.kind !== "outcome") throw new Error("Missing outcome");
    await expect(campaignRoleEvidence(malformed, outcome)).rejects.toThrow("Expected");
  });

  test("admits a judge that shares a family with resolved roles but not with a treatment model", () => {
    const treatment = { ...manifest.treatments[0]!,
      resolvedRoles: { "workflow-agent": { model: CHAT_AB_JUDGE.model, effort: "medium" } } };
    expect(() => requireChatJudgeFamily([{ ...manifest, treatments: [treatment] }])).not.toThrow();
    expect(() => requireChatJudgeFamily([{ ...manifest, treatments: [{ ...treatment, model: CHAT_AB_JUDGE.model }] }])).toThrow("different model family");
  });

  test("reads pre-conversion comparison and score receipts without writes or another judge call", async () => {
    const directory = temporary("legacy-role-receipts-");
    const fixture = JSON.parse(await Bun.file(new URL("../../fixtures/coding-ab-v2/role-aware-chat-campaign.json", import.meta.url)).text());
    fixture.treatments.push({ ...fixture.treatments[0], id: "b" });
    await writeFile(join(directory, "campaign.json"), JSON.stringify(fixture));
    const store = await chatLedger.open(directory);
    for (const treatment of ["a", "b"]) {
      const attempt = { kind: "attempt" as const, attemptId: treatment, cell: { treatment, task: store.manifest.tasks[0]!.id, repeat: 0 }, at: "now", directory: treatment };
      await store.append(attempt);
      await store.append({ ...campaignHeadlessOutcome(directory, attempt, [], 0, { grade, report: null, diff: null }), status: "completed", reason: null });
    }
    const identity = "433f0461e134a378fb06fa72fb07e2ab588bc7ab2df67d0753808595ba0da410";
    const redaction = "a7ea2bbe81790415651f3e76f312e063ed647404b43b77beaf1f6698a414c101";
    const compareRoot = join(directory, `compare-${basename(directory)}-${CHAT_AB_JUDGE.model}`);
    const scoreRoot = join(directory, `score-${CHAT_AB_JUDGE.model}`);
    await mkdir(compareRoot);
    await mkdir(scoreRoot);
    const compareConfig = JSON.stringify({ baseline: identity, candidate: identity, judge: CHAT_AB_JUDGE.model, prompt: "c462f483d1272e68542cdda671d203ade937f29f5d24519b4d1484d6af83a42a", redaction });
    const scoreConfig = JSON.stringify({ kind: "chat-headless-scoring", campaign: identity, judge: CHAT_AB_JUDGE.model, effort: "high", prompt: "f680c43066ade71f9afa6c3cad33e3e3acfde9c9786d37ebc92726be758948b5", redaction });
    const compareCalls = [0, 1].map((order) => JSON.stringify({ task: store.manifest.tasks[0]!.id, repeat: 0, order, baselineFirst: order === 0, verdict: { correctA: "yes", correctB: "yes", winner: "tie", rationale: "Equivalent" }, error: null, usd: null })).join("\n") + "\n";
    const scoreCalls = ["a", "b"].flatMap((artifactDir) => [0, 1].map((call) => JSON.stringify({ kind: "chat-ab-score-call", task: store.manifest.tasks[0]!.id, repeat: 0, artifactDir, call, reply: { correct: "yes", scope: "clean", test: "regression", handoffAccurate: "absent", score: 7, rationale: "Correct" }, error: null, usd: null, accounting: unavailableBenchmarkAccounting("Retained") }))).join("\n") + "\n";
    const files = [
      [join(compareRoot, "run-config.json"), compareConfig], [join(compareRoot, "judge-calls.jsonl"), compareCalls],
      [join(scoreRoot, "run-config.json"), scoreConfig], [join(scoreRoot, "score-calls.jsonl"), scoreCalls],
    ] as const;
    for (const [path, bytes] of files) await writeFile(path, bytes);
    const compared = await compareChatCampaigns({ baseline: directory, candidate: directory, authProfile: "Personal", differ: "arm", rule: { minWinRatio: 2, maxCostIncrease: 0.3 }, reportOnly: true }, async () => { throw new Error("No admission"); });
    expect(compared.json.tally.tie).toBe(1);
    expect((await scoreChatCampaign(directory, "Personal", true)).json.rows.map(({ score }) => score)).toEqual([7, 7]);
    expect((await scoreChatCampaign(directory, "Personal", false)).json.rows.map(({ score }) => score)).toEqual([7, 7]);
    expect((await renderReport(directory)).markdown).toContain("# chat-paired");
    for (const [path, bytes] of files) expect(await readFile(path, "utf8")).toBe(bytes);
  });

  test("judges changed normal and workflow roles in both slot orders and hides their models", async () => {
    const directory = temporary("chat-role-judge-");
    const [task] = await loadBenchTasks(join(process.cwd(), "bench/chat-ab/tasks"), ["config-lock-first-write"]);
    if (!task) throw new Error("Missing task");
    const campaign = { ...manifest, repeats: 1, tasks: [{ id: task.id, stratum: task.stratum, contentIdentity: task.contentIdentity, timeoutMs: task.timeoutMs }] };
    const store = await chatLedger.open(directory, campaign);
    for (const treatment of ["a", "b"]) {
      const attempt = { kind: "attempt" as const, attemptId: treatment, cell: { treatment, task: task.id, repeat: 0 }, at: "now", directory: `cells/${treatment}` };
      await store.append(attempt);
      await mkdir(join(directory, attempt.directory), { recursive: true });
      const model = treatment === "a" ? "role-before-model" : "role-after-model";
      const artifacts = await Promise.all(["roles.json", "workflow-roles.json", "diff.patch"].map(async (name) => {
        const path = `${attempt.directory}/${name}`;
        const text = name === "diff.patch" ? `+// ${model} later-model lost-model\n+const fix = true;` : JSON.stringify({ "workflow-agent": { model, effort: "medium" } });
        await writeFile(join(directory, path), text);
        return { path, sha256: new Bun.CryptoHasher("sha256").update(text).digest("hex") };
      }));
      await mkdir(join(directory, attempt.directory, "later"));
      const later = JSON.stringify({ "workflow-agent": { model: "later-model", effort: "high" } });
      await writeFile(join(directory, attempt.directory, "later", "roles.json"), later);
      await store.append({ ...campaignHeadlessOutcome(directory, attempt, [], 0, { grade, report: null, diff: null }),
        status: "completed", reason: null, diff: artifacts[2]!,
        runs: [
          { outcome: "input_required", exitCode: 2, wallMs: 1, sessionId: null, reason: null,
            models: ["lost-model"], evidence: { kind: "unavailable", reason: "No usage" }, artifacts: [...artifacts.slice(0, 2), { path: `${attempt.directory}/missing/roles.json`, sha256: hash }] },
          { outcome: "complete", exitCode: 0, wallMs: 1, sessionId: null, reason: null,
            evidence: { kind: "unavailable", reason: "No usage" }, artifacts: [{ path: `${attempt.directory}/later/roles.json`, sha256: new Bun.CryptoHasher("sha256").update(later).digest("hex") }] },
        ],
      });
    }
    const prompts: string[] = [];
    const result = await compareChatCampaigns({ baseline: directory, candidate: directory, authProfile: "Personal", differ: "arm", rule: { minWinRatio: 2, maxCostIncrease: 0.3 } }, async () => ({
      model: { complete: async (prompt: string) => {
        prompts.push(prompt);
        return { text: JSON.stringify({ correctA: "yes", correctB: "yes", winner: "tie", rationale: "Both fix the issue" }), accounting: unavailableBenchmarkAccounting("Not billed") };
      } },
      run: fakeOwnedCommandRunner(async () => ownedCommandResult("reference fix: role-before-model and role-after-model")).run,
      [Symbol.asyncDispose]: async () => {},
    }));
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).not.toContain("role-before-model");
      expect(prompt).not.toContain("role-after-model");
      expect(prompt).not.toContain("later-model");
      expect(prompt).not.toContain("lost-model");
      expect(prompt).toContain("<model>");
    }
    expect(result.json.tally).toEqual({ candidate: 0, baseline: 0, tie: 1, incomplete: 0 });
    expect(result.json.roleComparisons[0]?.changes.map(({ kind }) => kind)).toEqual(["normal", "workflow"]);
    const report = await renderReport(directory);
    expect(report.markdown).toContain("role-before-model / medium");
    expect(report.markdown).toContain("role-after-model / medium");
  });
});

test.each([1, 2])("runs at most %i cells at once in order, and a failure stops scheduling but lets running cells settle", async (concurrency) => {
  const gates = new Map<number, PromiseWithResolvers<void>>();
  const started: number[] = [];
  const settled: number[] = [];
  let running = 0;
  let peak = 0;
  const pool = runBounded([0, 1, 2, 3, 4, 5], concurrency, async (cell) => {
    started.push(cell);
    peak = Math.max(peak, ++running);
    const gate = Promise.withResolvers<void>();
    gates.set(cell, gate);
    try {
      await gate.promise;
    } finally {
      running--;
      settled.push(cell);
    }
  });
  let rejected = false;
  pool.catch(() => { rejected = true; });
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  const first = Array.from({ length: concurrency }, (_, index) => index);
  await turn();
  expect(started).toEqual(first);
  gates.get(0)!.resolve();
  await turn();
  expect(started).toEqual([...first, concurrency]);
  gates.get(concurrency)!.reject(new Error("cell failed"));
  await turn();
  expect(started).toEqual([...first, concurrency]);
  for (const cell of started.filter((candidate) => !settled.includes(candidate))) {
    expect(rejected).toBe(false);
    gates.get(cell)!.resolve();
    await turn();
  }
  await expect(pool).rejects.toThrow("cell failed");
  expect(peak).toBe(concurrency);
  expect(settled.toSorted()).toEqual(started);
});

test("a cell that halts on its failed outcome stops scheduling while its cleanup still runs", async () => {
  const started: number[] = [];
  const [failing, running, cleanup] = [Promise.withResolvers<void>(), Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const pool = runBounded([0, 1, 2, 3], 2, async (cell, halt) => {
    started.push(cell);
    if (cell !== 0) return await running.promise;
    await failing.promise;
    halt();
    await cleanup.promise;
    throw new Error("cell failed");
  });
  const turn = () => new Promise((resolve) => setImmediate(resolve));
  await turn();
  expect(started).toEqual([0, 1]);
  failing.resolve();
  await turn();
  running.resolve();
  await turn();
  expect(started).toEqual([0, 1]);
  cleanup.resolve();
  await expect(pool).rejects.toThrow("cell failed");
  expect(started).toEqual([0, 1]);
});
