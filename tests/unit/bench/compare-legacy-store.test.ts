import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { appendJsonLine } from "../../../src/orchestration/modules/development/benchmark/json-lines.js";
import {
  createCrossComparisonStore,
  type CrossComparisonConfig,
  type CrossJudgeAttemptRecord,
  type CrossScoreRecord,
} from "../../../src/orchestration/modules/development/benchmark/run-store.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

const CONFIG: CrossComparisonConfig = {
  kind: "cross-comparison-config",
  identity: "c".repeat(64),
  sourceA: {
    directory: "/results/a",
    configIdentity: "a".repeat(64),
    campaign: { profileId: "candidate-a", authorityIncarnation: "inc-a", contentIdentity: "1".repeat(64) },
    variant: "same",
  },
  sourceB: {
    directory: "/results/b",
    configIdentity: "b".repeat(64),
    campaign: { profileId: "candidate-b", authorityIncarnation: "inc-b", contentIdentity: "2".repeat(64) },
    variant: "same",
  },
  candidatePairs: [{ task: "task", repeat: 0, candidateAIdentity: "3".repeat(64), candidateBIdentity: "4".repeat(64) }],
  judgeModel: "judge",
  judgeRubricIdentity: "5".repeat(64),
  scoringVersion: "cross-implement-v1",
  judge: { profileId: "judge-profile", authorityIncarnation: "judge-inc", contentIdentity: "6".repeat(64) },
};

const SCORE: CrossScoreRecord = {
  kind: "cross-pair-score",
  comparisonIdentity: CONFIG.identity,
  verdict: { task: "task", repeat: 0, slotA: "same[a]", slotB: "same[b]", winner: "same[a]", rationale: "better" },
};

const ATTEMPT: CrossJudgeAttemptRecord = {
  kind: "cross-judge-attempt",
  comparisonIdentity: CONFIG.identity,
  attemptId: "attempt-1",
  at: "2026-09-10T00:00:00.000Z",
  score: { task: "task", repeat: 0, slotA: "same[a]", slotB: "same[b]" },
  terminal: "completed",
  accounting: {
    estimatedUsd: { kind: "observed", value: 0.01 },
    billedUsd: { kind: "observed", value: 0 },
    tokens: { kind: "observed", value: 100 },
    providers: { kind: "observed", value: ["openai_subscription"] },
    pricedEntryCount: 1,
    unpricedEntryCount: 0,
  },
};

function location() {
  const resultsRoot = temporaryDirectory("cross-store-");
  return { resultsRoot, directory: join(resultsRoot, "comparison") };
}

describe("legacy cross-run comparison store", () => {
  it("round-trips strict config, successful scores, and cumulative judge attempts", async () => {
    const store = await createCrossComparisonStore(location(), CONFIG);
    await store.appendJudgeAttempt(ATTEMPT);
    await store.appendScore(SCORE);
    expect(await store.loadConfig()).toEqual(CONFIG);
    expect(await store.loadJudgeAttempts()).toEqual([ATTEMPT]);
    expect(await store.loadScores()).toEqual([SCORE]);
  });

  it("repairs only a torn score tail and rejects a torn judge-attempt tail", async () => {
    const store = await createCrossComparisonStore(location(), CONFIG);
    await store.appendScore(SCORE);
    await Bun.write(join(store.directory, "cross-scores.jsonl"), `${JSON.stringify(SCORE)}\n{"kind":"cross-pair-score"`);
    expect(await store.loadScores()).toEqual([SCORE]);
    await store.appendJudgeAttempt(ATTEMPT);
    await Bun.write(join(store.directory, "cross-judge-attempts.jsonl"), `${JSON.stringify(ATTEMPT)}\n{"kind":"cross-judge-attempt"`);
    await expect(store.loadJudgeAttempts()).rejects.toThrow(/cross-judge-attempts\.jsonl:2 is not valid JSON/);
  });

  it("rejects malformed records and conflicting persisted config", async () => {
    const paths = location();
    const store = await createCrossComparisonStore(paths, CONFIG);
    await appendJsonLine(join(store.directory, "cross-judge-attempts.jsonl"), { ...ATTEMPT, provider: "legacy" });
    await expect(store.loadJudgeAttempts()).rejects.toThrow(/provider/);
    await expect(createCrossComparisonStore(
      paths,
      { ...CONFIG, scoringVersion: "changed" },
    )).rejects.toThrow(/does not match/);
  });
});
