#!/usr/bin/env bun
import { renderCodingReport } from "./coding-ab-report.js";
import { codingFamily } from "./coding-family.js";
import { runFamilyCommand } from "./family-command.js";

if (import.meta.main) runFamilyCommand(process.argv.slice(2), {
  usage: "coding-ab.ts", reservedEvaluation: true, baselineJudge: true,
  family: () => codingFamily,
  report: renderCodingReport,
  async judge({ a, b, ...input }) {
    const { judgeCodingCampaign } = await import("./coding-ab-judge.js");
    return await judgeCodingCampaign({ ...input, a: a ?? "control", b: b ?? "candidate" });
  },
});
