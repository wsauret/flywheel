import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { openScoreRun, pendingScoreJobs } from "../../../bench/chat-ab/score-run.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporary = temporaryDirectories();
const Config = Schema.Struct({ campaign: Schema.String, prompt: Schema.String });
const Call = Schema.Struct({ id: Schema.String, reply: Schema.NullOr(Schema.String) });

test("opens accepted scoring identities and refuses changed identities without changing evidence", async () => {
  const root = temporary("score-run-");
  const path = join(root, "run-config.json");
  const config = { campaign: "current", prompt: "rubric" };
  const recorded = { ...config, campaign: "recorded" };
  await writeFile(path, JSON.stringify(recorded));
  const run = await openScoreRun(root, Config, [config, recorded], Call, "calls.jsonl", true);
  expect(run.calls).toEqual([]);
  await expect(openScoreRun(root, Config, [config], Call, "calls.jsonl", true)).rejects.toThrow("Scoring identity changed");
  await expect(openScoreRun(root, Config, [{ ...recorded, prompt: "changed" }], Call, "calls.jsonl", false)).rejects.toThrow("Scoring identity changed");
  expect(await Bun.file(path).json()).toEqual(recorded);
});

test("skips only successful calls with the same job identity", () => {
  const jobs = ["done", "failed", "new", "updated"];
  const calls = [
    { id: "done", reply: "scored" }, { id: "done", reply: null },
    { id: "failed", reply: null }, { id: "previous-input", reply: "scored" },
  ];
  expect(pendingScoreJobs(jobs, calls, job => job, call => call.id)).toEqual(["failed", "new", "updated"]);
});
