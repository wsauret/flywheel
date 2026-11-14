import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendCampaignRecords,
  loadAllCampaignRecords,
  loadCampaignRecords,
  type CampaignHeader,
  type CellLine,
  type ScoreLine,
} from "../../../src/orchestration/modules/development/benchmark/benchmark-records.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const directory = temporaryDirectories();

const HEADER: CampaignHeader = {
  kind: "campaign", version: 1, persona: "reviewer-code-quality", mode: "reviewer", stamp: "2026-11-13T00-00-00-000Z",
  judge: { model: "judge-model", effort: "xhigh" }, scoringVersion: "persona-v3", personaGuidanceIdentity: "guidance",
};
const OBSERVED = { kind: "observed", value: 0.1 } as const;
const ACCOUNTING = { estimatedUsd: OBSERVED, billedUsd: { kind: "observed", value: 0 }, tokens: { kind: "observed", value: 10 }, providers: { kind: "observed", value: ["openai"] }, pricedEntryCount: 1, unpricedEntryCount: 0 } as const;

function cell(task: string, repeat = 0): CellLine {
  return { kind: "cell", variant: "model-a@medium", model: "model-a", effort: "medium", task, taskIdentity: `${task}-identity`, repeat, durationMs: 1000, accounting: ACCOUNTING, output: { kind: "review", text: "P1 a finding" } };
}

function score(task: string, judge = HEADER.judge, repeat = 0): ScoreLine {
  return { kind: "score", judge, scoringVersion: "persona-v3", scorer: "review", score: { variant: "model-a@medium", task, repeat, caught: ["d1"], uncertain: [], unsupportedFindingCount: 0, unsupportedSevereFindingCount: 0 } };
}

function recordsFile(root: string): string {
  return join(root, HEADER.persona, `${HEADER.stamp}.jsonl`);
}

describe("benchmark records", () => {
  it("round-trips a campaign and appends only the cells and scores the file does not hold", async () => {
    const root = directory("benchmark-records-");
    const file = recordsFile(root);
    expect(await appendCampaignRecords(file, HEADER, [cell("t1")], [score("t1")])).toEqual({ cells: 1, scores: 1, grades: 0 });
    const other = { model: "other-judge", effort: "high" };
    expect(await appendCampaignRecords(file, HEADER, [cell("t1"), cell("t2")], [score("t1"), score("t1", other), score("t2")])).toEqual({ cells: 1, scores: 2, grades: 0 });
    expect(await loadCampaignRecords(file)).toEqual({ file, header: HEADER, cells: [cell("t1"), cell("t2")], scores: [score("t1"), score("t1", other), score("t2")], grades: [] });
    // The same header written in another key order is the same campaign.
    const { kind, version, persona, mode, stamp, judge, scoringVersion, personaGuidanceIdentity } = HEADER;
    const reordered: CampaignHeader = { personaGuidanceIdentity, scoringVersion, judge: { effort: judge.effort, model: judge.model }, stamp, mode, persona, version, kind };
    expect(await appendCampaignRecords(file, reordered, [], [])).toEqual({ cells: 0, scores: 0, grades: 0 });
    expect((await loadAllCampaignRecords(root)).map((records) => records.file)).toEqual([file]);
    await expect(appendCampaignRecords(file, { ...HEADER, scoringVersion: "persona-v4" }, [], [])).rejects.toThrow("holds another campaign header");
    await expect(appendCampaignRecords(file, HEADER, [], [score("t3")])).rejects.toThrow("has no cell");
  });

  it("refuses duplicate cells and scores, scores without a cell, a misplaced header, and a torn last line", async () => {
    const cases: [string, unknown[], string][] = [
      ["duplicate cell", [HEADER, cell("t1"), cell("t1")], ":3 repeats cell"],
      ["duplicate score", [HEADER, cell("t1"), score("t1"), score("t1")], ":4 repeats the judge-model:xhigh score"],
      ["orphan score", [HEADER, score("t1")], ":2 scores model-a@medium t1 #0, which has no cell line"],
      ["missing header", [cell("t1")], ":1 is not the campaign header"],
      ["second header", [HEADER, HEADER], ":2 repeats the campaign header"],
      ["wrong scorer", [HEADER, cell("t1"), { ...score("t1"), scorer: "trap", score: { variant: "model-a@medium", task: "t1", repeat: 0, traps: [] } }], ":3 is a trap score in a reviewer campaign"],
    ];
    for (const [name, lines, message] of cases) {
      const file = recordsFile(directory(`benchmark-records-${name.replace(" ", "-")}-`));
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
      await expect(loadCampaignRecords(file), name).rejects.toThrow(message);
    }
    const torn = recordsFile(directory("benchmark-records-torn-"));
    mkdirSync(join(torn, ".."), { recursive: true });
    writeFileSync(torn, `${JSON.stringify(HEADER)}\n`);
    appendFileSync(torn, JSON.stringify(cell("t1")).slice(0, 20));
    await expect(loadCampaignRecords(torn)).rejects.toThrow(":2 is not valid JSON");
  });
});
