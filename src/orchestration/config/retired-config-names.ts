import { removeSemanticSubtree, renameSemanticTable, quoteTomlKey, rewriteSemanticAssignmentKeys, type SemanticKeyRewrite } from "./config-assignment.js";
import { parseBriefRoleId } from "../../protocol/brief-role-id.js";
import { RETIRED_BRIEFS } from "../../workflows/retired-bindings.js";

/** Retired config names: the role-id spellings that user config, the
 *  `FLYWHEEL_ROLES` table, and stored session role snapshots may carry, and
 *  the one function that maps each to its current id. Every reader of a
 *  configured or stored role id reads it through {@link canonicalRoleId}, so
 *  both spellings select the same seat, and the startup rewrite of the config
 *  file writes the current names (refer to {@link patchRetiredConfigKeys}). */

/** Retired role ids mapped to their current ids. The workflow seats took
 *  their current names on 2026-10-16: `step-worker` and `step-agent` are the
 *  Workflow Agent. Remove those two after 2027-04-30, and the shipper
 *  spelling after 2027-03-18. */
const RETIRED_ROLE_IDS = new Map<string, string>([
  ["step-worker", "workflow-agent"],
  ["step-agent", "workflow-agent"],
  ["skill-review", "learning-review"],
  ["shipper", "ship"],
]);

/** Role ids of the removed summarization compactor. Config and stored session
 *  role snapshots may carry them; every reader drops them without an
 *  unknown-role warning. Remove the conversion after 2027-04-01. */
export const RETIRED_COMPACTION_ROLE_IDS: ReadonlySet<string> = new Set(["compactor", "summarizer"]);

const RETIRED_SEAT_PREFIX = "step.";
const RETIRED_PERSONA_MARKER = ".agent.";

/** The current spelling of a workflow seat that a config or a snapshot from
 *  before 2026-10-16 wrote: `step.<briefId>` is `brief.<briefId>`,
 *  `step.<briefId>.agent.<role>` is `brief.<briefId>.persona.<role>`, and
 *  `step.<briefId>.at.<definitionId>`, with or without `.model` or
 *  `.effort`, is `brief.<briefId>.at.<definitionId>`. Each stored record
 *  key is the old step id, so a record seat keeps its place. Remove after
 *  2027-04-30. */
function currentWorkflowSeat(roleId: string): string | undefined {
  if (!roleId.startsWith(RETIRED_SEAT_PREFIX)) return undefined;
  const scoped = roleId.slice(RETIRED_SEAT_PREFIX.length);
  const marker = scoped.indexOf(RETIRED_PERSONA_MARKER);
  const seat = marker < 0 ? scoped : `${scoped.slice(0, marker)}.persona.${scoped.slice(marker + RETIRED_PERSONA_MARKER.length)}`;
  return `brief.${seat}`;
}

export function canonicalRoleId(roleId: string): string {
  return RETIRED_ROLE_IDS.get(roleId) ?? currentWorkflowSeat(roleId) ?? roleId;
}

/** The workflow that retired a setting's brief, including its persona
 *  and record seats. The loader and the writer keep such a setting for a
 *  workflow file whose brief has the same id. Remove after 2027-04-30. */
export function retiredBriefSeatWorkflow(roleId: string): string | undefined {
  const selector = parseBriefRoleId(canonicalRoleId(roleId));
  return selector === undefined ? undefined : RETIRED_BRIEFS.get(selector.briefId);
}

/** Rewrite the names that releases before 2026-10-16 saved: each role id
 *  that {@link canonicalRoleId} maps, such as `step-agent` and
 *  `step.<brief id>`, in every role table, and `max_steps` of the workflow
 *  section, which is now `max_attempts`. A table that already holds the
 *  current name keeps it and drops the retired one, as the loader reads
 *  it. Every byte outside the renamed keys stays unchanged. Remove after
 *  2027-04-30. */
export function patchRetiredConfigKeys(source: string): string {
  const parsed: unknown = source.length > 0 ? Bun.TOML.parse(source) : {};
  if (!isRecord(parsed)) throw new Error("flywheel.toml must contain a TOML table");
  let next = source;
  const profiles = isRecord(parsed.profiles) ? Object.entries(parsed.profiles) : [];
  const tables = profiles.map(([profileId, profile]) => ({ path: ["profiles", profileId, "roles"], roles: isRecord(profile) ? profile.roles : undefined }));
  for (const { path, roles } of tables) {
    if (!isRecord(roles)) continue;
    const named = new Set(Object.keys(roles));
    for (const roleId of Object.keys(roles)) {
      const current = canonicalRoleId(roleId);
      if (current === roleId) continue;
      next = named.has(current)
        ? removeSemanticSubtree(next, [...path, roleId])
        : renameSemanticTable(next, [...path, roleId], quoteTomlKey(current));
      named.add(current);
    }
  }
  const settings: SemanticKeyRewrite[] = ["workflow", "queue"].flatMap((section) => {
    const table = parsed[section];
    if (!isRecord(table) || !("max_steps" in table)) return [];
    return [{ path: [section, "max_steps"], ...("max_attempts" in table ? {} : { replacement: "max_attempts" }) }];
  });
  return rewriteSemanticAssignmentKeys(next, settings);
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
