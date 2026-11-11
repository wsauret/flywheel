import { familyRole } from "../../infra/agent-definition.js";
import { parseBriefRoleId } from "../../protocol/brief-role-id.js";
import { canonicalRoleId, RETIRED_COMPACTION_ROLE_IDS } from "./retired-config-names.js";
import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js";
import type { Effort } from "../../infra/workflow-types.js";
import { discoverAgentRoles } from "../../workflows/agents/agent-roles.js";
import type { ModelTier } from "../../protocol/model-assignment-protocol-types.js";
import { roleModelDefault } from "./role-model-defaults.js";
import type { ProviderConnectionCapture } from "../agent-runtime/factory.js";
import type { RoleSettingEntry } from "../session/schemas.js";

export type RoleId = string;
export const LEARNING_REVIEW_ROLE_ID: RoleId = "learning-review";
export const TITLE_GENERATION_ROLE_ID: RoleId = "title-generation";
export const SUBAGENT_SUMMARY_ROLE_ID: RoleId = "subagent-summary";
const BENCHMARK_JUDGE_ROLE_ID: RoleId = "benchmark-judge";

type RoleGroupId = "core" | "agents" | "background";

/** Presentation order of the role groups, everywhere roles are listed: the
 *  seat you talk to, the workflow and named agents, then background work.
 *  Clients render this order rather than imposing their own, so the
 *  model surfaces cannot drift apart. */
export const ROLE_GROUP_ORDER: readonly RoleGroupId[] = ["core", "agents", "background"];

export interface RoleMetadata {
  id: RoleId;
  label: string;
  group: RoleGroupId;
  /** Model settings require an enabled module contribution. Config retains the role without one. */
  moduleOwned?: true;
  order: number;
  tier: ModelTier;
  effort: Effort;
  /** One user-facing line the model modal shows for the selected role. */
  description: string;
}

type RoleMetadataRegistry = { readonly [K in string]: RoleMetadata };


export interface ResolvedRole {
  roleId: RoleId;
  model: string;
  effort: string;
  providerOptions?: ProviderRequestOptions;
  /** Authored policy, retained separately from this transient preview. */
  setting?: RoleSettingEntry & { readonly fixedEffort?: string };
  settingScope?: "session" | "profile";
}

export type ResolvedRoles = ReadonlyMap<RoleId, ResolvedRole>;
export type RoleResolver = (capture?: ProviderConnectionCapture) => Promise<ResolvedRoles>;

export function requireRole(roles: ResolvedRoles, id: RoleId): ResolvedRole {
  const role = roles.get(id)
  if (!role) throw new Error(`Resolved role missing: ${id}`)
  return role
}

export const WORKFLOW_AGENT_ROLE_ID: RoleId = "workflow-agent";
export const TOP_LEVEL_ROLE_IDS: readonly RoleId[] = ["chat", WORKFLOW_AGENT_ROLE_ID];

/** The role whose setting and agent type cover `roleId`, in any spelling: its family role. */
export function parentRoleId(roleId: RoleId): RoleId | undefined {
  return familyRole(canonicalRoleId(roleId));
}

export const DEFAULT_ROLES = {
  chat: { id: "chat", label: "Chat", group: "core", order: 0, ...roleModelDefault("chat").tier, description: "Replies to you in chat." },
  [WORKFLOW_AGENT_ROLE_ID]: { id: WORKFLOW_AGENT_ROLE_ID, label: "Workflow", group: "agents", order: 0, ...roleModelDefault(WORKFLOW_AGENT_ROLE_ID).tier, description: "Runs the agents of workflows." },
  reviewer: { id: "reviewer", label: "Reviewer", group: "agents", order: 1, ...roleModelDefault("reviewer").tier, description: "Reviews code and plans as a subagent." },
  "reviewer-quality": { id: "reviewer-quality", label: "Quality", group: "agents", order: 2, ...roleModelDefault("reviewer-quality").tier, description: "Reviews correctness and maintainability." },
  "reviewer-elegance": { id: "reviewer-elegance", label: "Elegance", group: "agents", order: 3, ...roleModelDefault("reviewer-elegance").tier, description: "Reviews structural elegance." },
  "reviewer-design": { id: "reviewer-design", label: "Design", group: "agents", order: 4, ...roleModelDefault("reviewer-design").tier, description: "Reviews user-facing interface work." },
  "reviewer-data-integrity": { id: "reviewer-data-integrity", label: "Data Integrity", group: "agents", order: 5, ...roleModelDefault("reviewer-data-integrity").tier, description: "Reviews durable data behavior." },
  "reviewer-performance": { id: "reviewer-performance", label: "Performance", group: "agents", order: 6, ...roleModelDefault("reviewer-performance").tier, description: "Reviews runtime and resource costs." },
  "reviewer-security": { id: "reviewer-security", label: "Security", group: "agents", order: 7, ...roleModelDefault("reviewer-security").tier, description: "Reviews trust boundaries and exploitability." },
  "reviewer-mechanism": { id: "reviewer-mechanism", label: "Mechanism", group: "agents", order: 8, ...roleModelDefault("reviewer-mechanism").tier, description: "Verifies precise runtime mechanisms." },
  "reviewer-uat": { id: "reviewer-uat", label: "UAT", group: "agents", order: 9, ...roleModelDefault("reviewer-uat").tier, description: "Exercises user-visible behavior." },
  explorer: { id: "explorer", label: "Explorer", group: "agents", order: 10, ...roleModelDefault("explorer").tier, description: "Investigates the codebase without changing it." },
  implementer: { id: "implementer", label: "Implementer", group: "agents", order: 11, ...roleModelDefault("implementer").tier, description: "Implements scoped tasks as a subagent." },
  ship: { id: "ship", label: "Ship", group: "agents", order: 12, ...roleModelDefault("ship").tier, description: "Publishes verified repository changes." },
  advisor: { id: "advisor", label: "Advisor", group: "agents", order: 13, ...roleModelDefault("advisor").tier, description: "Provides a second opinion." },
  [LEARNING_REVIEW_ROLE_ID]: { id: LEARNING_REVIEW_ROLE_ID, label: "Learning Review", group: "background", order: 0, ...roleModelDefault(LEARNING_REVIEW_ROLE_ID).tier, description: "Reviews sessions for lessons to keep." },
  [TITLE_GENERATION_ROLE_ID]: { id: TITLE_GENERATION_ROLE_ID, label: "Title Generation", group: "background", order: 1, ...roleModelDefault(TITLE_GENERATION_ROLE_ID).tier, description: "Generates automatic session titles." },
  [SUBAGENT_SUMMARY_ROLE_ID]: { id: SUBAGENT_SUMMARY_ROLE_ID, label: "Subagent Summary", group: "background", order: 2, ...roleModelDefault(SUBAGENT_SUMMARY_ROLE_ID).tier, description: "Summarizes failed subagent work." },
  [BENCHMARK_JUDGE_ROLE_ID]: { id: BENCHMARK_JUDGE_ROLE_ID, label: "Benchmark Judge", group: "background", moduleOwned: true, order: 3, ...roleModelDefault(BENCHMARK_JUDGE_ROLE_ID).tier, description: "Evaluates benchmark results." },
} as const satisfies RoleMetadataRegistry;

export const AGENT_ROLE_IDS: readonly RoleId[] = Array.from(discoverAgentRoles()).sort((a, b) => {
  const orderA = DEFAULT_ROLES[a]?.order ?? Number.POSITIVE_INFINITY;
  const orderB = DEFAULT_ROLES[b]?.order ?? Number.POSITIVE_INFINITY;
  return orderA - orderB || a.localeCompare(b);
});

export const AUX_ROLE_IDS: readonly RoleId[] = [LEARNING_REVIEW_ROLE_ID, TITLE_GENERATION_ROLE_ID, SUBAGENT_SUMMARY_ROLE_ID, BENCHMARK_JUDGE_ROLE_ID];



export function isKnownRoleId(rawRoleId: RoleId, registeredBriefIds: ReadonlySet<string> = new Set()): boolean {
  const roleId = canonicalRoleId(rawRoleId);
  if (roleId in DEFAULT_ROLES) return true;
  if (AGENT_ROLE_IDS.includes(roleId)) return true;
  if (AUX_ROLE_IDS.includes(roleId)) return true;
  const selector = parseBriefRoleId(roleId);
  if (!selector) return false;
  if (selector.personaRole !== undefined) {
    return selector.personaRole in DEFAULT_ROLES || AGENT_ROLE_IDS.includes(selector.personaRole);
  }
  return registeredBriefIds.size === 0 || registeredBriefIds.has(selector.briefId);
}

/** Classify authored config roles, retaining brief settings even when their definition is absent. */
export function configRoleRetention(rawRoleId: RoleId): "retained" | "retired" | "unknown" {
  const roleId = canonicalRoleId(rawRoleId);
  if (RETIRED_COMPACTION_ROLE_IDS.has(roleId)) return "retired";
  return roleId.startsWith("brief.") || isKnownRoleId(roleId) ? "retained" : "unknown";
}

export function validateRoleIds(roleIds: Iterable<RoleId>, registeredBriefIds: ReadonlySet<string> = new Set()): string[] {
  return Array.from(roleIds).filter((roleId) => !isKnownRoleId(roleId, registeredBriefIds));
}

