import type { AgentDefinition } from "../../infra/agent-definition.js";
import { CHECKPOINT_TOOL_NAMES } from "../../infra/agent-assets/session-notes.js";

/** Resolves a definition's `subagentRoles` grant against a registry: the names
 *  of persona agents whose role is granted. The general agent has no role, so
 *  it is never a grantee - nesting cannot recurse through it. Self-grants are
 *  always dropped: a persona granting its own role must not be able to respawn
 *  itself indefinitely.
 *
 *  Dispatch resolves the grant here, and workflow definition identity walks the
 *  same function, so the personas a run can reach and the personas its contract
 *  pins are one set by construction. */
export function grantedSubagentTypes(
  agent: AgentDefinition,
  registry: ReadonlyMap<string, AgentDefinition>,
): ReadonlySet<string> {
  const roles = agent.subagentRoles;
  if (!roles || roles.length === 0) return new Set();
  const granted = new Set<string>();
  for (const [name, candidate] of registry) {
    if (name === agent.name) continue;
    if (candidate.kind === "persona" && roles.includes(candidate.role)) granted.add(name);
  }
  return granted;
}

const ADVISOR_PERSONA = "advisor";

/** The personas an agent of a workflow may dispatch by its record: its
 *  authored `subagents` and the advisor persona. On trial since 2026-11-01,
 *  every agent of a workflow can ask the advisor for a second opinion without
 *  a grant (PI-AGENT-044). An agent that itself runs as the advisor does not
 *  get it, so the advisor dispatches no advisor, as the self-grant rule above
 *  keeps it.
 *
 *  Dispatch and definition identity read this one set, so the personas the
 *  run can reach and the personas its identity pins stay equal. Launch
 *  authority and definition availability read only the authored `subagents`,
 *  so the default never refuses a launch from a chat without the subagent
 *  tool and never makes a workflow require the Subagents module. With that
 *  module off, no agent has the subagent tool to dispatch the default. */
export function workflowAgentSubagents(agent: { readonly subagents: readonly string[]; readonly persona?: string }): readonly string[] {
  return agent.persona === ADVISOR_PERSONA ? agent.subagents : [...agent.subagents, ADVISOR_PERSONA];
}

/** Canonical dispatch tool surface for a persona: its declared tools, the
 *  nested-dispatch pair when any role grant resolves, the child-local
 *  handoff every subagent settles through, and the checkpoint tools every
 *  execution compacts with. Subagent dispatch and benchmark persona runs
 *  share this one derivation. */
export function personaToolNames(
  agent: Extract<AgentDefinition, { kind: "persona" }>,
  registry: ReadonlyMap<string, AgentDefinition>,
): string[] {
  const granted = grantedSubagentTypes(agent, registry);
  return [...new Set([...agent.tools, ...(granted.size > 0 ? ["subagent", "process"] : []), "handoff", ...CHECKPOINT_TOOL_NAMES])];
}

/** Every agent name a dispatch that starts at `roots` can reach, roots
 *  included, sorted. A name with no definition in the registry is retained so
 *  the caller can report it as unresolved; grants are followed only through
 *  definitions that exist. Mutual grants are a cycle, so a name already
 *  admitted is never expanded twice. */
export function reachableAgentNames(
  roots: Iterable<string>,
  registry: ReadonlyMap<string, AgentDefinition>,
): readonly string[] {
  const reached = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || reached.has(name)) continue;
    reached.add(name);
    const agent = registry.get(name);
    if (!agent) continue;
    for (const granted of grantedSubagentTypes(agent, registry)) pending.push(granted);
  }
  return [...reached].sort();
}
