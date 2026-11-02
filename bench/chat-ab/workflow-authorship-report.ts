import { existsSync } from "node:fs";
import { join } from "node:path";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { campaignCellKey } from "./campaign-store.js";
import { workflowAuthorshipLedger, type WorkflowAuthorshipOutcome } from "./workflow-authorship-store.js";
import { mean, median, taskBootstrap95, wilson95 } from "./statistics.js";
import { judgeWorkflowAuthorshipCampaign } from "./workflow-authorship-judge.js";

/** Hidden checks alone decide verified success. A partial answer never changes this rule. */
function verifiedWorkflowSuccess(outcome: WorkflowAuthorshipOutcome): boolean {
  if (outcome.status !== "completed" || !outcome.grade) return false;
  const acceptance = outcome.grade.acceptance;
  return Object.values({ ...acceptance.failToPass, ...acceptance.passToPass }).every((value) => value === "pass");
}

/** No launch breaks only an arm that requires one; an arm that chooses reports it as no workflow. Unknown sources remain unknown. */
export function workflowCompliance(outcome: Pick<WorkflowAuthorshipOutcome, "workflow">, expected: "authored" | "frozen", launch: "chosen" | "required"): "yes" | "no" | "none" | "unavailable" {
  if (outcome.workflow.kind !== "observed") return "unavailable";
  if (outcome.workflow.workflows.length === 0) return launch === "required" ? "no" : "none";
  if (outcome.workflow.workflows.some(({ sourceKind }) => sourceKind !== expected && sourceKind !== "unavailable")) return "no";
  return outcome.workflow.workflows.some(({ sourceKind }) => sourceKind === "unavailable") ? "unavailable" : "yes";
}

/** Fold all attempts into one cell's cost. Losing an attempt's price makes the cell's price unknown. */
function cellCost(attempts: readonly WorkflowAuthorshipOutcome[], field: "estimatedUsd" | "billedUsd") {
  const observed = attempts.map(({ accounting }) => accounting[field]);
  return observed.length && observed.every((value) => value.kind === "observed")
    ? observed.reduce((sum, value) => sum + (value.kind === "observed" ? value.value : 0), 0) : null;
}
function cellWall(attempts: readonly WorkflowAuthorshipOutcome[]) {
  return attempts.every(({ runs }) => runs.length > 0) ? attempts.flatMap(({ runs }) => runs).reduce((sum, run) => sum + run.wallMs, 0) / 1000 : null;
}
const number = (value: number | null, digits = 3) => value === null ? "unavailable" : value.toFixed(digits);
const interval = (values: readonly [number, number] | null) => values ? `[${values.map((value) => value.toFixed(3)).join(", ")}]` : "unavailable";

/** One row per task and arm, with task-cluster bootstrap contrasts. Non-compliance never removes a cell. */
export async function renderWorkflowAuthorshipReport(directory: string): Promise<string> {
  const store = await workflowAuthorshipLedger.open(directory);
  const events = await store.load();
  const { attempts, settled } = workflowAuthorshipLedger.validate(store.manifest, events);
  const latest = new Map<string, WorkflowAuthorshipOutcome>();
  const histories = new Map<string, WorkflowAuthorshipOutcome[]>();
  for (const outcome of settled.values()) {
    const key = campaignCellKey(outcome.cell);
    latest.set(key, outcome);
    if (!histories.has(key)) histories.set(key, []);
    histories.get(key)!.push(outcome);
  }
  const [a, b] = store.manifest.treatments;
  if (!a || store.manifest.treatments.length > 2) throw new Error("Workflow authorship reports require one or two arms");
  const judgeArms = (b ? [[a.id, b.id], [b.id, a.id]] : [])
    .find((pair) => existsSync(join(directory, `judge-${structuredIdentity(pair)}.jsonl`)));
  const judge = judgeArms ? await judgeWorkflowAuthorshipCampaign({
    directory, a: judgeArms[0]!, b: judgeArms[1]!, authProfile: store.manifest.authProfile, dryRun: true,
  }) : null;
  const success: number[] = [];
  const estimatedUsd: number[] = [];
  const wallSeconds: number[] = [];
  const effects = { success, estimatedUsd, wallSeconds };
  const lines = [
    `# ${store.manifest.name}`, "",
    "| Task | Arm | Success k/n [Wilson 95%] | Median cost $ | Median wall s | Cost / success $ | Workflows / agents / repeat rounds | Compliant / non-compliant / no workflow / unknown | Judge W/T/L | Failed attempts | Incomplete / unanswered |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const task of store.manifest.tasks) {
    for (const treatment of store.manifest.treatments) {
      const done = [...latest.values()].filter(({ cell }) => cell.task === task.id && cell.treatment === treatment.id);
      const all = [...settled.values()].filter(({ cell }) => cell.task === task.id && cell.treatment === treatment.id);
      const successes = done.filter(verifiedWorkflowSuccess).length;
      const costs = done.map(({ cell }) => cellCost(histories.get(campaignCellKey(cell))!, "estimatedUsd"));
      const walls = done.map(({ cell }) => cellWall(histories.get(campaignCellKey(cell))!));
      const completeCosts = costs.length > 0 && costs.every((cost) => cost !== null);
      const completeWalls = walls.length > 0 && walls.every((wall) => wall !== null);
      const workflows = all.flatMap(({ workflow }) => workflow.kind === "observed" ? workflow.workflows : []);
      const compliance = done.map((outcome) => workflowCompliance(outcome, treatment.expectedWorkflowSource, treatment.workflowLaunch));
      const verdicts = judge?.taskVerdicts.filter((verdict) => verdict.task === task.id) ?? [];
      const slot = treatment.id === judgeArms?.[0] ? "a" : "b";
      const wins = verdicts.filter(({ winner }) => winner === slot).length;
      const ties = verdicts.filter(({ winner }) => winner === "tie").length;
      const losses = verdicts.filter(({ winner }) => winner !== null && winner !== "tie" && winner !== slot).length;
      lines.push(`| ${task.id} | ${treatment.id} | ${successes}/${done.length} ${interval(wilson95(successes, done.length))} | ${number(completeCosts ? median(costs) : null)} | ${number(completeWalls ? median(walls) : null, 1)} | ${number(completeCosts && successes ? costs.reduce((sum, cost) => sum + cost, 0) / successes : null)} | ${workflows.length}/${workflows.reduce((sum, workflow) => sum + workflow.agents.length, 0)}/${workflows.flatMap(({ repeatRounds }) => repeatRounds).reduce((sum, repeat) => sum + repeat.rounds, 0)} (${all.filter(({ workflow }) => workflow.kind === "observed").length}/${all.length} attempts observed) | ${compliance.filter((value) => value === "yes").length}/${compliance.filter((value) => value === "no").length}/${compliance.filter((value) => value === "none").length}/${compliance.filter((value) => value === "unavailable").length} | ${wins}/${ties}/${losses} | ${all.filter(({ status }) => status === "failed").length} | ${done.filter(({ runs }) => runs.at(-1)?.outcome === "incomplete").length}/${done.filter(({ runs }) => runs.at(-1)?.outcome === "input_required").length} |`);
    }
    if (!b) continue;
    const paired = Array.from({ length: store.manifest.repeats }, (_, repeat) => ({
      a: latest.get(campaignCellKey({ task: task.id, treatment: a.id, repeat })),
      b: latest.get(campaignCellKey({ task: task.id, treatment: b.id, repeat })),
    })).filter((pair): pair is { a: WorkflowAuthorshipOutcome; b: WorkflowAuthorshipOutcome } => pair.a !== undefined && pair.b !== undefined);
    if (!paired.length) continue;
    effects.success.push(mean(paired.map((pair) => Number(verifiedWorkflowSuccess(pair.b)) - Number(verifiedWorkflowSuccess(pair.a))))!);
    for (const metric of ["estimatedUsd", "wallSeconds"] as const) {
      const differences = paired.map((pair) => {
        const values = [pair.a, pair.b].map(({ cell }) => metric === "estimatedUsd"
          ? cellCost(histories.get(campaignCellKey(cell))!, metric) : cellWall(histories.get(campaignCellKey(cell))!));
        return values[0] === null || values[1] === null ? null : values[1]! - values[0]!;
      });
      if (differences.every((value) => value !== null)) effects[metric].push(mean(differences)!);
    }
  }
  if (b) {
    lines.push("", `## Paired task effects: ${b.id} minus ${a.id}`, "", "| Metric | Tasks | Mean paired task difference | Task-bootstrap 95% |", "|---|---|---|---|");
    for (const [metric, differences] of Object.entries(effects)) {
      const estimate = taskBootstrap95(differences);
      lines.push(`| ${metric} | ${estimate?.tasks ?? 0}/${store.manifest.tasks.length} | ${number(estimate?.mean ?? null)} | ${interval(estimate?.interval ?? null)} |`);
    }
    lines.push("", "The bootstrap uses 10,000 fixed-seed resamples of tasks, never trials. Each task effect is the mean difference over paired repeats. Partial pairs and unknown prices are stated, not imputed.");
  }
  lines.push("", "Non-compliant cells stay in every estimate.",
    `Planned repeats per task and arm: ${store.manifest.repeats}. Unsettled attempts: ${attempts.size - settled.size}.`, "",
    "| Arm | Estimated value, all attempts $ | Billed spend, all attempts $ |", "|---|---|---|");
  for (const treatment of store.manifest.treatments) {
    const all = [...settled.values()].filter(({ cell }) => cell.treatment === treatment.id);
    lines.push(`| ${treatment.id} | ${number(cellCost(all, "estimatedUsd"))} | ${number(cellCost(all, "billedUsd"))} |`);
  }
  return lines.join("\n");
}
