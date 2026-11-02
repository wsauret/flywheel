import { scoreAcceptance } from "./acceptance.js";
import { campaignCellKey } from "./campaign-store.js";
import { chatLedger, type ChatOutcome } from "./chat-store.js";
import { compareCampaignRoles } from "./campaign-role-evidence.js";
import { renderCampaignRoleChanges } from "../../src/orchestration/modules/development/benchmark/campaign-role-changes.js";

const amount = (value: ChatOutcome["accounting"]["estimatedUsd"]) => value.kind === "observed" ? `$${value.value.toFixed(4)}` : "unavailable";

/** Read only canonical retained execution and grade evidence. Private-runner observations are unavailable. */
export async function renderChatReport(directory: string): Promise<string> {
  const store = await chatLedger.open(directory);
  const { settled, completed, attempts } = chatLedger.validate(store.manifest, await store.load());
  const lines = [`# ${store.manifest.name}`, "", "| Treatment | Arm | Subject identity | Model / effort | Profile | Complete / planned |", "|---|---|---|---|---|---|"];
  for (const treatment of store.manifest.treatments) {
    const identity = treatment.subject === "claude-code" ? `Claude Code ${treatment.binaryVersion} (${treatment.binarySha256})` : `Flywheel ${treatment.revision}`;
    lines.push(`| ${treatment.id} | ${treatment.arm.id} | ${identity} | ${treatment.model} / ${treatment.effort} | ${treatment.authProfile} | ${[...completed.values()].filter((outcome) => outcome.cell.treatment === treatment.id).length}/${store.manifest.tasks.length * store.manifest.repeats} |`);
  }
  lines.push("", `| Cell | Outcome |${store.manifest.challenge ? " Challenge delivery |" : ""} Acceptance score | Resolved | Diff files | Requests total / parent | Child sessions | Approvals | Value / billed | Parent value / billed |`, `|---|---|${store.manifest.challenge ? "---|" : ""}---|---|---|---|---|---|---|---|`);
  for (const outcome of settled.values()) {
    const grade = outcome.grade ? scoreAcceptance(outcome.grade.acceptance) : null;
    const evidence = outcome.runs.at(-1)?.evidence;
    lines.push(`| ${campaignCellKey(outcome.cell)} | ${outcome.runs.at(-1)?.outcome ?? "interrupted"} |${store.manifest.challenge ? ` ${outcome.challenge?.delivered ?? "none"} |` : ""} ${grade?.score ?? "unavailable"} | ${grade?.resolved ?? "unavailable"} | ${outcome.grade?.diffStats.filesTouched ?? "unavailable"} | ${evidence?.kind === "observed" ? `${evidence.requestCount}/${evidence.parentRequestCount}` : "unavailable"} | ${evidence?.kind === "observed" ? evidence.childSessionCount : "unavailable"} | ${outcome.approvals} | ${amount(outcome.accounting.estimatedUsd)} / ${amount(outcome.accounting.billedUsd)} | ${amount(outcome.parentAccounting.estimatedUsd)} / ${amount(outcome.parentAccounting.billedUsd)} |`);
  }
  lines.push("");
  for (const outcome of settled.values()) {
    const evidence = outcome.runs.at(-1)?.evidence;
    if (evidence?.kind === "unavailable") lines.push(`Evidence unavailable for ${campaignCellKey(outcome.cell)}: ${evidence.reason}.`);
  }
  if (store.manifest.treatments.length === 2) {
    const [a, b] = store.manifest.treatments;
    lines.push("", `## Paired acceptance: ${a!.id} / ${b!.id}`, "", "| Task | Repeat | A | B | B minus A |", "|---|---|---|---|---|");
    for (const task of store.manifest.tasks) {
      for (let repeat = 0; repeat < store.manifest.repeats; repeat++) {
        const grades = [a!, b!].map((treatment) => completed.get(campaignCellKey({ treatment: treatment.id, task: task.id, repeat }))?.grade);
        const scores = grades.map((grade) => grade ? scoreAcceptance(grade.acceptance).score : null);
        lines.push(`| ${task.id} | ${repeat} | ${scores[0] ?? "unavailable"} | ${scores[1] ?? "unavailable"} | ${scores[0] !== null && scores[1] !== null ? scores[1]! - scores[0]! : "unavailable"} |`);
      }
    }
    const comparisons = await Promise.all([...completed.values()].filter(({ cell }) => cell.treatment === b!.id).flatMap((candidate) => {
      const baseline = completed.get(campaignCellKey({ ...candidate.cell, treatment: a!.id }));
      return baseline ? [compareCampaignRoles(
        { directory, outcome: baseline },
        { directory, outcome: candidate },
      )] : [];
    }));
    lines.push(renderCampaignRoleChanges(comparisons));
  }
  lines.push("", `Unsettled attempts: ${[...attempts.keys()].filter((id) => !settled.has(id)).length}. All settled attempts retain their accounting, including failures.`, "", "Private-runner approval replies, dispatch logs, cost caps, dropped steps, child descriptions, and tool lists are unavailable. Acceptance scores and blinded quality are separate observations.", "");
  return lines.join("\n");
}
