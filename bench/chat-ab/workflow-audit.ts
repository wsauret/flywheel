#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCodingDesign } from "./coding-ab-design.js";
import { requireAuthProfile } from "./campaign-args.js";
import { runCampaign } from "./campaign-runner.js";
import { workflowAuditFamily } from "./workflow-audit-family.js";
import { renderWorkflowAuditReport } from "./workflow-audit-report.js";
import { RESULTS_ROOT } from "./harness-paths.js";

const ACTIONS = ["plan", "setup", "run", "resume", "report", "judge"] as const;
async function main(argv: readonly string[]): Promise<void> {
  const [requested, path, ...flags] = argv;
  const action = ACTIONS.find((value) => value === requested);
  if (!action || !path) throw new Error("Usage: workflow-audit.ts plan|setup|run|resume <design.json> --results <dir>, or report|judge <results-dir>");
  const input = { results: RESULTS_ROOT, reservedEvaluation: false, keepSandboxes: false, dryRun: false, a: "control", b: "candidate" };
  let authProfile: string | undefined;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    const value = () => {
      const next = flags[++index];
      if (!next || next.startsWith("--")) throw new Error(`${flag} requires a value`);
      return next;
    };
    if (flag === "--results") input.results = resolve(value());
    else if (flag === "--keep-sandboxes") input.keepSandboxes = true;
    else if (flag === "--dry-run") input.dryRun = true;
    else if (flag === "--a") input.a = value();
    else if (flag === "--b") input.b = value();
    else if (flag === "--auth-profile") authProfile = value();
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (action === "report") console.log(await renderWorkflowAuditReport(resolve(path)));
  else if (action === "judge") {
    const { judgeWorkflowAuditCampaign } = await import("./workflow-audit-judge.js");
    console.log(JSON.stringify(await judgeWorkflowAuditCampaign({ ...input, authProfile: requireAuthProfile(authProfile), directory: resolve(path) }), null, 2));
  } else {
    if (action !== "plan" && input.results === RESULTS_ROOT) throw new Error("Use --results with a dedicated campaign directory");
    await runCampaign({ ...input, action }, async () => parseCodingDesign(JSON.parse(await readFile(resolve(path), "utf8")), authProfile), workflowAuditFamily);
  }
}
if (import.meta.main) main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
