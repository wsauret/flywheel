#!/usr/bin/env bun
import { runFamilyCommand } from "./family-command.js";
import { workflowAuthorshipFamily } from "./workflow-authorship-family.js";
import { renderWorkflowAuthorshipReport } from "./workflow-authorship-report.js";
import { judgeWorkflowAuthorshipCampaign } from "./workflow-authorship-judge.js";

if (import.meta.main) runFamilyCommand(process.argv.slice(2), {
  usage: "workflow-authorship.ts",
  family: workflowAuthorshipFamily,
  report: renderWorkflowAuthorshipReport,
  judge: ({ a, b, ...input }) => judgeWorkflowAuthorshipCampaign({ ...input, a: a ?? "authored", b: b ?? "handcrafted" }),
});
