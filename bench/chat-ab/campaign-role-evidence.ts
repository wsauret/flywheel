import { Schema } from "effect";
import { campaignCellKey, ResolvedRolesSchema, type CampaignExecutionOutcome, type CampaignRoles, type CampaignTreatmentRecord } from "./campaign-store.js";
import { readAvailableCampaignArtifact } from "./campaign-artifacts.js";
import { RuntimeSessionModelPlanResultSchema } from "../../src/protocol/model-assignment-protocol-schemas.js";
import { codingRedaction } from "./block-judge.js";

type Roles = typeof ResolvedRolesSchema.Type;
type RoleKind = "normal" | "workflow";
type RoleEvidence = { readonly normal: Roles | null; readonly workflow: Roles | null };
interface RoleSide {
  readonly directory: string;
  readonly outcome: CampaignExecutionOutcome;
  readonly pins?: CampaignRoles;
}

/** Collect all invocation labels and durable fallbacks, even when an optional snapshot was lost. */
export async function campaignBlinding(directory: string, treatments: readonly CampaignTreatmentRecord[], outcomes: readonly CampaignExecutionOutcome[], chatModels: readonly string[] = []) {
  const fixed = [...chatModels, ...treatments.flatMap((treatment) => treatment.subject === "claude-code" ? [treatment.model] :
    [...("model" in treatment && typeof treatment.model === "string" ? [treatment.model] : []), ...Object.values(treatment.roles ?? {}).flatMap(({ model }) => model ? [model] : [])])];
  const models = new Set(fixed);
  for (const treatment of treatments) {
    if (treatment.subject !== "claude-code") for (const { model } of Object.values(treatment.resolvedRoles ?? {})) models.add(model);
  }
  for (const outcome of outcomes) for (const run of outcome.runs) {
    for (const model of run.models ?? []) models.add(model);
    for (const artifact of run.artifacts) {
      if (!["roles.json", "workflow-roles.json", "plan.json"].some((name) => artifact.path.endsWith(`/${name}`))) continue;
      const text = await readAvailableCampaignArtifact(directory, artifact);
      if (text === undefined) continue;
      const value: unknown = JSON.parse(text);
      if (artifact.path.endsWith("/plan.json")) {
        const plan = Schema.decodeUnknownSync(RuntimeSessionModelPlanResultSchema, { onExcessProperty: "error" })(value);
        for (const assignment of plan.assignments) models.add(assignment.model);
      } else {
        const roles = Schema.decodeUnknownSync(ResolvedRolesSchema, { onExcessProperty: "error" })(value);
        for (const { model } of Object.values(roles)) models.add(model);
      }
    }
  }
  const redaction = codingRedaction([...models]);
  return { ...redaction, identity: codingRedaction(fixed).identity };
}

/** Decode hash-verified per-cell snapshots. Missing artifacts are unavailable, never empty assignments. */
export async function campaignRoleEvidence(directory: string, outcome: CampaignExecutionOutcome): Promise<RoleEvidence> {
  const read = async (filename: string) => {
    const artifact = outcome.runs.flatMap(({ artifacts }) => artifacts).find(({ path }) => path.endsWith(`/${filename}`));
    const text = artifact ? await readAvailableCampaignArtifact(directory, artifact) : undefined;
    return text === undefined ? null : Schema.decodeUnknownSync(ResolvedRolesSchema, { onExcessProperty: "error" })(JSON.parse(text));
  };
  const [normal, workflow] = await Promise.all([read("roles.json"), read("workflow-roles.json")]);
  return { normal, workflow };
}

const recordsWorkflowRoles = (outcome: CampaignExecutionOutcome) => outcome.runs.some(({ artifacts }) => artifacts.some(({ path }) => path.endsWith("/workflow-roles.json")));

/** Compare every recorded role, including unused roles. Absent role ids mean no assignment in that snapshot.
 *  Workflow roles are compared only when a side recorded a workflow-roles.json snapshot; current cells never do. */
export async function compareCampaignRoles(baseline: RoleSide, candidate: RoleSide) {
  const evidence = await Promise.all([campaignRoleEvidence(baseline.directory, baseline.outcome), campaignRoleEvidence(candidate.directory, candidate.outcome)]);
  const changes: { kind: RoleKind; role: string; before: Roles[string] | null; after: Roles[string] | null }[] = [];
  const unavailable: { side: "baseline" | "candidate"; kind: RoleKind }[] = [];
  for (const kind of ["normal", "workflow"] as const) {
    if (kind === "workflow" && !recordsWorkflowRoles(baseline.outcome) && !recordsWorkflowRoles(candidate.outcome)) continue;
    const before = evidence[0]![kind];
    const after = evidence[1]![kind];
    if (before === null) unavailable.push({ side: "baseline", kind });
    if (after === null) unavailable.push({ side: "candidate", kind });
    if (before === null || after === null) continue;
    for (const role of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
      if (baseline.pins?.[role] || candidate.pins?.[role]) continue;
      const left = before[role] ?? null;
      const right = after[role] ?? null;
      if (left?.model !== right?.model || left?.effort !== right?.effort) changes.push({ kind, role, before: left, after: right });
    }
  }
  return {
    baseline: { directory: baseline.directory, cell: campaignCellKey(baseline.outcome.cell) },
    candidate: { directory: candidate.directory, cell: campaignCellKey(candidate.outcome.cell) },
    changes, unavailable,
  };
}

/** List each completed native pair without admission or judge calls. */
export async function campaignRoleComparisons(directory: string, treatments: readonly CampaignTreatmentRecord[], outcomes: readonly CampaignExecutionOutcome[]) {
  const comparisons: Awaited<ReturnType<typeof compareCampaignRoles>>[] = [];
  for (let index = 0; index < treatments.length; index++) {
    const baseline = treatments[index]!;
    for (const candidate of treatments.slice(index + 1)) {
      for (const left of outcomes.filter(({ cell }) => cell.treatment === baseline.id)) {
        const right = outcomes.find(({ cell }) => cell.treatment === candidate.id && cell.task === left.cell.task && cell.repeat === left.cell.repeat);
        if (!right) continue;
        comparisons.push(await compareCampaignRoles(
          { directory, outcome: left, ...(baseline.subject === "claude-code" ? {} : { pins: baseline.roles }) },
          { directory, outcome: right, ...(candidate.subject === "claude-code" ? {} : { pins: candidate.roles }) },
        ));
      }
    }
  }
  return comparisons;
}

