#!/usr/bin/env bun
// The planning family: each Chat writes an implementation plan to PLAN.md for one brief.
// Refer to bench/chat-ab/README.md, "Planning".
import { runFamilyCommand } from "./family-command.js";
import { planningFamily } from "./planning-family.js";
import { judgePlanningCampaign } from "./planning-judge.js";
import { renderPlanningReport } from "./planning-report.js";

if (import.meta.main) runFamilyCommand(process.argv.slice(2), {
  usage: "planning.ts",
  family: planningFamily,
  report: renderPlanningReport,
  judge: ({ a, b, ...input }) => judgePlanningCampaign({ ...input, ...(a ? { a } : {}), ...(b ? { b } : {}) }),
});
