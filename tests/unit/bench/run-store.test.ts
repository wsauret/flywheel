import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonLine } from "../../../src/orchestration/modules/development/benchmark/json-lines.js";
import {
  createRunStore,
  implementCandidate,
  openReadOnlyRunEvidence,
  type AttemptRecord,
  type JudgeAttemptRecord,
  type ResearchRunRecord,
  type RunConfig,
} from "../../../src/orchestration/modules/development/benchmark/run-store.js";
import { buildImplementRawResults } from "../../../src/orchestration/modules/development/benchmark/implement-scoring.js";
import { createPersonaStore } from "../../../src/orchestration/modules/development/benchmark/persona-store.js";

const ACCOUNTING = {
  estimatedUsd: { kind: "observed", value: 0.01 },
  billedUsd: { kind: "observed", value: 0.01 },
  tokens: { kind: "observed", value: 100 },
  providers: { kind: "observed", value: ["openai_api"] },
  pricedEntryCount: 1,
  unpricedEntryCount: 0,
} as const;

const CONFIG: RunConfig = {
  kind: "benchmark-config",
  persona: "explorer",
  mode: "research",
  variants: [{ id: "gpt-6-astra@medium", model: "gpt-6-astra", effort: "medium" }],
  repeats: 1,
  stamp: "2026-07-31T00-00-00-000Z",
  identity: { profileId: "test", authorityIncarnation: "test-incarnation", contentIdentity: "0".repeat(64) },
  taskIdentity: "tasks",
  personaGuidanceIdentity: "guidance",
  judgeIdentity: "judge",
  scoringVersion: "persona-v2",
};

const RUN: ResearchRunRecord = {
  kind: "agent-run",
  mode: "research",
  persona: "explorer",
  variant: "gpt-6-astra@medium",
  model: "gpt-6-astra",
  effort: "medium",
  task: "session-disposal",
  repeat: 0,
  accounting: ACCOUNTING,
  durationMs: 1000,
  summary: "answer",
};

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

/** One results directory inside its own results root, the way the catalog hands
 *  the pair to the store. */
async function storeLocation(): Promise<{ resultsRoot: string; directory: string }> {
  root = await mkdtemp(join(tmpdir(), "ab-persona-results-"));
  return { resultsRoot: root, directory: join(root, "explorer-2026-07-31T00-00-00-000Z") };
}

const ATTEMPT: AttemptRecord = {
  kind: "agent-run-attempt",
  attemptId: "1f0f9c2e-0000-4000-8000-000000000001",
  mode: "research",
  persona: "explorer",
  variant: "gpt-6-astra@medium",
  model: "gpt-6-astra",
  effort: "medium",
  task: "session-disposal",
  repeat: 0,
  at: "2026-07-31T00-00-05-000Z",
  durationMs: 20,
  terminal: { kind: "timed-out", timeoutMs: 20 },
  accounting: ACCOUNTING,
};



const JUDGE_ATTEMPT: JudgeAttemptRecord = {
  kind: "judge-attempt",
  attemptId: "1f0f9c2e-0000-4000-8000-000000000003",
  at: "2026-07-31T00-00-09-000Z",
  persona: "explorer",
  mode: "research",
  score: { kind: "pair-score", task: "session-disposal", repeat: 0, slotA: "a", slotB: "b" },
  terminal: "completed",
  accounting: ACCOUNTING,
};

describe("persona benchmark run store", () => {
  it("retains one versioned ledger, accepts changed profiles, and discloses changed inherited roles", async () => {
    const location = await storeLocation();
    const store = await createPersonaStore(location, CONFIG, [RUN.task]);
    await store.appendRun(RUN);
    const role = {
      kind: "cell-roles" as const, variant: RUN.variant, task: RUN.task, repeat: RUN.repeat,
      directory: "cell-a", profileId: "first", authorityIncarnation: "first-incarnation",
      roles: { advisor: { model: "model-a", effort: "medium" } },
    };
    await store.appendRoles(role);
    const resumed = await createPersonaStore(location, { ...CONFIG, identity: { ...CONFIG.identity, profileId: "second", authorityIncarnation: "second-incarnation" } }, [RUN.task]);
    await resumed.appendRoles({ ...role, directory: "cell-b", profileId: "second", roles: { advisor: { model: "model-b", effort: "high" } } });
    expect(await resumed.loadRuns()).toEqual([RUN]);
    expect(await resumed.roleReport()).toContain("normal advisor: model-a / medium");
    expect(await resumed.roleReport()).toContain("model-b / high");
    const files = await readdir(location.directory);
    expect(files.sort()).toEqual(["campaign.json", "events.jsonl"]);
    const bytes = await Bun.file(join(location.directory, "events.jsonl")).text();
    await Bun.write(join(location.directory, "events.jsonl"), `${bytes}{"kind":`);
    await expect(createPersonaStore(location)).rejects.toThrow("not valid JSON");
    expect(await Bun.file(join(location.directory, "events.jsonl")).text()).toBe(`${bytes}{"kind":`);
  });

  it("refuses historical persona resume without modifying the historical config", async () => {
    const location = await storeLocation();
    await createRunStore(location, CONFIG);
    const path = join(location.directory, "run-config.json");
    const bytes = await Bun.file(path).text();
    await expect(createPersonaStore(location)).rejects.toThrow("Historical persona results are read-only");
    expect(await Bun.file(path).text()).toBe(bytes);
    expect(await readdir(location.directory)).toEqual(["run-config.json"]);
  });
  it("round-trips config, runs, and scores", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    await store.appendRun(RUN);
    await store.appendScore({
      kind: "pair-score",
      mode: "research",
      persona: "explorer",
      error: null,
      verdict: { task: "session-disposal", repeat: 0, slotA: "a", slotB: "b", winner: "a", rationale: "better" },
    });
    expect(await store.loadConfig()).toEqual(CONFIG);
    expect(await store.loadRuns()).toEqual([RUN]);
    expect((await store.loadScores())[0]?.kind).toBe("pair-score");
  });

  it("reads old implementation rows and preserves original native grading through reload and raw reporting", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    const old = {
      ...RUN, mode: "implement" as const, diff: "", linesAdded: 0, linesRemoved: 0, filesTouched: 0,
      acceptancePassed: 0, acceptanceFailed: 1, acceptanceTotal: 1,
    };
    const nativeGrade = '{"passed":0,"failed":1,"total":1,"evidence":{"original.test_bug":"FAIL","grade":false}}\n';
    const current = { ...old, repeat: 1, nativeGrade };
    await store.appendRun(old);
    await store.appendRun(current);
    const rows = await store.loadRuns();
    expect(rows).toEqual([old, current]);
    const row = rows[1];
    if (row?.mode !== "implement") throw new Error("expected implementation row");
    const candidate = implementCandidate(row);
    expect(candidate.nativeGrade).toBe(nativeGrade);
    expect(buildImplementRawResults([candidate], [], [])[0]?.nativeGrade).toBe(nativeGrade);
  });

  it("rejects an invalid typed write before appending bytes", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    await expect(store.appendRun({ ...RUN, accounting: { ...RUN.accounting, tokens: { kind: "observed", value: 1.5 } } })).rejects.toThrow(/tokens/);
    expect(await store.loadRuns()).toEqual([]);
  });

  it("rejects duplicate completion keys and attempt IDs after strict loading", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    await store.appendRun(RUN);
    await store.appendRun(RUN);
    await expect(store.loadRuns()).rejects.toThrow(/Duplicate completed/);
    await store.appendAttempt(ATTEMPT);
    await store.appendAttempt(ATTEMPT);
    await expect(store.loadAttempts()).rejects.toThrow(/Duplicate.*attempt/i);
  });

  it("rejects a stored run carrying a legacy provider field", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    await appendJsonLine(join(store.directory, "runs.jsonl"), { ...RUN, provider: "openai_api" });
    await expect(store.loadRuns()).rejects.toThrow(/provider/);
  });

  it("rejects failed settlements in the successful score ledger", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    await appendJsonLine(join(store.directory, "scores.jsonl"), {
      kind: "pair-score",
      mode: "research",
      persona: "explorer",
      error: "Judge response did not contain JSON",
      verdict: { task: "session-disposal", repeat: 0, slotA: "a", slotB: "b", winner: "tie", rationale: "failed" },
    });
    await expect(store.loadScores()).rejects.toThrow(/error/);
  });

  it("reports no attempts when the run never wrote an attempts log", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    expect(await store.loadAttempts()).toEqual([]);
  });

  it("round-trips unsuccessful attempts alongside the completed runs", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    await store.appendRun(RUN);
    await store.appendAttempt(ATTEMPT);
    expect(await store.loadAttempts()).toEqual([ATTEMPT]);
    expect(await store.loadRuns()).toEqual([RUN]);
  });

  it("fails on a malformed attempts log rather than under-counting it", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    await store.appendAttempt(ATTEMPT);
    await Bun.write(join(store.directory, "attempts.jsonl"), `${JSON.stringify(ATTEMPT)}\n{"kind":"agent-run-attempt"`);
    await expect(store.loadAttempts()).rejects.toThrow(/attempts.jsonl:2 is not valid JSON/);
  });

  it("reports no judge attempts for a results directory that predates the ledger", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    expect(await store.loadJudgeAttempts()).toEqual([]);
  });

  it("round-trips the judge attempt ledger", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    await store.appendJudgeAttempt(JUDGE_ATTEMPT);
    await store.appendJudgeAttempt({ ...JUDGE_ATTEMPT, attemptId: "b", terminal: "cancelled", accounting: { ...JUDGE_ATTEMPT.accounting, estimatedUsd: { kind: "unavailable", reason: "the judge call reported no provider usage" } } });
    const attempts = await store.loadJudgeAttempts();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(JUDGE_ATTEMPT);
    expect(attempts[1]?.terminal).toBe("cancelled");
  });

  it("rejects an attempt whose cost is a bare number rather than an observation", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    await appendJsonLine(join(store.directory, "attempts.jsonl"), { ...ATTEMPT, accounting: { ...ATTEMPT.accounting, estimatedUsd: 0 } });
    await expect(store.loadAttempts()).rejects.toThrow(/estimatedUsd/);
  });

  it("rejects an attempt whose terminal reason is a bare string", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    await appendJsonLine(join(store.directory, "attempts.jsonl"), { ...ATTEMPT, terminal: "timed-out" });
    await expect(store.loadAttempts()).rejects.toThrow(/terminal/);
  });

  it("repairs a torn tail in the completed-run log", async () => {
    const store = await createRunStore(await storeLocation(), CONFIG);
    const runsPath = join(store.directory, "runs.jsonl");
    await Bun.write(runsPath, `${JSON.stringify(RUN)}\n${JSON.stringify(RUN).slice(0, 20)}`);
    expect(await store.loadRuns()).toEqual([RUN]);
    expect(await Bun.file(runsPath).text()).toBe(`${JSON.stringify(RUN)}\n`);
  });
});

describe("read-only persona benchmark evidence", () => {
  it("rejects duplicate and foreign ledger identities after strict decoding", async () => {
    const location = await storeLocation();
    const store = await createRunStore(location, CONFIG);
    await store.appendRun(RUN);
    await store.appendRun(RUN);
    const evidence = await openReadOnlyRunEvidence(location);
    await expect(evidence.loadRuns()).rejects.toThrow(/Duplicate completed/);

    const secondLocation = { resultsRoot: root!, directory: join(root!, "foreign") };
    const second = await createRunStore(secondLocation, CONFIG);
    await second.appendAttempt({ ...ATTEMPT, persona: "implementer" });
    const foreignEvidence = await openReadOnlyRunEvidence(secondLocation);
    await expect(foreignEvidence.loadAttempts()).rejects.toThrow(/persona|campaign/i);
  });

  it("rejects single-seat and pair judging without the exact completed run cells", async () => {
    const location = await storeLocation();
    const reviewerConfig: RunConfig = { ...CONFIG, persona: "reviewer-code-quality", mode: "reviewer" };
    const store = await createRunStore(location, reviewerConfig);
    await store.appendJudgeAttempt({
      ...JUDGE_ATTEMPT,
      persona: reviewerConfig.persona,
      mode: reviewerConfig.mode,
      score: { kind: "review-score", variant: RUN.variant, task: "configured-but-missing", repeat: 0 },
    });
    const evidence = await openReadOnlyRunEvidence(location);
    await expect(evidence.loadJudgeAttempts()).rejects.toThrow(/completed.*cell/i);

    const pairLocation = { resultsRoot: root!, directory: join(root!, "self-pair") };
    const pairStore = await createRunStore(pairLocation, CONFIG);
    await pairStore.appendRun(RUN);
    await pairStore.appendJudgeAttempt({
      ...JUDGE_ATTEMPT,
      score: { kind: "pair-score", task: RUN.task, repeat: RUN.repeat, slotA: RUN.variant, slotB: RUN.variant },
    });
    await expect((await openReadOnlyRunEvidence(pairLocation)).loadJudgeAttempts()).rejects.toThrow(/distinct completed.*cells|self-pair/i);

    const missingLocation = { resultsRoot: root!, directory: join(root!, "missing-pair") };
    const missingStore = await createRunStore(missingLocation, {
      ...CONFIG,
      variants: [...CONFIG.variants, { id: "configured", model: "model", effort: "low" }],
    });
    await missingStore.appendRun(RUN);
    await missingStore.appendJudgeAttempt({
      ...JUDGE_ATTEMPT,
      score: { kind: "pair-score", task: RUN.task, repeat: RUN.repeat, slotA: RUN.variant, slotB: "configured" },
    });
    await expect((await openReadOnlyRunEvidence(missingLocation)).loadJudgeAttempts()).rejects.toThrow(/distinct completed.*cells/i);
  });

  it("restricts source score kinds to the campaign mode", async () => {
    const location = await storeLocation();
    const store = await createRunStore(location, CONFIG);
    await store.appendRun(RUN);
    await store.appendScore({
      kind: "review-score",
      mode: "reviewer",
      persona: CONFIG.persona,
      error: null,
      score: { variant: RUN.variant, task: RUN.task, repeat: RUN.repeat, caught: [], uncertain: [], unsupportedFindingCount: 0 },
    });
    await expect((await openReadOnlyRunEvidence(location)).loadScores()).rejects.toThrow(/score kind|campaign mode|persona or mode/i);
  });
});

describe("persona benchmark results directory creation", () => {
  it("opens an existing directory without a config, and creates none when it is absent", async () => {
    const location = await storeLocation();

    await expect(createRunStore(location)).rejects.toThrow(/is missing/);
    expect(await Bun.file(join(location.directory, "run-config.json")).exists()).toBe(false);
    await expect(readdir(location.directory)).rejects.toThrow(/ENOENT/);
  });
});

describe("persona benchmark results containment", () => {
  it("refuses to resume a results directory that is a symlink out of the results root", async () => {
    const location = await storeLocation();
    const outside = await mkdtemp(join(tmpdir(), "ab-persona-outside-"));
    await mkdir(location.resultsRoot, { recursive: true });
    await Bun.write(join(outside, "run-config.json"), `${JSON.stringify(CONFIG)}\n`);
    await symlink(outside, location.directory);
    try {
      await expect(createRunStore(location)).rejects.toThrow(/resolves through the symlink/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a new run whose results directory path already holds a symlink", async () => {
    const location = await storeLocation();
    const outside = await mkdtemp(join(tmpdir(), "ab-persona-outside-"));
    await mkdir(location.resultsRoot, { recursive: true });
    await symlink(outside, location.directory);
    try {
      await expect(createRunStore(location, CONFIG)).rejects.toThrow(/resolves through the symlink/);
      expect(await Bun.file(join(outside, "run-config.json")).exists()).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses to write when the results directory is swapped for a symlink after it was validated", async () => {
    const location = await storeLocation();
    const store = await createPersonaStore(location, CONFIG, [RUN.task]);
    const outside = await mkdtemp(join(tmpdir(), "ab-persona-outside-"));
    await rm(store.directory, { recursive: true, force: true });
    await symlink(outside, location.directory);
    try {
      await expect(store.appendRun(RUN)).rejects.toThrow(/resolves through the symlink/);
      await expect(store.writeArtifact("report.md", "text")).rejects.toThrow(/resolves through the symlink/);
      await expect(store.loadRuns()).rejects.toThrow(/resolves through the symlink/);
      expect(await Bun.file(join(outside, "events.jsonl")).exists()).toBe(false);
      expect(await Bun.file(join(outside, "report.md")).exists()).toBe(false);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses to append through an owned log file that was swapped for a symlink", async () => {
    const location = await storeLocation();
    const store = await createRunStore(location, CONFIG);
    const outside = await mkdtemp(join(tmpdir(), "ab-persona-outside-"));
    const target = join(outside, "stolen.jsonl");
    await Bun.write(target, "");
    await symlink(target, join(store.directory, "runs.jsonl"));
    try {
      await expect(store.appendRun(RUN)).rejects.toThrow(/ELOOP/);
      expect(await Bun.file(target).text()).toBe("");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});