import { codingLedger, type CodingOutcomeRecord } from "./coding-ab-store.js";
import { campaignRoleComparisons } from "./campaign-role-evidence.js";
import { renderCampaignRoleChanges } from "../../src/orchestration/modules/development/benchmark/campaign-role-changes.js";

const average = (values: readonly number[]): string => values.length === 0 ? "unavailable" : (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
const dollars = (outcomes: readonly CodingOutcomeRecord[], field: "estimatedUsd" | "billedUsd"): string => {
  const observed = outcomes.flatMap((outcome) => outcome.accounting[field].kind === "observed" ? [outcome.accounting[field].value] : []);
  return observed.length === 0 ? "unavailable" : `$${observed.reduce((sum, value) => sum + value, 0).toFixed(4)} (${observed.length}/${outcomes.length} observed)`;
};

/** Report only durable candidate evidence. Quality failures remain in the denominator; attempts keep their spend. */
export async function renderCodingReport(directory: string): Promise<string> {
  const store = await codingLedger.open(directory);
  const events = await store.load();
  const { completed, attempts, settled } = codingLedger.validate(store.manifest, events);
  const lines = [
    `# ${store.manifest.name}`,
    "",
    `Model: ${store.manifest.model}; effort: ${store.manifest.effort}; operator: ${store.manifest.authProfile}.`,
    "",
    "| Treatment | Subject identity | Complete / planned | Acceptance all-pass | Mean wall (s) | Failed attempts | Estimated value, all attempts | Billed spend, all attempts |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const treatment of store.manifest.treatments) {
    const runs = [...completed.values()].filter((outcome) => outcome.cell.treatment === treatment.id);
    const outcomes = [...settled.values()].filter((outcome) => outcome.cell.treatment === treatment.id);
    const identity = "subject" in treatment && treatment.subject === "claude-code" ? `Claude Code ${treatment.binaryVersion} (${treatment.binarySha256}); ${treatment.model} / ${treatment.effort}${treatment.plugin ? `; Flywheel plugin ${treatment.plugin.revision} (${treatment.plugin.identity})` : ""}` : `Flywheel ${treatment.revision}`;
    lines.push(`| ${treatment.id} | ${identity} | ${runs.length}/${store.manifest.tasks.length * store.manifest.repeats} | ${runs.filter((outcome) => outcome.acceptance?.allPass).length}/${runs.length} | ${average(runs.flatMap((outcome) => "runs" in outcome ? [outcome.runs.reduce((total, run) => total + run.wallMs, 0) / 1000] : outcome.wallMs === null ? [] : [outcome.wallMs / 1000]))} | ${outcomes.filter((outcome) => outcome.status === "failed").length} | ${dollars(outcomes, "estimatedUsd")} | ${dollars(outcomes, "billedUsd")} |`);
  }
  const unresolved = [...attempts.keys()].filter((id) => !settled.has(id));
  lines.push("", `Unsettled attempts: ${unresolved.length}. Their retained artifacts can contain spend not yet included in this table.`, "", "## Execution evidence", "");
  if (store.manifest.version === 1) {
    lines.push("| Treatment | Task | Repeat | Acceptance | Workflow stages | Launches / refused |", "|---|---|---|---|---|---|");
    for (const outcome of completed.values()) {
      if ("runs" in outcome) continue;
      lines.push(`| ${outcome.cell.treatment} | ${outcome.cell.task} | ${outcome.cell.repeat} | ${outcome.acceptance ? `${outcome.acceptance.passed}/${outcome.acceptance.total}` : "unavailable"} | ${outcome.workflow.stages.join(", ")} | ${outcome.workflow.launches}/${outcome.workflow.refusedLaunches} |`);
    }
  } else {
    lines.push("| Treatment | Task | Repeat | Outcome | Acceptance | Requests total / parent | Child sessions | Approvals | Total value / billed | Parent value / billed |", "|---|---|---|---|---|---|---|---|---|---|");
    for (const outcome of settled.values()) {
      if (!("runs" in outcome)) continue;
      const observed = outcome.runs.at(-1)?.evidence;
      const amount = (value: CodingOutcomeRecord["accounting"]["estimatedUsd"]) => value.kind === "observed" ? `$${value.value.toFixed(4)}` : "unavailable";
      lines.push(`| ${outcome.cell.treatment} | ${outcome.cell.task} | ${outcome.cell.repeat} | ${outcome.runs.at(-1)?.outcome ?? "interrupted"} | ${outcome.acceptance ? `${outcome.acceptance.passed}/${outcome.acceptance.total}` : "unavailable"} | ${observed?.kind === "observed" ? `${observed.requestCount}/${observed.parentRequestCount}` : "unavailable"} | ${observed?.kind === "observed" ? observed.childSessionCount : "unavailable"} | ${outcome.approvals} | ${amount(outcome.accounting.estimatedUsd)} / ${amount(outcome.accounting.billedUsd)} | ${amount(outcome.parentAccounting.estimatedUsd)} / ${amount(outcome.parentAccounting.billedUsd)} |`);
    }
    lines.push("");
    for (const outcome of settled.values()) {
      if (!("runs" in outcome)) continue;
      const evidence = outcome.runs.at(-1)?.evidence;
      if (evidence?.kind === "unavailable") lines.push(`Evidence unavailable for ${outcome.cell.treatment}/${outcome.cell.task}/${outcome.cell.repeat}: ${evidence.reason}.`);
    }
  }
  lines.push("", "Acceptance, blinded quality, and workflow expressivity are separate observations. Missing evidence is not a pass. A shorter run is not a speed win if it skipped required work.", "");
  if (store.manifest.version === 2) lines.push(renderCampaignRoleChanges(await campaignRoleComparisons(directory, store.manifest.treatments, [...completed.values()].filter((outcome) => "runs" in outcome))));
  return lines.join("\n");
}
