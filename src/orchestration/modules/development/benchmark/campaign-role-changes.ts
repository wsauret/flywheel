export interface CampaignRoleComparison {
  readonly baseline: { readonly directory: string; readonly cell: string };
  readonly candidate: { readonly directory: string; readonly cell: string };
  readonly changes: readonly {
    readonly kind: "normal" | "workflow";
    readonly role: string;
    readonly before: { readonly model: string; readonly effort: string } | null;
    readonly after: { readonly model: string; readonly effort: string } | null;
  }[];
  readonly unavailable: readonly { readonly side: "baseline" | "candidate"; readonly kind: "normal" | "workflow" }[];
}

/** Render differences with both cell owners so reports do not pool distinct role assignments. */
export function renderCampaignRoleChanges(comparisons: readonly CampaignRoleComparison[]): string {
  const pair = (value: CampaignRoleComparison["changes"][number]["before"]) => value ? `${value.model} / ${value.effort}` : "not assigned";
  return ["## Role changes", "", ...comparisons.flatMap((comparison) => {
    const owner = (side: "baseline" | "candidate") => `${comparison[side].directory}: ${comparison[side].cell}`;
    return [
      ...comparison.changes.map(({ kind, role, before, after }) => `- ${kind} ${role}: ${pair(before)} (${owner("baseline")}) -> ${pair(after)} (${owner("candidate")}).`),
      ...comparison.unavailable.map(({ side, kind }) => `- Role evidence unavailable: ${kind} (${owner(side)}).`),
      ...(comparison.changes.length === 0 && comparison.unavailable.length === 0 ? [`- No role changes: ${owner("baseline")} / ${owner("candidate")}.`] : []),
    ];
  }), ""].join("\n");
}
