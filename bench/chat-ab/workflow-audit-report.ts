import { existsSync } from "node:fs";
import { join } from "node:path";
import { workflowAuditLedger, type WorkflowAuditOutcome } from "./workflow-audit-store.js";
import { campaignRoleComparisons } from "./campaign-role-evidence.js";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { renderCampaignRoleChanges } from "../../src/orchestration/modules/development/benchmark/campaign-role-changes.js";
import { isAnswerTest } from "./workflow-audit-tests.js";
import { cellPhases } from "./phase-timeline.js";
import { mean } from "./statistics.js";

/** An answer test names no shipped site, so its cell shows no site grade rather than zero sites named. */
const NOT_GRADED = "not graded";
const number = (value: number | null, digits: number) => value === null ? "unavailable" : value.toFixed(digits);

/** Render retained audit grades and all-attempt accounting without model calls. */
export async function renderWorkflowAuditReport(directory: string): Promise<string> {
  const store = await workflowAuditLedger.open(directory);
  const events = await store.load();
  const { completed, attempts, settled } = workflowAuditLedger.validate(store.manifest, events);
  const dollars = (outcomes: readonly WorkflowAuditOutcome[], field: "estimatedUsd" | "billedUsd") => {
    const observed = outcomes.flatMap(({ accounting }) => accounting[field].kind === "observed" ? [accounting[field].value] : []);
    return observed.length === 0 ? "unavailable" : `$${observed.reduce((sum, value) => sum + value, 0).toFixed(4)} (${observed.length}/${outcomes.length} observed)`;
  };
  const lines = [`# ${store.manifest.name}`, "", "| Treatment | Subject | Complete / planned | Sites named | Mean wall (s) | Failed attempts | Estimated value, all attempts | Billed spend, all attempts |", "|---|---|---|---|---|---|---|---|"];
  for (const treatment of store.manifest.treatments) {
    const done = [...completed.values()].filter(({ cell }) => cell.treatment === treatment.id);
    const outcomes = [...settled.values()].filter(({ cell }) => cell.treatment === treatment.id);
    const named = done.flatMap((outcome) => Object.values(outcome.sites ?? {}));
    const sitesNamed = store.manifest.tasks.every(({ id }) => isAnswerTest(id)) ? NOT_GRADED : `${named.filter(Boolean).length}/${named.length}`;
    const wall = done.map((outcome) => outcome.runs.reduce((sum, run) => sum + run.wallMs, 0) / 1000);
    const subject = treatment.subject === "claude-code" ? `Claude Code ${treatment.binaryVersion}` : `Flywheel ${treatment.revision}`;
    lines.push(`| ${treatment.id} | ${subject} | ${done.length}/${store.manifest.tasks.length * store.manifest.repeats} | ${sitesNamed} | ${wall.length ? (wall.reduce((sum, value) => sum + value, 0) / wall.length).toFixed(1) : "unavailable"} | ${outcomes.filter(({ status }) => status === "failed").length} | ${dollars(outcomes, "estimatedUsd")} | ${dollars(outcomes, "billedUsd")} |`);
  }
  lines.push("", `Unsettled attempts: ${attempts.size - settled.size}.`, "", "| Treatment | Test | Repeat | Outcome | Sites named | Approvals |", "|---|---|---|---|---|---|");
  for (const outcome of settled.values()) {
    const sites = Object.values(outcome.sites ?? {});
    const sitesNamed = isAnswerTest(outcome.cell.task) ? NOT_GRADED : outcome.sites ? `${sites.filter(Boolean).length}/${sites.length}` : "unavailable";
    lines.push(`| ${outcome.cell.treatment} | ${outcome.cell.task} | ${outcome.cell.repeat} | ${outcome.runs.at(-1)?.outcome ?? "interrupted"} | ${sitesNamed} | ${outcome.approvals} |`);
  }
  const treatments = store.manifest.treatments;
  const flywheel = treatments.filter(({ subject }) => subject !== "claude-code");
  const claudeCode = treatments.filter(({ subject }) => subject === "claude-code");
  const parity = flywheel.length > 0 && claudeCode.length === 1;
  const pairs = parity ? flywheel.map(arm => [arm.id, claudeCode[0]!.id] as const)
    : treatments.length === 2 ? [[treatments[0]!.id, treatments[1]!.id] as const] : [];
  const comparisons = await Promise.all(pairs.map(async ([a, b]) => {
    const order = [[a, b], [b, a]].find(pair => existsSync(join(directory, `judge-${structuredIdentity(pair)}.jsonl`)));
    const judge = order ? await (await import("./workflow-audit-judge.js")).judgeWorkflowAuditCampaign({
      directory, a: order[0]!, b: order[1]!, authProfile: store.manifest.authProfile, dryRun: true,
    }) : null;
    return { a, b, order, judge };
  }));
  const judgeHeading = parity ? "Flywheel/Claude Code/tie" : pairs[0] ? `${pairs[0][0]}/${pairs[0][1]}/tie` : "wins/ties";
  const means = new Map<string, { wall: (number | null)[]; cost: (number | null)[] }>();
  lines.push("", "## Per-test parity", "",
    "| Test | Treatment | Complete / planned | Mean wall (s) | Mean estimated cost | Sites named | Workflows launched | Mean workflow agents | Judge " + judgeHeading + " |",
    "|---|---|---|---|---|---|---|---|---|");
  for (const task of store.manifest.tasks) {
    for (const treatment of treatments) {
      const comparison = comparisons.find(pair => pair.a === treatment.id) ?? (comparisons.length === 1 ? comparisons[0] : undefined);
      const verdicts = comparison?.judge?.taskVerdicts.filter(({ task: id }) => id === task.id) ?? [];
      const wins = (id: string) => verdicts.filter(({ winner }) => winner === (id === comparison?.order?.[0] ? "a" : "b")).length;
      const tally = comparison?.judge ? `${wins(comparison.a)}/${wins(comparison.b)}/${verdicts.filter(({ winner }) => winner === "tie").length}` : comparison ? "unavailable" : "not applicable";
      const done = [...completed.values()].filter(({ cell }) => cell.task === task.id && cell.treatment === treatment.id);
      const wall = mean(done.map(({ runs }) => runs.reduce((sum, run) => sum + run.wallMs, 0) / 1000));
      const prices = done.flatMap(({ accounting }) => accounting.estimatedUsd.kind === "observed" ? [accounting.estimatedUsd.value] : []);
      const cost = prices.length === done.length ? mean(prices) : null;
      const sites = done.flatMap(outcome => Object.values(outcome.sites ?? {}));
      const sitesNamed = isAnswerTest(task.id) ? NOT_GRADED : sites.length ? `${sites.filter(Boolean).length}/${sites.length}` : "unavailable";
      const agents: number[] = [];
      for (const outcome of done) {
        const phases = await cellPhases(join(directory, attempts.get(outcome.attemptId)!.directory));
        if (phases?.coverage === "complete") agents.push(phases.phases.filter(({ kind }) => kind === "workflow-agent").length);
      }
      const coverage = agents.length === done.length ? "" : ` (${agents.length}/${done.length} cells observed)`;
      const launches = agents.length ? `${agents.filter((count) => count > 0).length}/${agents.length}${coverage}` : "unavailable";
      const agentMean = agents.length ? `${number(mean(agents), 1)}${coverage}` : "unavailable";
      const priceMean = cost === null ? `unavailable${prices.length ? ` (${prices.length}/${done.length} cells priced)` : ""}` : `$${cost.toFixed(4)}`;
      lines.push(`| ${task.id} | ${treatment.id} | ${done.length}/${store.manifest.repeats} | ${number(wall, 1)} | ${priceMean} | ${sitesNamed} | ${launches} | ${agentMean} | ${tally} |`);
      const values = means.get(treatment.id) ?? { wall: [], cost: [] };
      values.wall.push(wall); values.cost.push(cost);
      means.set(treatment.id, values);
    }
  }
  lines.push("", "Completed cells supply these means. Workflows launched counts cells with at least one workflow-agent phase over cells with complete coverage. Mean workflow agents counts those phases per covered cell, including cells with none. Ordinary subagents do not count. Missing request evidence or incomplete descendant discovery is unavailable and excluded from both denominators.", "", "## Parity summary", "");
  if (parity) {
    lines.push("Each test has equal weight. Ratios divide the means of the per-test means; a missing test mean makes the ratio unavailable. Below 1 favors Flywheel.");
  } else lines.push("Flywheel / Claude Code ratios require Flywheel treatments and exactly one Claude Code treatment.");
  for (const { a, b, judge } of comparisons) {
    lines.push("", `### ${a} vs ${b}`, "");
    if (parity) {
      const ratio = (metric: "wall" | "cost") => {
        const values = [a, b].map(id => {
          const observed = means.get(id)![metric];
          return observed.every(value => value !== null) ? mean(observed) : null;
        });
        return values[0] === null || values[1] === null || values[1] === 0 ? "unavailable" : (values[0]! / values[1]!).toFixed(3);
      };
      lines.push(`Flywheel time / Claude Code time: ${ratio("wall")}.`,
        `Flywheel estimated cost / Claude Code estimated cost: ${ratio("cost")}.`);
    }
    if (judge) lines.push(`Judge ${a} wins / ${b} wins / ties: ${judge.wins[a]}/${judge.wins[b]}/${judge.ties}.`,
      `Pending judge pairs: ${judge.pending}. Skipped pairs: ${judge.skipped.length}. Unsettled judge attempts: ${judge.unsettled}.`,
      "Only verdicts matching the current artifacts and judge identity count. Judge replay is offline and makes no model call.");
    else lines.push("Judge ledger: unavailable.");
  }
  lines.push("", "Site naming, blinded quality, and elapsed time are separate observations. Step evidence remains in the execution artifacts.", "");
  lines.push(renderCampaignRoleChanges(await campaignRoleComparisons(directory, store.manifest.treatments, [...completed.values()])));
  return lines.join("\n");
}
