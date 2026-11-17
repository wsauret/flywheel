import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendCampaignRecords, type CampaignHeader, type CellLine, type ScoreLine } from "../../../src/orchestration/modules/development/benchmark/benchmark-records.js";
import { createBenchmarkCatalog } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { unavailableJudgeAccounting } from "../../../src/orchestration/modules/development/benchmark/judge.js";
import { rejudgeRecords } from "../../../src/orchestration/modules/development/benchmark/rejudge.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { succeedingCommands } from "./_persona-benchmark-fixtures.js";

const directory = temporaryDirectories();
const OWN = { model: "judge-a", effort: "xhigh" };
const OTHER = { model: "judge-b", effort: "high" };

/** A project with one reviewer-code-quality defect fixture. */
function reviewerProject(): string {
  const root = directory("benchmark-rejudge-");
  const fixture = join(root, "bench", "ab-persona", "fixtures", "reviews", "billing-ledger");
  mkdirSync(join(fixture, "project"), { recursive: true });
  writeFileSync(join(fixture, "project", "ledger.ts"), "export const total = 1;\n");
  writeFileSync(join(fixture, "diff.patch"), "diff --git a/ledger.ts b/ledger.ts\n--- a/ledger.ts\n+++ b/ledger.ts\n@@ -1 +1,2 @@\n+one\n+two\n");
  writeFileSync(join(fixture, "manifest.json"), JSON.stringify({
    title: "Billing ledger",
    review_prompt_hint: "Read the ledger rounding path",
    defects: [{ id: "rounding-drift", title: "Rounding drift", category: "correctness", files: ["ledger.ts"], catch_criteria: "Names the drift" }],
  }));
  return root;
}

function cell(repeat: number, taskIdentity: string): CellLine {
  return {
    kind: "cell", variant: "model-a@medium", model: "model-a", effort: "medium", task: "billing-ledger", taskIdentity, repeat, durationMs: 1,
    accounting: unavailableJudgeAccounting("synthetic"), output: { kind: "review", text: `review ${repeat}` },
  };
}

function score(repeat: number, judge: typeof OWN, scoringVersion = "persona-v3"): ScoreLine {
  return { kind: "score", judge, scoringVersion, scorer: "review", score: { variant: "model-a@medium", task: "billing-ledger", repeat, caught: [], uncertain: [], unsupportedFindingCount: 0, unsupportedSevereFindingCount: 0 } };
}

describe("benchmark rejudge", () => {
  it("scores only the current cells that the judge has not scored and appends beside the other judges' lines", async () => {
    const root = reviewerProject();
    const catalog = createBenchmarkCatalog(root);
    const [task] = await catalog.reviewTasks("reviewer-code-quality");
    const header: CampaignHeader = { kind: "campaign", version: 1, persona: "reviewer-code-quality", mode: "reviewer", stamp: "s1", judge: OWN, scoringVersion: "persona-v3", personaGuidanceIdentity: "g" };
    const file = catalog.recordsFile("reviewer-code-quality", "s1");
    // Repeat 0 is unscored by the other judge, repeat 1 already has its score, repeat 2 ran on older task content,
    // and the other judge scored repeat 3 only under an older scoring contract.
    await appendCampaignRecords(file, header, { cells: [cell(0, task!.contentIdentity), cell(1, task!.contentIdentity), cell(2, "older"), cell(3, task!.contentIdentity)], scores: [score(0, OWN), score(1, OWN), score(1, OTHER), score(2, OWN), score(3, OTHER, "persona-v2")] });
    const before = await Bun.file(file).text();
    const prompts: string[] = [];
    const evidence: string[] = [];

    const deps = {
      catalog, persona: "reviewer-code-quality", judge: OTHER,
      openJudge: async (evidenceDirectory: string) => {
        evidence.push(evidenceDirectory);
        return {
          runOwnedCommand: succeedingCommands,
          model: {
            complete: async (prompt: string) => {
              prompts.push(prompt);
              return { text: '{"caught":["rounding-drift"],"uncertain":[],"unsupported_finding_count":1,"unsupported_severe_finding_count":1}', accounting: unavailableJudgeAccounting("synthetic") };
            },
          },
        };
      },
    };

    // A dry run counts the pending cells without admitting the judge or writing.
    expect(await rejudgeRecords({ ...deps, dryRun: true })).toMatchObject({ pending: 2, scored: 0, failed: 0 });
    expect(evidence).toEqual([]);
    expect(await Bun.file(file).text()).toBe(before);

    const outcome = await rejudgeRecords(deps);

    expect(prompts).toHaveLength(2);
    expect(prompts.some((prompt) => prompt.includes("review 0")) && prompts.some((prompt) => prompt.includes("review 3"))).toBe(true);
    expect(outcome).toMatchObject({ pending: 2, scored: 2, failed: 0 });
    expect(evidence).toEqual([join(outcome.evidenceDirectory, "judge-requests")]);
    expect(outcome.evidenceDirectory.startsWith(join(catalog.resultsRoot, "rejudge-reviewer-code-quality-"))).toBe(true);
    const after = await Bun.file(file).text();
    expect(after.startsWith(before)).toBe(true);
    const rejudged = (repeat: number) => ({
      ...score(repeat, OTHER),
      score: { ...score(repeat, OTHER).score, caught: ["rounding-drift"], unsupportedFindingCount: 1, unsupportedSevereFindingCount: 1 },
    });
    const appended = after.slice(before.length).trim().split("\n").map((line) => JSON.parse(line));
    expect(appended.toSorted((a, b) => a.score.repeat - b.score.repeat)).toEqual([rejudged(0), rejudged(3)]);
    const attempts = (await Bun.file(join(outcome.evidenceDirectory, "judge-attempts.jsonl")).text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(attempts.map((attempt) => attempt.score.repeat).toSorted()).toEqual([0, 3]);
    expect(attempts[0]).toEqual(expect.objectContaining({ kind: "judge-attempt", persona: "reviewer-code-quality", terminal: "completed", score: expect.objectContaining({ kind: "review-score", variant: "model-a@medium", task: "billing-ledger" }) }));
  });
});
