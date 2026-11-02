import type { AgentDefinition } from "../../../../infra/agent-definition.js";
import type { ProviderRequestOptions } from "../../../../infra/llm/provider-options.js";
import { resolveSubagentRole, childServingSeat, type BriefScope } from "../../../config/role-selection.js";
import type { RoleResolver, ResolvedRoles, ResolvedRole } from "../../../config/roles.js";
import type { AgentOptions } from "../../../agent-runtime/types.js";

interface DispatchModelDependencies {
  parentModel: string;
  parentEffort?: AgentOptions["effort"];
  parentProviderOptions?: ProviderRequestOptions;
  resolveRoles: RoleResolver;
  briefScope?: BriefScope;
}

export type ResolvedDispatchModel = { model?: string; effort?: string; providerOptions?: ProviderRequestOptions };

export function scopedAgentRegistry(
  agentRegistry: ReadonlyMap<string, AgentDefinition>,
  allowedSubagentTypes: ReadonlySet<string> | undefined,
): ReadonlyMap<string, AgentDefinition> {
  if (!allowedSubagentTypes) return agentRegistry;
  const scoped = new Map<string, AgentDefinition>();
  for (const name of allowedSubagentTypes) {
    const agent = agentRegistry.get(name);
    if (agent) scoped.set(name, agent);
  }
  return scoped;
}

/** Resolves clone inheritance or persona role configuration before dispatch. */
export async function resolveDispatchModel(
  agent: AgentDefinition,
  deps: DispatchModelDependencies,
): Promise<ResolvedDispatchModel> {
  if (agent.kind === "general") {
    return {
      model: deps.parentModel,
      effort: typeof deps.parentEffort === "function" ? await deps.parentEffort() : deps.parentEffort,
      providerOptions: deps.parentProviderOptions,
    };
  }
  const roles = await deps.resolveRoles();
  const resolved = resolveSubagentRole(agent.role, deps.briefScope, roles);
  return resolved ?? {};
}

/** Old persona children and explicit child Chat edits use their saved Chat setting.
 * New personas otherwise follow their role instead of a generated dispatch pair. */
export function resolveChildRole(agent: AgentDefinition, roles: ResolvedRoles, briefScope?: BriefScope): ResolvedRole | undefined {
  return childServingSeat(agent.kind === "general" ? "chat" : agent.role, roles, briefScope).selection;
}
